const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKGROUND_TASK_TYPES = new Set([
  'local_agent',
  'local_bash',
  'remote_agent',
  'in_process_teammate',
  'local_workflow',
  'monitor_mcp',
  'dream',
]);

function shouldTrackBackgroundTask(taskType) {
  const normalizedTaskType = String(taskType || '').trim();
  return normalizedTaskType ? BACKGROUND_TASK_TYPES.has(normalizedTaskType) : false;
}

const MAX_SANITIZED_PATH_LENGTH = 200;

function djb2Hash(value) {
  let hash = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return hash;
}

function sanitizeTaskPath(value = '') {
  const text = String(value || '');
  const sanitized = text.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= MAX_SANITIZED_PATH_LENGTH) return sanitized;
  const hash = Math.abs(djb2Hash(text)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_PATH_LENGTH)}-${hash}`;
}

function getClaudeTempDir(env = process.env) {
  const baseTmpDir = env.CLAUDE_CODE_TMPDIR || (process.platform === 'win32' ? os.tmpdir() : '/tmp');
  let resolvedBaseTmpDir = baseTmpDir;
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir);
  } catch {}
  const dirName = process.platform === 'win32' ? 'claude' : `claude-${process.getuid?.() ?? 0}`;
  return path.join(resolvedBaseTmpDir, dirName);
}

function resolveTaskOutputFile({ workspacePath, sessionId, taskId, env } = {}) {
  const workspace = String(workspacePath || '').trim();
  const session = String(sessionId || '').trim();
  const task = String(taskId || '').trim();
  if (!workspace || !session || !task) return '';
  return path.join(
    getClaudeTempDir(env),
    sanitizeTaskPath(workspace),
    session,
    'tasks',
    `${task}.output`,
  );
}

function extractTaskOutputPath(value) {
  const text = String(value || '');
  const xmlMatch = text.match(/<output_file>([^<]+)<\/output_file>/i);
  const lineMatch = text.match(/(?:^|\n)\s*output_file:\s*([^\n]+)/i);
  const candidate = String(xmlMatch?.[1] || lineMatch?.[1] || '').trim();
  return candidate && path.isAbsolute(candidate) ? candidate : '';
}

function extractSessionIdFromTaskOutputPath(outputFile) {
  const file = String(outputFile || '').trim();
  if (!file || !path.isAbsolute(file)) return '';
  const parts = path.normalize(file).split(path.sep).filter(Boolean);
  const tasksIndex = parts.lastIndexOf('tasks');
  if (tasksIndex <= 0) return '';
  const sessionId = String(parts[tasksIndex - 1] || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)
    ? sessionId
    : '';
}

function visitToolCallsReverse(toolCalls, visitor) {
  if (!Array.isArray(toolCalls)) return '';
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    const childResult = visitToolCallsReverse(toolCall?.childToolCalls, visitor);
    if (childResult) return childResult;
    const result = visitor(toolCall);
    if (result) return result;
  }
  return '';
}

function findLatestPersistedTaskSessionId(conversation) {
  const task = findLatestPersistedTaskForContinuation(conversation);
  return extractSessionIdFromTaskOutputPath(task?.outputFile || '');
}

function findLatestPersistedTaskForContinuation(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const result = visitToolCallsReverse(messages[index]?.toolCalls, (toolCall) => {
      const outputFile = String(
        toolCall?.subagent?.output_file
        || toolCall?.output_file
        || extractTaskOutputPath(toolCall?.result)
        || '',
      ).trim();
      const taskId = String(toolCall?.subagent?.task_id || toolCall?.task_id || '').trim();
      if (!outputFile && !taskId) return null;
      return {
        taskId,
        outputFile,
        status: String(toolCall?.subagent?.status || toolCall?.status || '').trim(),
        summary: toolCall?.subagent?.summary,
        description: toolCall?.input?.description || toolCall?.subagent?.description || toolCall?.name || '',
        toolName: toolCall?.name || '',
      };
    });
    if (result) return result;
  }
  return null;
}

function isBareContinuationPrompt(prompt) {
  const normalized = String(prompt || '')
    .trim()
    .replace(/[。.!！\s]+$/g, '')
    .toLowerCase();
  return [
    '继续',
    '继续吧',
    '接着',
    '接着来',
    '继续上次',
    'continue',
    'go on',
    'resume',
  ].includes(normalized);
}

function latestAssistantContent(conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return String(message.content || '');
  }
  return '';
}

function resolveHistoricalContinuationSession(conversation, prompt) {
  if (!isBareContinuationPrompt(prompt)) return null;
  const restoredSessionId = findLatestPersistedTaskSessionId(conversation);
  if (!restoredSessionId) return null;
  const currentSessionId = String(conversation?.backend_session_id || '').trim();
  if (!currentSessionId) {
    return {
      sessionId: restoredSessionId,
      reason: 'missing_backend_session',
    };
  }
  if (currentSessionId === restoredSessionId) return null;

  const assistantText = latestAssistantContent(conversation);
  if (/\[id:NaN\]|不是有效任务 ID|No task found with ID|invalid task id/i.test(assistantText)) {
    return {
      sessionId: restoredSessionId,
      reason: 'invalid_task_resume_session',
    };
  }
  return null;
}

function buildTaskEventPayload({ message, turnId, taskFinal, stringifyToolValue }) {
  const subtype = message?.subtype || 'system';
  const taskId = String(message?.task_id || message?.session_id || turnId);
  const outputFile = String(message?.output_file || message?.outputFile || '').trim();
  const resultText = taskFinal?.text || '';
  const isTaskError = Boolean(
    taskFinal?.isError
    || message?.is_error
    || message?.isError
    || message?.status === 'failed'
    || message?.status === 'error',
  );
  return {
    type: 'task_event',
    subtype,
    task_id: taskId,
    tool_use_id: message?.tool_use_id || undefined,
    description: message?.description || (subtype ? `Kernel ${subtype}` : 'Kernel system event'),
    summary: message?.summary || stringifyToolValue(message),
    result: resultText || undefined,
    output_file: outputFile || taskFinal?.outputFile || undefined,
    is_error: isTaskError || undefined,
    status: message?.status || undefined,
    last_tool_name: message?.last_tool_name || undefined,
    usage: message?.usage || undefined,
    task_type: message?.task_type || undefined,
    workflow_name: message?.workflow_name || undefined,
    workflow_progress: Array.isArray(message?.workflow_progress) ? message.workflow_progress : undefined,
    prompt: message?.prompt || undefined,
  };
}

const TASK_OUTPUT_READ_MAX_BYTES = 2 * 1024 * 1024;
const TASK_OUTPUT_TOOL_RESULT_MAX_LENGTH = 50000;

function readTaskOutputTailUtf8(file, maxBytes = TASK_OUTPUT_READ_MAX_BYTES) {
  const stat = fs.statSync(file);
  if (stat.size <= maxBytes) return fs.readFileSync(file, 'utf8');
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes);
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes);
    const text = buffer.toString('utf8');
    const firstLineEnd = text.indexOf('\n');
    return firstLineEnd >= 0 ? text.slice(firstLineEnd + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
}

function truncateTaskOutputText(value, maxLength = TASK_OUTPUT_TOOL_RESULT_MAX_LENGTH) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function stringifyTaskOutputToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => stringifyTaskOutputToolResult(item))
      .filter(Boolean)
      .join('\n');
  }
  if (!content || typeof content !== 'object') return content == null ? '' : String(content);
  if (typeof content.text === 'string') return content.text;
  if (typeof content.content === 'string') return content.content;
  if (Array.isArray(content.content)) return stringifyTaskOutputToolResult(content.content);
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function scopedTaskToolCallKey(outputFile, toolUseId) {
  return `${String(outputFile || '')}#${String(toolUseId || '').trim()}`;
}

