import { describe, expect, test } from 'bun:test';
import { createRequire } from 'module';
import { applyTaskEventToMessages } from './runtimeTaskEventLinking';
import {
  beginStreamSession,
  createStreamSessionState,
  releaseForegroundStream,
  shouldHandleBackgroundStreamEvent,
} from './streamSessionState';

const require = createRequire(import.meta.url);
const {
  reconcilePreviousRunForNewTurn,
} = require('../../electron/kernelChatRuntimeHelpers.cjs');

describe('desktop background turn parity', () => {
  test('foreground_done background task survives a new turn and still updates the original message', () => {
    const activeRuns = new Map([
      ['conv-1', {
        id: 'run-1',
        foregroundDone: true,
        stop() {
          throw new Error('foreground_done run must not be aborted');
        },
      }],
    ]);
    const logs: string[] = [];

    const previousTurn = reconcilePreviousRunForNewTurn({
      activeRuns,
      conversationId: 'conv-1',
      debugLog: (line: string) => logs.push(line),
    });
    expect(previousTurn.keptBackgroundRun).toBe(true);
    expect(logs.some((line) => line.includes('keep background run alive'))).toBe(true);

    const streamState = createStreamSessionState();
    const request1 = beginStreamSession(streamState, 'conv-1');
    releaseForegroundStream(streamState, 'conv-1', request1);
    const request2 = beginStreamSession(streamState, 'conv-1');
    expect(request2).toBe(request1 + 1);
    expect(shouldHandleBackgroundStreamEvent(streamState, request1, 'task_event')).toBe(true);

    const messages = [
      {
        role: 'assistant',
        content: '后台任务已启动，请现在发下一条消息。',
        toolCalls: [{
          id: 'tool-agent-1',
          name: 'Agent',
          status: 'done',
          childToolCalls: [],
          subagent: {
            task_id: 'task-1',
            description: 'Background worker',
            status: 'running',
          },
        }],
      },
      { role: 'user', content: '第二条消息' },
      { role: 'assistant', content: 'OK', toolCalls: [] },
    ];

    const next = applyTaskEventToMessages(messages, {
      type: 'task_event',
      subtype: 'task_notification',
      tool_use_id: 'tool-agent-1',
      task_id: 'task-1',
      status: 'completed',
      summary: 'Background task completed',
      result: 'done',
      task_type: 'local_agent',
    });

    expect(next[0].toolCalls[0].subagent.status).toBe('completed');
    expect(next[0].toolCalls[0].subagent.result).toBe('done');
    expect(next[0].toolCalls[0].subagent.summary).toBe('Background task completed');
    expect(next[2].toolCalls).toEqual([]);
  });
});
