import { describe, expect, test } from 'bun:test';
import {
  applyTaskEventToMessages,
  applyToolEventToMessages,
} from './runtimeTaskEventLinking';
import { selectVisibleAssistantText } from './inlineTaskPresentation';

describe('runtimeTaskEventLinking', () => {
  test('applies delayed task event to the original assistant message instead of the last one', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'first assistant',
        toolCalls: [{
          id: 'agent-tool-1',
          name: 'Agent',
          status: 'done',
          childToolCalls: [],
          subagent: {
            task_id: 'task-1',
            description: 'Initial background task',
            status: 'running',
          },
        }],
      },
      { role: 'user', content: 'later question' },
      { role: 'assistant', content: 'later assistant', toolCalls: [] },
    ];

    const next = applyTaskEventToMessages(messages, {
      type: 'task_event',
      subtype: 'task_notification',
      tool_use_id: 'agent-tool-1',
      task_id: 'task-1',
      status: 'completed',
      summary: 'Background task completed',
      result: 'done',
      task_type: 'local_bash',
    });

    expect(next[0].toolCalls[0].subagent.status).toBe('completed');
    expect(next[0].toolCalls[0].subagent.result).toBe('done');
    expect(next[0].toolCalls[0].subagent.summary).toBe('Background task completed');
    expect(next[0].toolCalls[0].subagent.task_type).toBe('local_bash');
    expect(next[2].toolCalls).toEqual([]);
  });

  test('applies nested tool events to the original parent tool call across later turns', () => {
    const messages = [
      {
        role: 'assistant',
        content: 'spawned worker',
        toolCalls: [{
          id: 'agent-tool-1',
          name: 'Agent',
          status: 'done',
          childToolCalls: [],
          subagent: {
            task_id: 'task-1',
            description: 'Agent progress',
            status: 'running',
            last_tool_name: 'Read',
          },
        }],
      },
      { role: 'user', content: 'another prompt' },
      { role: 'assistant', content: 'later assistant', toolCalls: [] },
    ];

    const next = applyToolEventToMessages(messages, {
      type: 'start',
      tool_use_id: 'child-tool-1',
      parent_tool_use_id: 'agent-tool-1',
      tool_name: 'Read',
      tool_input: { path: '/tmp/demo.txt' },
      textBefore: '',
    });

    expect(next[0].toolCalls[0].childToolCalls).toHaveLength(1);
    expect(next[0].toolCalls[0].childToolCalls[0]).toMatchObject({
      id: 'child-tool-1',
      name: 'Read',
      input: { path: '/tmp/demo.txt' },
      status: 'running',
    });
    expect(next[2].toolCalls).toEqual([]);
  });

  test('keeps agent summaries eligible for assistant-text fallback when body is starter copy', () => {
    const assistantText = selectVisibleAssistantText(
      '我先从两个方向并行看一下这个仓库：一边梳理整体架构和主要模块，一边检查当前分支上的改动在做什么。',
      [
        {
          id: 'agent-1',
          name: 'Agent',
          status: 'done',
          childToolCalls: [],
          subagent: {
            task_id: 'task-1',
            description: 'Map repo architecture',
            status: 'completed',
            summary: '已按要求做就地只读分析，结论如下。',
          },
        },
        {
          id: 'compat-1',
          name: 'unknown',
          status: 'done',
          result: [
            {
              type: 'text',
              text: 'Async agent launched successfully.\\nagentId: task-1\\noutput_file: /tmp/task-1.output',
            },
          ],
          childToolCalls: [
            {
              id: 'child-1',
              name: 'Read',
              status: 'done',
              input: { file_path: '/tmp/demo.txt' },
              result: 'demo',
            },
          ],
        },
      ],
    );

    expect(assistantText).toContain('已按要求做就地只读分析，结论如下。');
    expect(assistantText).not.toContain('我先从两个方向并行看一下这个仓库');
  });
});
