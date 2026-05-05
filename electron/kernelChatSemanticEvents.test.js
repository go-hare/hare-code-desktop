import { describe, expect, test } from 'bun:test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  extractSemanticAssistantText,
  projectSemanticCoordinatorLifecycle,
  projectSemanticTaskNotification,
  projectSemanticToolProgress,
} = require('./kernelChatSemanticEvents.cjs');

describe('kernelChatSemanticEvents', () => {
  test('extracts assistant text only from semantic assistant_message delta', () => {
    expect(extractSemanticAssistantText({ kind: 'assistant_message', text: 'kernel text' })).toBe('kernel text');
    expect(extractSemanticAssistantText({ kind: 'other', text: 'ignored' })).toBe('');
    expect(extractSemanticAssistantText(null)).toBe('');
  });

  test('projects top-level tool_use_start into desktop tool event and snapshots streamed text', () => {
    const toolNamesById = new Map();
    const toolUseInputsById = new Map();

    const projection = projectSemanticToolProgress({
      payload: {
        kind: 'tool_use_start',
        toolUseId: 'tool-1',
        toolName: 'Read',
        toolInput: { path: '/tmp/demo' },
      },
      streamedText: '前置文本',
      lastToolTextSnapshot: '',
      normalizeToolInput: (value) => value,
      toolNamesById,
      toolUseInputsById,
    });

    expect(projection).toEqual({
      emittedEvent: {
        type: 'tool_use_start',
        tool_use_id: 'tool-1',
        parent_tool_use_id: undefined,
        tool_name: 'Read',
        tool_input: { path: '/tmp/demo' },
        textBefore: '前置文本',
      },
      lastToolTextSnapshot: '前置文本',
    });
    expect(toolNamesById.get('tool-1')).toBe('Read');
    expect(toolUseInputsById.get('tool-1')).toBe(JSON.stringify({ path: '/tmp/demo' }));
  });

  test('projects nested tool_use_done without consuming foreground text snapshot', () => {
    const projection = projectSemanticToolProgress({
      payload: {
        kind: 'tool_use_done',
        toolUseId: 'tool-2',
        parentToolUseId: 'agent-1',
        content: 'done',
        isError: true,
      },
      streamedText: '前置文本',
      lastToolTextSnapshot: '旧文本',
    });

    expect(projection).toEqual({
      emittedEvent: {
        type: 'tool_use_done',
        tool_use_id: 'tool-2',
        parent_tool_use_id: 'agent-1',
        tool_name: undefined,
        content: 'done',
        is_error: true,
      },
      lastToolTextSnapshot: '旧文本',
    });
  });

  test('projects tasks.notification into task_event payload', () => {
    const projection = projectSemanticTaskNotification({
      payload: {
        taskId: 'task-1',
        toolUseId: 'tool-1',
        outputFile: '/tmp/task-1.output',
        summary: 'Background task completed',
        status: 'completed',
        usage: { input_tokens: 1 },
      },
      turnId: 'turn-1',
      taskFinal: {
        text: 'final result',
        outputFile: '/tmp/task-1.output',
        isError: false,
      },
      stringifyToolValue: (value) => JSON.stringify(value),
    });

    expect(projection?.taskId).toBe('task-1');
    expect(projection?.isTaskError).toBe(false);
    expect(projection?.resultText).toBe('final result');
    expect(projection?.taskEventPayload).toMatchObject({
      type: 'task_event',
      subtype: 'task_notification',
      task_id: 'task-1',
      tool_use_id: 'tool-1',
      output_file: '/tmp/task-1.output',
      result: 'final result',
      status: 'completed',
    });
  });

  test('projects handoff.started into task_started payload and tracking hint', () => {
    const projection = projectSemanticCoordinatorLifecycle('handoff.started', {
      taskId: 'task-2',
      taskType: 'local_agent',
      toolUseId: 'tool-2',
      description: 'Run delegated task',
    });

    expect(projection).toEqual({
      phase: 'started',
      taskId: 'task-2',
      taskType: 'local_agent',
      shouldTrackTask: true,
      taskEventPayload: {
        type: 'task_event',
        subtype: 'task_started',
        task_id: 'task-2',
        tool_use_id: 'tool-2',
        description: 'Run delegated task',
        status: 'running',
        task_type: 'local_agent',
      },
    });
  });

  test('projects handoff.completed into terminal tracking metadata', () => {
    const projection = projectSemanticCoordinatorLifecycle('handoff.completed', {
      taskId: 'task-2',
      taskType: 'local_agent',
      toolUseId: 'tool-2',
      summary: 'done',
    });

    expect(projection).toEqual({
      phase: 'terminal',
      taskId: 'task-2',
      taskType: 'local_agent',
      shouldTrackTask: true,
      status: 'completed',
      summary: 'done',
      isTaskError: false,
      toolUseId: 'tool-2',
    });
  });

  test('projects handoff.failed into terminal error metadata', () => {
    const projection = projectSemanticCoordinatorLifecycle('handoff.failed', {
      taskId: 'task-3',
      taskType: 'local_agent',
      status: 'stopped',
      reason: 'stopped',
    });

    expect(projection).toEqual({
      phase: 'terminal',
      taskId: 'task-3',
      taskType: 'local_agent',
      shouldTrackTask: true,
      status: 'stopped',
      summary: 'stopped',
      isTaskError: true,
      toolUseId: undefined,
    });
    expect(projectSemanticCoordinatorLifecycle('team.shutdown_completed', { taskId: 'task-3' })).toBeNull();
  });
});
