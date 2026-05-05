export const INTERNAL_TOOL_NAMES = new Set([
  'EnterPlanMode',
  'ExitPlanMode',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
]);

function hasObjectEntries(value: any) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function hasRuntimeMessageValue(value: any) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null && value !== '';
}

function isOrphanUnknownToolEvent(toolEvent: any) {
  return !String(toolEvent?.parent_tool_use_id || '').trim()
    && !String(toolEvent?.tool_name || '').trim()
    && !hasObjectEntries(toolEvent?.tool_input)
    && !hasRuntimeMessageValue(toolEvent?.content)
    && !hasRuntimeMessageValue(toolEvent?.textBefore);
}

function formatToolResultPreview(result: any, maxLength = 1400) {
  if (result == null || result === '') return '';
  const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function findToolCallById(toolCalls: any[], id: string): any | null {
  if (!id) return null;
  for (const toolCall of toolCalls || []) {
    if (toolCall?.id === id) return toolCall;
    const child = findToolCallById(toolCall?.childToolCalls || [], id);
    if (child) return child;
  }
  return null;
}

function findAssistantMessageIndexByToolCallId(messages: any[], toolUseId: string): number {
  if (!toolUseId) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (findToolCallById(message.toolCalls || [], toolUseId)) return index;
  }
  return -1;
}

function pruneSyntheticAgentChildren(childToolCalls: any[], toolName: string) {
  const name = String(toolName || '').trim();
  if (!name) return;
  const hasRealChild = (childToolCalls || []).some((item: any) => (
    item?.name === name && !String(item?.id || '').startsWith('agent-child:')
  ));
  if (!hasRealChild) return;
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const child = childToolCalls[index];
    if (child?.name === name && String(child?.id || '').startsWith('agent-child:')) {
      childToolCalls.splice(index, 1);
    }
  }
}

function syntheticAgentChildId(taskId: string, toolName: string) {
  return `agent-child:${String(taskId || 'task')}:${String(toolName || 'tool')}`;
}

