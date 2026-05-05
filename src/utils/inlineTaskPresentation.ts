function normalizeInlineText(value: any): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeMultilineText(value: any): string {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}

function firstNonEmptyText(...values: any[]): string {
  for (const value of values) {
    const normalized = normalizeInlineText(value);
    if (normalized) return normalized;
  }
  return '';
}

function firstNonEmptyMultiline(...values: any[]): string {
  for (const value of values) {
    const normalized = normalizeMultilineText(value);
    if (normalized) return normalized;
  }
  return '';
}

function basenameLike(value: string): string {
  const normalized = normalizeInlineText(value);
  if (!normalized) return '';
  return normalized.split(/[/\\]/).filter(Boolean).pop() || normalized;
}

const TASK_TYPE_DISPLAY_NAMES: Record<string, string> = {
  local_agent: 'Agent',
  local_bash: 'Command',
  local_workflow: 'Workflow',
  monitor_mcp: 'Monitor',
  remote_agent: 'Remote agent',
  dream: 'Dream',
  in_process_teammate: 'Teammate',
};

function workflowPhaseLabel(item: Record<string, any>): string {
  if (item?.phaseIndex != null && Number.isFinite(Number(item.phaseIndex))) {
    return `Phase ${Number(item.phaseIndex) + 1}`;
  }
  return firstNonEmptyText(item?.phaseName, item?.phase_name, item?.phase);
}

function inlineTaskTitle(task: any): string {
  const taskType = String(task?.task_type || '').trim();
  switch (taskType) {
    case 'local_workflow':
      return firstNonEmptyText(task?.workflow_name, task?.summary, task?.description, task?.prompt);
    case 'remote_agent':
      return firstNonEmptyText(task?.summary, task?.description, task?.prompt);
    case 'dream':
      return firstNonEmptyText(task?.description, task?.summary, task?.prompt);
    default:
      return firstNonEmptyText(task?.description, task?.summary, task?.prompt);
  }
}

function stripTaskOutputMetadata(text: string): string {
  return normalizeMultilineText(text)
    .replace(/<output_file>[^<]*<\/output_file>/gi, '')
    .replace(/(?:^|\n)\s*output_file:\s*[^\n]+/gi, '')
    .trim();
}

