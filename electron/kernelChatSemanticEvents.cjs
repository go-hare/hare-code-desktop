const {
  buildTaskEventPayload,
  shouldTrackBackgroundTask,
} = require('./kernelChatRuntimeHelpers.cjs');

function extractSemanticAssistantText(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (String(payload.kind || '').trim() !== 'assistant_message') return '';
  return typeof payload.text === 'string' ? payload.text : '';
}

function projectSemanticToolProgress({
  payload,
  streamedText = '',
  lastToolTextSnapshot = '',
  normalizeToolInput = (value) => value,
  toolNamesById = new Map(),
  toolUseInputsById = new Map(),
} = {}) {
  if (!payload || typeof payload !== 'object') {
    return { emittedEvent: null, lastToolTextSnapshot };
  }
  const kind = String(payload.kind || '').trim();
  const toolUseId = String(payload.toolUseId || '').trim();
  if (!kind || !toolUseId) {
    return { emittedEvent: null, lastToolTextSnapshot };
  }

  const parentToolUseId = String(payload.parentToolUseId || '').trim();
  const toolName = String(payload.toolName || toolNamesById.get(toolUseId) || '').trim();
  const toolInput = normalizeToolInput(payload.toolInput);
  if (toolName) {
    toolNamesById.set(toolUseId, toolName);
  }

  if (kind === 'tool_use_start') {
    const inputKey = JSON.stringify(toolInput);
    const previousInputKey = toolUseInputsById.get(toolUseId);
    const isFirstEmission = previousInputKey == null;
    if (isFirstEmission || previousInputKey !== inputKey) {
      toolUseInputsById.set(toolUseId, inputKey);
    }

    let textBefore = '';
    let nextLastToolTextSnapshot = lastToolTextSnapshot;
    if (!parentToolUseId && isFirstEmission) {
      textBefore = streamedText.startsWith(lastToolTextSnapshot)
        ? streamedText.slice(lastToolTextSnapshot.length)
        : streamedText;
      nextLastToolTextSnapshot = streamedText;
    }

    return {
      emittedEvent: {
        type: 'tool_use_start',
        tool_use_id: toolUseId,
        parent_tool_use_id: parentToolUseId || undefined,
        tool_name: toolName || undefined,
        tool_input: toolInput,
        textBefore,
      },
      lastToolTextSnapshot: nextLastToolTextSnapshot,
    };
  }

  if (kind === 'tool_use_done') {
    return {
      emittedEvent: {
        type: 'tool_use_done',
        tool_use_id: toolUseId,
        parent_tool_use_id: parentToolUseId || undefined,
        tool_name: toolName || undefined,
        content: payload.content,
        is_error: payload.isError === true,
      },
      lastToolTextSnapshot,
    };
  }

  return { emittedEvent: null, lastToolTextSnapshot };
}

function projectSemanticTaskNotification({
  payload,
  turnId,
  taskFinal,
  stringifyToolValue,
} = {}) {
  if (!payload || typeof payload !== 'object') return null;
  const taskId = String(payload.taskId || '').trim();
  if (!taskId) return null;
  const outputFile = String(payload.outputFile || '').trim();
  const status = String(payload.status || '').trim();
  const isTaskError = status === 'failed' || status === 'stopped';
  const summary = String(payload.summary || '').trim();
  const resultText = String(taskFinal?.text || '');

  return {
    taskId,
    outputFile,
    isTaskError,
    summary,
    resultText,
    taskEventPayload: buildTaskEventPayload({
      message: {
        subtype: 'task_notification',
        task_id: taskId,
        tool_use_id: payload.toolUseId,
        output_file: outputFile,
        summary,
        status: isTaskError ? 'failed' : 'completed',
        usage: payload.usage,
      },
      turnId,
      taskFinal,
      stringifyToolValue,
    }),
  };
}

function projectSemanticCoordinatorLifecycle(eventType, payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const taskId = String(payload.taskId || '').trim();
  if (!taskId) return null;
  const taskType = String(payload.taskType || '').trim();
  const shouldTrackTask = !taskType || shouldTrackBackgroundTask(taskType);
  if (eventType === 'handoff.started') {
    return {
      phase: 'started',
      taskId,
      taskType,
      shouldTrackTask,
      taskEventPayload: {
        type: 'task_event',
        subtype: 'task_started',
        task_id: taskId,
        tool_use_id: String(payload.toolUseId || '').trim() || undefined,
        description: String(payload.description || '').trim() || 'Kernel task started',
        status: 'running',
        task_type: taskType || undefined,
      },
    };
  }
  if (eventType !== 'handoff.completed' && eventType !== 'handoff.failed') {
    return null;
  }

  const status = String(payload.status || '').trim()
    || (eventType === 'handoff.completed' ? 'completed' : 'failed');
  const summary = String(payload.summary || payload.reason || '').trim();
  const isTaskError = eventType === 'handoff.failed' || status === 'failed' || status === 'stopped';
  return {
    phase: 'terminal',
    taskId,
    taskType,
    shouldTrackTask,
    status,
    summary,
    isTaskError,
    toolUseId: String(payload.toolUseId || '').trim() || undefined,
  };
}

module.exports = {
  extractSemanticAssistantText,
  projectSemanticCoordinatorLifecycle,
  projectSemanticTaskNotification,
  projectSemanticToolProgress,
};
