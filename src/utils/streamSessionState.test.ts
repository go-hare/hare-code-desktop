import { describe, expect, test } from 'bun:test';
import {
  beginStreamSession,
  clearStreamSession,
  consumeForegroundRelease,
  createStreamSessionState,
  isReleasedForegroundStream,
  isStreamSessionActive,
  releaseForegroundStream,
  shouldHandleBackgroundStreamEvent,
} from './streamSessionState';

describe('streamSessionState', () => {
  test('released foreground stream keeps receiving background task events after a new turn starts', () => {
    const state = createStreamSessionState();
    const request1 = beginStreamSession(state, 'conv-1');

    expect(isStreamSessionActive(state, 'conv-1', request1)).toBe(true);
    expect(releaseForegroundStream(state, 'conv-1', request1)).toBe(true);
    expect(isReleasedForegroundStream(state, request1)).toBe(true);
    expect(shouldHandleBackgroundStreamEvent(state, request1, 'task_event')).toBe(true);
    expect(shouldHandleBackgroundStreamEvent(state, request1, 'metadata')).toBe(false);

    const request2 = beginStreamSession(state, 'conv-1');
    expect(request2).toBe(request1 + 1);
    expect(isStreamSessionActive(state, 'conv-1', request2)).toBe(true);
    expect(shouldHandleBackgroundStreamEvent(state, request1, 'task_event')).toBe(true);
    expect(consumeForegroundRelease(state, request1)).toBe(true);
    expect(shouldHandleBackgroundStreamEvent(state, request1, 'task_event')).toBe(false);
  });

  test('clearing current stream removes foreground release marker for that request', () => {
    const state = createStreamSessionState();
    const requestId = beginStreamSession(state, 'conv-2');
    releaseForegroundStream(state, 'conv-2', requestId);

    expect(clearStreamSession(state, 'conv-2', requestId)).toBe(true);
    expect(isStreamSessionActive(state, 'conv-2', requestId)).toBe(false);
    expect(isReleasedForegroundStream(state, requestId)).toBe(false);
  });
});