function projectedTaskToolUseId(parentToolUseId, outputFile, originalToolUseId, toolUseIdMap, useRawToolUseIds = false) {
  const normalizedOriginalId = String(originalToolUseId || '').trim() || `tool-${toolUseIdMap.size + 1}`;
  const scopedKey = scopedTaskToolCallKey(outputFile, normalizedOriginalId);
  let projectedId = toolUseIdMap.get(scopedKey);
  if (!projectedId) {
    projectedId = useRawToolUseIds
      ? normalizedOriginalId
      : `${String(parentToolUseId || 'agent')}:${normalizedOriginalId}`;
    toolUseIdMap.set(scopedKey, projectedId);
  }
  return { scopedKey, projectedId };
}

function extractTaskOutputToolPayloads({
  outputFile,
  parentToolUseId,
  seenEventKeys = new Set(),
  toolUseIdMap = new Map(),
  toolNameById = new Map(),
  maxDepth = 4,
  depth = 0,
  visitedFiles = new Set(),
  useRawToolUseIds = false,
} = {}) {
  const file = String(outputFile || '').trim();
  const parentId = String(parentToolUseId || '').trim();
  if (!file || !path.isAbsolute(file) || !parentId) return [];
  if (depth >= maxDepth || visitedFiles.has(file)) return [];
  let raw = '';
  try {
    raw = readTaskOutputTailUtf8(file);
  } catch {
    return [];
  }
  if (!raw.trim()) return [];
  visitedFiles.add(file);

  const payloads = [];
  const lines = raw.split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmed = lines[lineIndex].trim();
    if (!trimmed.startsWith('{')) continue;
    let record = null;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const role = String(record?.message?.role || record?.role || record?.type || '').trim();
    const contentBlocks = Array.isArray(record?.message?.content)
      ? record.message.content
      : (Array.isArray(record?.content) ? record.content : []);
    if (!contentBlocks.length) continue;
    const recordKeyBase = `${file}:${String(record?.uuid || `${role}:${lineIndex}`)}`;

    if (role === 'assistant') {
      let textBefore = '';
      for (let blockIndex = 0; blockIndex < contentBlocks.length; blockIndex += 1) {
        const block = contentBlocks[blockIndex];
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          textBefore += block.text;
          continue;
        }
        if (block.type !== 'tool_use') continue;
        const originalToolUseId = String(block.id || `tool-use-${lineIndex}-${blockIndex}`).trim();
        const { scopedKey, projectedId } = projectedTaskToolUseId(
          parentId,
          file,
          originalToolUseId,
          toolUseIdMap,
          useRawToolUseIds,
        );
        const toolName = String(block.name || '').trim() || 'unknown';
        toolNameById.set(scopedKey, toolName);
        const eventKey = `${recordKeyBase}:tool_use:${originalToolUseId}:${blockIndex}`;
        if (!seenEventKeys.has(eventKey)) {
          seenEventKeys.add(eventKey);
          payloads.push({
            type: 'tool_use_start',
            parent_tool_use_id: parentId,
            tool_use_id: projectedId,
            tool_name: toolName,
            tool_input: block.input && typeof block.input === 'object' && !Array.isArray(block.input) ? block.input : {},
            textBefore: textBefore.trim(),
          });
        }
        textBefore = '';
      }
      continue;
    }

    if (role !== 'user') continue;
    for (let blockIndex = 0; blockIndex < contentBlocks.length; blockIndex += 1) {
      const block = contentBlocks[blockIndex];
      if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
      const originalToolUseId = String(block.tool_use_id || '').trim();
      if (!originalToolUseId) continue;
      const { scopedKey, projectedId } = projectedTaskToolUseId(
        parentId,
        file,
        originalToolUseId,
        toolUseIdMap,
        useRawToolUseIds,
      );
      const toolName = toolNameById.get(scopedKey) || '';
      const resultText = truncateTaskOutputText(stringifyTaskOutputToolResult(block.content));
      const eventKey = `${recordKeyBase}:tool_result:${originalToolUseId}:${blockIndex}`;
      if (!seenEventKeys.has(eventKey)) {
        seenEventKeys.add(eventKey);
        payloads.push({
          type: 'tool_use_done',
          parent_tool_use_id: parentId,
          tool_use_id: projectedId,
          tool_name: toolName || undefined,
          content: resultText || undefined,
          is_error: Boolean(block.is_error),
        });
      }
      const nestedOutputFile = extractTaskOutputPath(resultText);
      if (!nestedOutputFile) continue;
      payloads.push(...extractTaskOutputToolPayloads({
        outputFile: nestedOutputFile,
        parentToolUseId: projectedId,
        seenEventKeys,
        toolUseIdMap,
        toolNameById,
        maxDepth,
        depth: depth + 1,
        visitedFiles,
        useRawToolUseIds,
      }));
    }
  }

  return payloads;
}

