const { randomUUID } = require('crypto')
const { EventEmitter } = require('events')

function createDesktopKernelRunController({
  conversation,
  body = {},
  debugLog = () => {},
  nowIso = () => new Date().toISOString(),
  emitKernelChatEvent,
  saveState,
  recentKernelRunStore,
  normalizePermissionDecision,
  normalizePermissionDecisionSource,
  selectVisibleRunFinalText,
  pruneIncompleteToolCalls,
  markRunningToolCallsDone,
  markRunningToolCallsFailed,
  recordPersistedToolPayload,
  recordPersistedTaskEvent,
  resetKernelRuntime,
  isKernelRuntimeTransportError,
  permissionRequestTimeoutMs = 120000,
} = {}) {
  const runId = `run-${randomUUID()}`
  const run = {
    id: runId,
    conversationId: conversation.id,
    buffer: [],
    sequence: 0,
    emitter: new EventEmitter(),
    stop: () => {},
    fullText: '',
    foregroundDone: false,
    assistantMessage: null,
    decidePermission: null,
    pendingPermissions: new Map(),
    resolvePermission: null,
    toolCalls: [],
  }
  const write = (payload) => emitKernelChatEvent(run, payload)
  const clearPendingPermission = (permissionRequestId) => {
    const normalizedRequestId = String(permissionRequestId || '').trim()
    if (!normalizedRequestId) return null
    const entry = run.pendingPermissions.get(normalizedRequestId)
    if (entry?.timeout) clearTimeout(entry.timeout)
    run.pendingPermissions.delete(normalizedRequestId)
    return entry || null
  }
  const closePendingPermissions = (decision, reason, decidedBy = 'host') => {
    Array.from(run.pendingPermissions.values()).forEach((entry) => {
      clearPendingPermission(entry.request.permission_request_id)
      write({
        type: 'permission_resolved',
        conversation_id: conversation.id,
        permission_request_id: entry.request.permission_request_id,
        decision: normalizePermissionDecision(decision),
        decided_by: decidedBy,
        reason: String(reason || '').trim(),
        metadata: entry.request.metadata || null,
      })
    })
  }
  const finalizeRun = (terminalState = 'completed') => {
    recentKernelRunStore.unregisterActiveRun(conversation.id, runId)
    recentKernelRunStore.rememberKernelRunForReplay(run, terminalState)
  }
  const schedulePermissionTimeout = (requestPayload) => setTimeout(() => {
    void run.resolvePermission?.({
      permissionRequestId: requestPayload.permission_request_id,
      decision: 'abort',
      reason: 'Desktop permission request timed out.',
      decidedBy: 'host',
    }).catch((error) => {
      debugLog(`permission timeout resolve failed for ${requestPayload.permission_request_id}: ${error?.message || error}`)
    })
  }, Math.max(1000, Number(requestPayload.timeout_ms || 0) || permissionRequestTimeoutMs))
  recentKernelRunStore.registerActiveRun(conversation.id, run)

  const buildAssistantMessage = (fullText, options = {}) => ({
    id: `msg-${randomUUID()}`,
    role: 'assistant',
    content: fullText || run.fullText || (options.allowEmpty ? '' : '[模型未返回文本]'),
    created_at: nowIso(),
    attachments: [],
    toolCalls: run.toolCalls || [],
  })
  const persistAssistantMessage = (fullText, options = {}) => {
    if (run.assistantMessage) {
      run.assistantMessage.content = fullText
        || run.fullText
        || run.assistantMessage.content
        || (options.allowEmpty ? '' : '[模型未返回文本]')
      run.assistantMessage.toolCalls = run.toolCalls || []
      conversation.updated_at = nowIso()
      saveState()
      return run.assistantMessage
    }
    const assistantMessage = buildAssistantMessage(fullText, options)
    run.assistantMessage = assistantMessage
    conversation.messages.push(assistantMessage)
    conversation.updated_at = nowIso()
    saveState()
    return assistantMessage
  }
  let livePersistTimer = null
  const clearLivePersistTimer = () => {
    if (!livePersistTimer) return
    clearTimeout(livePersistTimer)
    livePersistTimer = null
  }
  const persistLiveAssistantMessage = () => {
    if (livePersistTimer) return
    livePersistTimer = setTimeout(() => {
      livePersistTimer = null
      persistAssistantMessage('', { allowEmpty: true })
    }, 250)
    livePersistTimer.unref?.()
  }
  const ensureFinalTextVisible = (fullText) => {
    const text = String(fullText || '').trim()
    if (!text) return ''
    const current = String(run.fullText || '').trim()
    if (!current) {
      run.fullText = text
      write({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
    } else if (current !== text) {
      write({ type: 'final_text', text })
    }
    return text
  }
  const emitVisibleText = (text) => {
    if (!text) return
    run.fullText += text
    write({ type: 'content_block_delta', delta: { type: 'text_delta', text } })
    persistLiveAssistantMessage()
  }
  const flushLiveAssistantMessage = () => {
    clearLivePersistTimer()
    persistAssistantMessage('', { allowEmpty: true })
  }
  flushLiveAssistantMessage()

  const finishRun = (fullText) => {
    clearLivePersistTimer()
    closePendingPermissions('abort', 'Turn finished before permission request was resolved.')
    pruneIncompleteToolCalls(run.toolCalls)
    markRunningToolCallsDone(run.toolCalls)
    const finalText = ensureFinalTextVisible(fullText) || fullText || run.fullText || ''
    persistAssistantMessage(finalText)
    conversation.backend_started = false
    conversation.updated_at = nowIso()
    saveState()
    write({ type: 'message_stop', text: finalText || run.fullText || '' })
    write('[DONE]')
    finalizeRun('completed')
  }
  const finishForegroundRun = (fullText) => {
    if (run.foregroundDone) return
    run.foregroundDone = true
    clearLivePersistTimer()
    const finalText = ensureFinalTextVisible(fullText) || fullText || run.fullText || ''
    persistAssistantMessage(finalText)
    write({
      type: 'foreground_done',
      conversation_id: conversation.id,
      text: finalText || run.fullText || '',
    })
  }
  const failRun = (error) => {
    clearLivePersistTimer()
    const errorMessage = String(error || 'Request failed')
    closePendingPermissions('abort', 'Run ended before permission request was resolved.')
    markRunningToolCallsFailed(run.toolCalls, errorMessage)
    persistAssistantMessage(`Error: ${errorMessage}`)
    conversation.backend_started = false
    conversation.updated_at = nowIso()
    saveState()
    write({ type: 'error', error: errorMessage })
    write('[DONE]')
    finalizeRun('failed')
  }

  run.resolvePermission = async ({ permissionRequestId, decision, reason = '', decidedBy = 'host', metadata }) => {
    const normalizedRequestId = String(permissionRequestId || '').trim()
    if (!normalizedRequestId) {
      const error = new Error('Permission request id is required')
      error.statusCode = 400
      throw error
    }
    if (typeof run.decidePermission !== 'function') {
      const error = new Error('Permission broker unavailable')
      error.statusCode = 409
      throw error
    }
    const entry = run.pendingPermissions.get(normalizedRequestId) || null
    if (entry?.timeout) {
      clearTimeout(entry.timeout)
    } else {
      debugLog(`resolvePermission proceeding without local pending entry ${conversation.id}: request=${normalizedRequestId}`)
    }
    debugLog(`resolvePermission start ${conversation.id}: request=${normalizedRequestId} decision=${decision}`)
    try {
      await Promise.resolve(run.decidePermission({
        permissionRequestId: normalizedRequestId,
        decision: normalizePermissionDecision(decision),
        reason,
        decidedBy: normalizePermissionDecisionSource(decidedBy),
        metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
      }))
      debugLog(`resolvePermission done ${conversation.id}: request=${normalizedRequestId}`)
    } catch (error) {
      if (entry) {
        entry.timeout = schedulePermissionTimeout(entry.request)
      }
      if (resetKernelRuntime && typeof isKernelRuntimeTransportError === 'function' && isKernelRuntimeTransportError(error)) {
        void resetKernelRuntime('desktop_permission_resolution_failed')
      }
      debugLog(`resolvePermission failed ${conversation.id}: request=${normalizedRequestId} message=${error?.message || error}`)
      throw error
    }
  }

  const startRun = (controller) => {
    run.stop = controller.stop
    run.decidePermission = controller.decidePermission || null
    if (controller.sessionId) conversation.backend_session_id = controller.sessionId
  }
  const forwardPermissionRequest = (payload) => {
    if (!payload?.permission_request_id) return
    clearPendingPermission(payload.permission_request_id)
    run.pendingPermissions.set(payload.permission_request_id, {
      request: payload,
      timeout: schedulePermissionTimeout(payload),
    })
    write({ type: 'permission_request', conversation_id: conversation.id, ...payload })
  }
  const forwardPermissionResolved = (payload) => {
    if (!payload?.permission_request_id) return
    clearPendingPermission(payload.permission_request_id)
    write({ type: 'permission_resolved', conversation_id: conversation.id, ...payload })
  }
  const forwardToolUse = (payload) => {
    if (!payload?.type || !String(payload.type).startsWith('tool_use_')) return
    recordPersistedToolPayload(run.toolCalls, payload)
    persistLiveAssistantMessage()
    write({ conversation_id: conversation.id, ...payload })
  }
  const forwardSystemEvent = (payload) => {
    if (!payload?.type) return
    if (payload.type === 'task_event') {
      recordPersistedTaskEvent(run.toolCalls, payload)
      persistLiveAssistantMessage()
    }
    write({ conversation_id: conversation.id, ...payload })
  }

  return {
    run,
    runId,
    emitVisibleText,
    finishRun,
    finishForegroundRun,
    failRun,
    startRun,
    forwardPermissionRequest,
    forwardPermissionResolved,
    forwardToolUse,
    forwardSystemEvent,
    selectVisibleText: (...args) => selectVisibleRunFinalText(...args),
  }
}

module.exports = {
  createDesktopKernelRunController,
}