function inputFromAgentTaskProgress(toolName: string, description: string) {
  const text = String(description || '').trim();
  if (!text) return {};
  if (toolName === 'Read') {
    const match = text.match(/^(?:reading|read)\s+(.+)$/i);
    return { path: match?.[1]?.trim() || text };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') return { command: text };
  if (toolName === 'Grep' || toolName === 'Search' || toolName === 'Glob') return { pattern: text };
  return { description: text };
}

function applyToolEventToList(toolCalls: any[], toolEvent: any, fallbackName?: string) {
  if (toolEvent.type === 'start') {
    let existing = toolCalls.find((item: any) => item.id === toolEvent.tool_use_id);
    if (existing) {
      existing.name = toolEvent.tool_name || existing.name;
      if (toolEvent.tool_input && Object.keys(toolEvent.tool_input).length > 0) existing.input = toolEvent.tool_input;
      if (toolEvent.textBefore) existing.textBefore = toolEvent.textBefore;
    } else {
      if (isOrphanUnknownToolEvent(toolEvent)) return;
      toolCalls.push({
        id: toolEvent.tool_use_id,
        name: toolEvent.tool_name || fallbackName || 'unknown',
        input: toolEvent.tool_input || {},
        status: 'running' as const,
        textBefore: toolEvent.textBefore || '',
      });
    }
    return;
  }

  if (toolEvent.type === 'input') {
    const existing = toolCalls.find((item: any) => item.id === toolEvent.tool_use_id);
    if (!existing) return;
    existing.name = toolEvent.tool_name || existing.name;
    const nextInput = toolEvent.tool_input;
    const hasNextInput = typeof nextInput === 'string'
      ? nextInput.trim().length > 0
      : hasObjectEntries(nextInput);
    if (hasNextInput) existing.input = nextInput;
    return;
  }

  if (toolEvent.type === 'done') {
    let existing = toolCalls.find((item: any) => item.id === toolEvent.tool_use_id);
    if (!existing) {
      if (isOrphanUnknownToolEvent(toolEvent)) return;
      existing = {
        id: toolEvent.tool_use_id,
        name: toolEvent.tool_name || fallbackName || 'unknown',
        input: {},
        status: 'done' as const,
        result: toolEvent.content,
      };
      toolCalls.push(existing);
      return;
    }
    existing.name = toolEvent.tool_name || existing.name;
    existing.status = toolEvent.is_error ? 'error' as const : 'done' as const;
    existing.result = toolEvent.content;
  }
}

function syncSyntheticAgentChildFromTaskEvent(parent: any, data: any, description: string) {
  parent.childToolCalls = parent.childToolCalls || [];
  const lastToolName = String(data?.last_tool_name || parent.subagent?.last_tool_name || '').trim();
  const taskId = String(data?.task_id || parent.subagent?.task_id || parent.id || '').trim();
  if (lastToolName) {
    const hasRealChild = parent.childToolCalls.some((item: any) => (
      item?.name === lastToolName && !String(item?.id || '').startsWith('agent-child:')
    ));
    if (hasRealChild) return;
    const childId = syntheticAgentChildId(taskId, lastToolName);
    let child = parent.childToolCalls.find((item: any) => item.id === childId);
    if (!child) {
      child = {
        id: childId,
        name: lastToolName,
        input: inputFromAgentTaskProgress(lastToolName, description),
        status: data?.subtype === 'task_notification' ? 'done' as const : 'running' as const,
      };
      parent.childToolCalls.push(child);
    }
    child.name = lastToolName;
    if (!hasObjectEntries(child.input)) child.input = inputFromAgentTaskProgress(lastToolName, description);
    child.status = (data?.subtype === 'task_notification' || data?.status === 'completed') ? 'done' as const : 'running' as const;
    if (data?.summary) child.result = formatToolResultPreview(data.summary, 1200);
    return;
  }

  if (data?.subtype === 'task_notification' || data?.status === 'completed') {
    for (const child of parent.childToolCalls) {
      if (child.status === 'running') {
        child.status = 'done';
        if (!child.result && data?.summary) child.result = formatToolResultPreview(data.summary, 1200);
      }
    }
  }
}

export function applyToolEventToMessages(prev: any[], toolEvent: any): any[] {
  const newMsgs = [...prev];
  const parentToolUseId = String(toolEvent.parent_tool_use_id || '').trim();
  const toolUseId = String(toolEvent.tool_use_id || '').trim();
  const targetMessageIndex = parentToolUseId
    ? findAssistantMessageIndexByToolCallId(newMsgs, parentToolUseId)
    : findAssistantMessageIndexByToolCallId(newMsgs, toolUseId);
  const fallbackIndex = newMsgs.length - 1;
  const messageIndex = targetMessageIndex >= 0 ? targetMessageIndex : fallbackIndex;
  const message = newMsgs[messageIndex];
  if (!message || message.role !== 'assistant') return prev;

  const toolCalls = message.toolCalls || [];
  message.toolCalls = toolCalls;
  if (parentToolUseId) {
    const parent = findToolCallById(toolCalls, parentToolUseId);
    if (!parent) return prev;
    parent.childToolCalls = parent.childToolCalls || [];
    applyToolEventToList(parent.childToolCalls, toolEvent, parent.subagent?.last_tool_name);
    pruneSyntheticAgentChildren(parent.childToolCalls, toolEvent.tool_name || parent.subagent?.last_tool_name);
    return newMsgs;
  }

  applyToolEventToList(toolCalls, toolEvent);
  return newMsgs;
}

export function applyTaskEventToMessages(prev: any[], data: any): any[] {
  const parentToolUseId = String(data?.tool_use_id || '').trim();
  if (!parentToolUseId) return prev;

  const newMsgs = [...prev];
  const messageIndex = findAssistantMessageIndexByToolCallId(newMsgs, parentToolUseId);
  if (messageIndex < 0) return prev;
  const message = newMsgs[messageIndex];
  if (!message || message.role !== 'assistant') return prev;

  const toolCalls = message.toolCalls || [];
  message.toolCalls = toolCalls;
  const parent = findToolCallById(toolCalls, parentToolUseId);
  if (!parent) return prev;

  const previous = parent.subagent || {};
  const incomingDescription = String(data.description || '').trim();
  const description = incomingDescription && !incomingDescription.startsWith('Kernel ')
    ? incomingDescription
    : previous.description || incomingDescription;
  const previousEvents = Array.isArray(previous.events) ? previous.events : [];
  const event = {
    subtype: data.subtype || '',
    status: data.status || '',
    description,
    last_tool_name: data.last_tool_name || '',
  };
  const eventKey = `${event.subtype}|${event.status}|${event.last_tool_name}|${event.description}`;
  const lastEvent = previousEvents[previousEvents.length - 1];
  const lastEventKey = lastEvent ? `${lastEvent.subtype || ''}|${lastEvent.status || ''}|${lastEvent.last_tool_name || ''}|${lastEvent.description || ''}` : '';
  parent.subagent = {
    ...previous,
    task_id: data.task_id || previous.task_id,
    description,
    status: data.status || (data.subtype === 'task_notification' ? 'completed' : 'running'),
    last_tool_name: data.last_tool_name || previous.last_tool_name,
    summary: data.summary || previous.summary,
    result: data.result || previous.result,
    output_file: data.output_file || previous.output_file,
    task_type: data.task_type || previous.task_type,
    workflow_name: data.workflow_name || previous.workflow_name,
    workflow_progress: data.workflow_progress || previous.workflow_progress,
    prompt: data.prompt || previous.prompt,
    is_error: data.is_error || previous.is_error,
    usage: data.usage || previous.usage,
    subtype: data.subtype || previous.subtype,
    events: eventKey && eventKey !== lastEventKey
      ? [...previousEvents.slice(-29), event]
      : previousEvents,
  };
  syncSyntheticAgentChildFromTaskEvent(parent, data, description);
  return newMsgs;
}
