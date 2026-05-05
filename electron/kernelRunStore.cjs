const {
  reconcilePreviousRunForNewTurn,
} = require('./kernelChatRuntimeHelpers.cjs')

function createRecentKernelRunStore({ ttlMs = 120000 } = {}) {
  const recentKernelRuns = new Map()
  const activeRuns = new Map()

  function isForegroundRunActive(run) {
    return Boolean(run && !run.foregroundDone)
  }

  function registerActiveRun(conversationId, run) {
    activeRuns.set(conversationId, run)
  }

  function unregisterActiveRun(conversationId, runId) {
    if (activeRuns.get(conversationId)?.id === runId) {
      activeRuns.delete(conversationId)
    }
  }

  function deleteActiveRun(conversationId) {
    activeRuns.delete(conversationId)
  }

  function getActiveRun(conversationId) {
    return activeRuns.get(conversationId) || null
  }

  function hasActiveRun(conversationId) {
    return activeRuns.has(conversationId)
  }

  function sizeActiveRuns() {
    return activeRuns.size
  }

  function prepareForNewTurn({ conversationId, debugLog = () => {} } = {}) {
    return reconcilePreviousRunForNewTurn({
      activeRuns,
      conversationId,
      debugLog,
    })
  }

  function rememberKernelRunForReplay(run, terminalState = 'completed') {
    if (!run?.id || !run?.conversationId) return
    const previous = recentKernelRuns.get(run.id)
    if (previous?.timer) clearTimeout(previous.timer)
    const snapshot = {
      id: run.id,
      conversationId: run.conversationId,
      terminalState,
      foregroundDone: Boolean(run.foregroundDone),
      buffer: Array.isArray(run.buffer) ? run.buffer.slice() : [],
      updatedAt: Date.now(),
      timer: null,
    }
    snapshot.timer = setTimeout(() => {
      recentKernelRuns.delete(run.id)
    }, ttlMs)
    snapshot.timer.unref?.()
    recentKernelRuns.set(run.id, snapshot)
  }

  function getRecentKernelRunSnapshot(conversationId, runId) {
    if (runId) {
      const snapshot = recentKernelRuns.get(runId)
      return snapshot?.conversationId === conversationId ? snapshot : null
    }
    let latest = null
    for (const snapshot of recentKernelRuns.values()) {
      if (snapshot.conversationId !== conversationId) continue
      if (!latest || snapshot.updatedAt > latest.updatedAt) latest = snapshot
    }
    return latest
  }

  function forgetRecentKernelRuns(conversationId) {
    for (const [runId, snapshot] of recentKernelRuns.entries()) {
      if (snapshot.conversationId !== conversationId) continue
      if (snapshot.timer) clearTimeout(snapshot.timer)
      recentKernelRuns.delete(runId)
    }
  }

  function kernelRunStatus(conversationId) {
    const run = getActiveRun(conversationId)
    return {
      active: Boolean(run),
      foregroundActive: isForegroundRunActive(run),
      eventCount: run?.buffer.length || 0,
      runId: run?.id || null,
      text: run?.fullText || run?.assistantMessage?.content || '',
      toolCalls: run?.toolCalls || [],
      assistantMessageId: run?.assistantMessage?.id || null,
    }
  }

  function replayKernelRun(conversationId, runId) {
    const run = getActiveRun(conversationId)
    if (run && (!runId || run.id === runId)) {
      return {
        ...kernelRunStatus(conversationId),
        events: run.buffer.slice(),
      }
    }
    const snapshot = getRecentKernelRunSnapshot(conversationId, runId)
    if (snapshot) {
      return {
        active: false,
        foregroundActive: false,
        eventCount: snapshot.buffer.length,
        runId: snapshot.id,
        terminalState: snapshot.terminalState,
        events: snapshot.buffer.slice(),
      }
    }
    const error = new Error('No active run for this conversation')
    error.statusCode = 404
    throw error
  }

  function stopKernelRun(conversationId, options = {}) {
    const run = getActiveRun(conversationId)
    run?.stop?.(options)
    return { ok: true }
  }

  async function resolvePermission(conversationId, permissionRequestId, body = {}) {
    const run = getActiveRun(conversationId)
    if (!run) {
      const error = new Error('No active run for this conversation')
      error.statusCode = 404
      throw error
    }
    if (typeof run.resolvePermission !== 'function') {
      const error = new Error('Permission broker unavailable')
      error.statusCode = 409
      throw error
    }
    await run.resolvePermission({
      permissionRequestId,
      decision: body?.decision,
      reason: body?.reason,
      metadata: body?.metadata,
    })
    return { ok: true }
  }

  async function answerQuestion(conversationId, body = {}) {
    const run = getActiveRun(conversationId)
    if (!run) {
      const error = new Error('No active run for this conversation')
      error.statusCode = 404
      throw error
    }
    const permissionRequestId = String(
      body?.request_id || body?.permission_request_id || '',
    ).trim()
    if (!permissionRequestId) {
      const error = new Error('AskUserQuestion request id is required')
      error.statusCode = 400
      throw error
    }
    const entry = run.pendingPermissions.get(permissionRequestId) || null
    if (!entry?.request) {
      const error = new Error('AskUserQuestion request is no longer pending')
      error.statusCode = 409
      throw error
    }
    if (String(entry.request.tool_name || '').trim() !== 'AskUserQuestion') {
      const error = new Error('Pending request is not an AskUserQuestion prompt')
      error.statusCode = 409
      throw error
    }

    const answers =
      body?.answers && typeof body.answers === 'object' ? body.answers : {}
    const annotations =
      body?.annotations && typeof body.annotations === 'object'
        ? body.annotations
        : undefined
    const toolUseID = String(
      body?.tool_use_id
        || entry.request.tool_use_id
        || entry.request.metadata?.toolUseID
        || '',
    ).trim()
    const updatedInput = {
      questions: Array.isArray(entry.request.arguments_preview?.questions)
        ? entry.request.arguments_preview.questions
        : [],
      answers,
      ...(annotations ? { annotations } : {}),
    }

    await run.resolvePermission({
      permissionRequestId,
      decision: 'allow_once',
      reason: 'Answered AskUserQuestion from desktop host.',
      decidedBy: 'host',
      metadata: {
        permissionToolOutput: {
          behavior: 'allow',
          updatedInput,
          ...(toolUseID ? { toolUseID } : {}),
          decisionClassification: 'user_temporary',
        },
      },
    })

    return { ok: true }
  }

  return {
    answerQuestion,
    deleteActiveRun,
    getRecentKernelRunSnapshot,
    forgetRecentKernelRuns,
    getActiveRun,
    hasActiveRun,
    kernelRunStatus,
    prepareForNewTurn,
    resolvePermission,
    registerActiveRun,
    rememberKernelRunForReplay,
    replayKernelRun,
    sizeActiveRuns,
    stopKernelRun,
    unregisterActiveRun,
  }
}

module.exports = {
  createRecentKernelRunStore,
}