function reconcilePreviousRunForNewTurn({ activeRuns, conversationId, debugLog = () => {} }) {
  const previousRun = activeRuns.get(conversationId);
  if (!previousRun) {
    return {
      previousRun: null,
      keptBackgroundRun: false,
      abortedForegroundRun: false,
    };
  }

  debugLog(
    `ipc chat interrupt previous run ${conversationId}: foregroundDone=${previousRun.foregroundDone ? 'true' : 'false'}`,
  );
  if (previousRun.foregroundDone) {
    debugLog(`ipc chat keep background run alive ${conversationId}: run=${previousRun.id}`);
    return {
      previousRun,
      keptBackgroundRun: true,
      abortedForegroundRun: false,
    };
  }

  previousRun.stop?.({ mode: 'abort' });
  activeRuns.delete(conversationId);
  return {
    previousRun,
    keptBackgroundRun: false,
    abortedForegroundRun: true,
  };
}

function selectVisibleRunFinalText({ lastAssistantText, streamedText, lastResultText } = {}) {
  const assistantText = String(lastAssistantText || '').trim();
  if (assistantText) return assistantText;
  const streamed = String(streamedText || '').trim();
  if (streamed) return streamed;
  return String(lastResultText || '').trim();
}

function hasObjectEntries(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null && value !== '';
}

function pruneIncompleteToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const toolCall = toolCalls[index];
    if (!toolCall || typeof toolCall !== 'object') {
      toolCalls.splice(index, 1);
      continue;
    }
    if (Array.isArray(toolCall.childToolCalls)) {
      pruneIncompleteToolCalls(toolCall.childToolCalls);
    }
    const hasChildren = Array.isArray(toolCall.childToolCalls) && toolCall.childToolCalls.length > 0;
    const isIncompleteRunningCall = toolCall.status === 'running'
      && !hasObjectEntries(toolCall.input)
      && !hasValue(toolCall.result)
      && !hasValue(toolCall.subagent)
      && !hasChildren;
    if (isIncompleteRunningCall) {
      toolCalls.splice(index, 1);
    }
  }
  return toolCalls;
}

module.exports = {
  BACKGROUND_TASK_TYPES,
  shouldTrackBackgroundTask,
  buildTaskEventPayload,
  extractTaskOutputPath,
  extractTaskOutputToolPayloads,
  reconcilePreviousRunForNewTurn,
  selectVisibleRunFinalText,
  pruneIncompleteToolCalls,
  getClaudeTempDir,
  sanitizeTaskPath,
  resolveTaskOutputFile,
  extractSessionIdFromTaskOutputPath,
  findLatestPersistedTaskForContinuation,
  findLatestPersistedTaskSessionId,
  isBareContinuationPrompt,
  resolveHistoricalContinuationSession,
};
