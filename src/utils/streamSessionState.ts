export type StreamSessionState = {
  conversationId: string | null;
  requestId: number;
  releasedForegroundIds: Set<number>;
};

export function createStreamSessionState(): StreamSessionState {
  return {
    conversationId: null,
    requestId: 0,
    releasedForegroundIds: new Set<number>(),
  };
}

export function beginStreamSession(state: StreamSessionState, conversationId: string): number {
  const nextId = state.requestId + 1;
  state.requestId = nextId;
  state.conversationId = conversationId;
  return nextId;
}

export function isStreamSessionActive(
  state: StreamSessionState,
  conversationId: string,
  requestId: number,
): boolean {
  return state.conversationId === conversationId && state.requestId === requestId;
}

export function clearStreamSession(
  state: StreamSessionState,
  conversationId: string,
  requestId: number,
): boolean {
  if (!isStreamSessionActive(state, conversationId, requestId)) return false;
  state.conversationId = null;
  state.releasedForegroundIds.delete(requestId);
  return true;
}

export function releaseForegroundStream(
  state: StreamSessionState,
  conversationId: string,
  requestId: number,
): boolean {
  if (!isStreamSessionActive(state, conversationId, requestId)) return false;
  state.releasedForegroundIds.add(requestId);
  return true;
}

export function isReleasedForegroundStream(
  state: StreamSessionState,
  requestId: number,
): boolean {
  return state.releasedForegroundIds.has(requestId);
}

export function shouldHandleBackgroundStreamEvent(
  state: StreamSessionState,
  requestId: number,
  event?: string,
): boolean {
  if (!isReleasedForegroundStream(state, requestId)) return false;
  return event === 'task_event'
    || event === 'permission_request'
    || event === 'permission_resolved'
    || event === 'control_request_resolved'
    || event === 'ask_user';
}

export function consumeForegroundRelease(
  state: StreamSessionState,
  requestId: number,
): boolean {
  if (!state.releasedForegroundIds.has(requestId)) return false;
  state.releasedForegroundIds.delete(requestId);
  return true;
}

export function abortStreamSession(
  state: StreamSessionState,
  targetConversationId?: string,
): boolean {
  const trackedConversationId = state.conversationId;
  if (!trackedConversationId) return false;
  if (targetConversationId && trackedConversationId !== targetConversationId) return false;
  state.requestId += 1;
  state.conversationId = null;
  state.releasedForegroundIds.delete(state.requestId - 1);
  return true;
}
