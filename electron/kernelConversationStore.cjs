function createKernelConversationStore() {
  const kernelConversations = new Map()

  function clear() {
    kernelConversations.clear()
  }

  function get(conversationId) {
    return kernelConversations.get(conversationId) || null
  }

  function set(conversationId, kernelConversation) {
    kernelConversations.set(conversationId, kernelConversation)
    return kernelConversation
  }

  async function getOrCreateConversation({ conversation, createConversation } = {}) {
    const conversationId = String(conversation?.id || '').trim()
    if (!conversationId) {
      const error = new Error('Conversation id is required')
      error.statusCode = 400
      throw error
    }
    const existing = get(conversationId)
    if (existing) return existing
    const kernelConversation = await createConversation()
    set(conversationId, kernelConversation)
    if (kernelConversation?.sessionId) {
      conversation.backend_session_id = kernelConversation.sessionId
    }
    return kernelConversation
  }

  async function disposeConversation(conversationId, reason = 'desktop_conversation_deleted') {
    const kernelConversation = get(conversationId)
    kernelConversations.delete(conversationId)
    if (!kernelConversation) return
    await kernelConversation.dispose(reason).catch(() => {})
  }

  function dropConversation(conversationId, reason = 'desktop_conversation_reset') {
    const kernelConversation = get(conversationId)
    kernelConversations.delete(conversationId)
    if (!kernelConversation) return
    void kernelConversation.dispose(reason).catch(() => {})
  }

  function dropStaleConversationForSession({
    conversation,
    hasActiveRun = false,
    debugLog = () => {},
    reason = 'desktop_stale_kernel_session',
  } = {}) {
    const conversationId = String(conversation?.id || '').trim()
    const requestedSessionId = String(conversation?.backend_session_id || '').trim()
    if (!conversationId || !requestedSessionId || hasActiveRun) return false
    const existing = get(conversationId)
    if (!existing) return false
    const existingSessionId = String(existing.sessionId || '').trim()
    if (existingSessionId === requestedSessionId) return false
    debugLog(
      `dropping stale kernel conversation ${conversationId}: existingSession=${existingSessionId || ''} requestedSession=${requestedSessionId}`,
    )
    dropConversation(conversationId, reason)
    return true
  }

  return {
    clear,
    disposeConversation,
    dropConversation,
    dropStaleConversationForSession,
    get,
    getOrCreateConversation,
    set,
  }
}

module.exports = {
  createKernelConversationStore,
}