function truncateMultilineText(text: string, maxLength = 2800): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function looksLikeAssistantStarterText(text: string): boolean {
  const normalized = normalizeInlineText(text).toLowerCase();
  if (!normalized || normalized.length > 160) return false;

  const chineseStarter = /^(我先|我会先|先)/.test(normalized)
    && /(再给你|然后给你|再总结|再汇总|稍后给你|随后给你|并行看一下|看一下这个仓库|梳理整体架构|检查当前分支)/.test(normalized);
  const englishStarter = /^(i['’]ll|i will|let me)\b/.test(normalized)
    && /(then|after that|afterwards|and get back to you)/.test(normalized);

  return chineseStarter || englishStarter;
}

function isToolCallError(toolCall: any): boolean {
  const status = normalizeInlineText(toolCall?.status || toolCall?.subagent?.status).toLowerCase();
  return Boolean(toolCall?.subagent?.is_error)
    || status === 'error'
    || status === 'failed';
}

function getToolCallBody(toolCall: any): string {
  const raw = firstNonEmptyMultiline(
    toolCall?.subagent?.summary,
    toolCall?.subagent?.result,
    toolCall?.result,
  );
  return truncateMultilineText(stripTaskOutputMetadata(raw));
}

function getToolCallTitle(toolCall: any): string {
  return getInlineTaskLabel(
    {
      ...(toolCall?.subagent || {}),
      description: firstNonEmptyText(toolCall?.subagent?.description, toolCall?.input?.description),
    },
    'Agent',
  );
}

function compactErrorLine(text: string, maxLength = 220): string {
  const singleLine = normalizeInlineText(text);
  if (!singleLine) return '任务失败';
  if (singleLine.length <= maxLength) return singleLine;
  return `${singleLine.slice(0, maxLength).trimEnd()}...`;
}

export function getInlineTaskTypeLabel(taskType: string, fallback = 'Task'): string {
  const normalized = String(taskType || '').trim();
  return TASK_TYPE_DISPLAY_NAMES[normalized] || fallback;
}

export function getInlineTaskStatusLabel(status: string, isError = false): string {
  const normalized = String(status || '').trim().toLowerCase();
  if (isError || normalized === 'failed' || normalized === 'error') return 'Failed';
  if (normalized === 'completed' || normalized === 'done') return 'Done';
  if (normalized === 'pending') return 'Pending';
  if (normalized === 'running') return 'Running...';
  if (normalized === 'stopped' || normalized === 'canceled' || normalized === 'cancelled') return 'Stopped';
  return normalizeInlineText(status) || 'Done';
}

export function getInlineTaskLabel(task: any, fallbackToolName = 'Task'): string {
  const typeLabel = getInlineTaskTypeLabel(task?.task_type, fallbackToolName);
  const title = inlineTaskTitle(task);
  if (!title) return typeLabel;
  if (title.toLowerCase() === typeLabel.toLowerCase()) return typeLabel;
  return `${typeLabel} ${title}`;
}

export function getInlineWorkflowProgressLines(progress: any): string[] {
  if (!Array.isArray(progress)) return [];
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const item of progress) {
    let text = '';
    if (typeof item === 'string') {
      text = normalizeInlineText(item);
    } else if (item && typeof item === 'object') {
      const phase = workflowPhaseLabel(item);
      const label = firstNonEmptyText(item.label, item.name, item.title, item.agentName, item.description);
      const status = firstNonEmptyText(item.status, item.state, item.result);
      const detail = firstNonEmptyText(item.detail, item.summary, item.message);
      const parts = [phase, label]
        .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index);
      if (status && !parts.includes(status)) parts.push(status);
      if (detail && !parts.includes(detail)) parts.push(detail);
      text = parts.join(' · ');
    }

    if (!text || seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
  }

  return lines.slice(-4);
}

export function getInlineTaskDetail(task: any, fallbackStatus = 'done') {
  const typeLabel = getInlineTaskTypeLabel(task?.task_type);
  const title = inlineTaskTitle(task) || `${typeLabel} progress`;
  return {
    typeLabel,
    title,
    statusLabel: getInlineTaskStatusLabel(task?.status || fallbackStatus, Boolean(task?.is_error)),
    currentToolName: firstNonEmptyText(task?.last_tool_name),
    summary: firstNonEmptyText(task?.summary),
    outputFileName: basenameLike(task?.output_file),
    progressLines: getInlineWorkflowProgressLines(task?.workflow_progress),
  };
}

export function formatInlineTaskEventText(event: any): string {
  return firstNonEmptyText(event?.description, event?.subtype, 'Task event');
}

export function selectVisibleAssistantText(currentText: any, toolCalls: any[]): string {
  const visibleText = normalizeMultilineText(currentText);
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return visibleText;
  if (visibleText && !looksLikeAssistantStarterText(visibleText)) return visibleText;

  const agentCards = toolCalls
    .filter((toolCall: any) => toolCall?.name === 'Agent')
    .map((toolCall: any) => ({
      title: getToolCallTitle(toolCall),
      body: getToolCallBody(toolCall),
      isError: isToolCallError(toolCall),
    }))
    .filter((item: any) => item.body);

  if (agentCards.length === 0) return visibleText;

  const completedCards = agentCards.filter((item: any) => !item.isError);
  if (completedCards.length === 1) {
    return completedCards[0].body;
  }

  if (completedCards.length > 0) {
    const sections: string[] = [];
    for (const card of completedCards) {
      sections.push(`### ${card.title}\n${card.body}`);
    }
    return sections.join('\n\n').trim() || visibleText;
  }

  const failedCards = agentCards.filter((item: any) => item.isError);
  const sections: string[] = [];
  for (const card of failedCards) {
    sections.push(`### ${card.title}\n${card.body}`);
  }

  return sections.join('\n\n').trim() || visibleText;
}
