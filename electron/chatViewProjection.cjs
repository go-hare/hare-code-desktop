function hasObjectEntries(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0,
  )
}

function hasRuntimeMessageValue(value) {
  if (Array.isArray(value)) return value.length > 0
  if (value && typeof value === 'object') return Object.keys(value).length > 0
  return value != null && value !== ''
}

function extractTextContent(content) {
  if (!content) return ''
  if (typeof content !== 'string') return String(content)
  if (content.startsWith('[')) {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        return parsed
          .filter((block) => block && block.type === 'text' && block.text)
          .map((block) => block.text)
          .join('\n')
      }
    } catch {}
  }
  return content
}

function normalizeInlineText(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeMultilineText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim()
}

function firstNonEmptyText(...values) {
  for (const value of values) {
    const normalized = normalizeInlineText(value)
    if (normalized) return normalized
  }
  return ''
}

function firstNonEmptyMultiline(...values) {
  for (const value of values) {
    const normalized = normalizeMultilineText(value)
    if (normalized) return normalized
  }
  return ''
}

function inlineTaskTitle(task) {
  return firstNonEmptyText(
    task?.description,
    task?.summary,
    task?.prompt,
    task?.workflow_name,
  )
}

function getInlineTaskLabel(task, fallbackToolName = 'Task') {
  const typeLabel = String(task?.task_type || '').trim() === 'local_workflow'
    ? 'Workflow'
    : String(task?.task_type || '').trim() === 'in_process_teammate'
      ? 'Teammate'
      : fallbackToolName
  const title = inlineTaskTitle(task)
  if (!title) return typeLabel
  if (title.toLowerCase() === typeLabel.toLowerCase()) return typeLabel
  return `${typeLabel} ${title}`
}

function stripTaskOutputMetadata(text) {
  return normalizeMultilineText(text)
    .replace(/<output_file>[^<]*<\/output_file>/gi, '')
    .replace(/(?:^|\n)\s*output_file:\s*[^\n]+/gi, '')
    .trim()
}

function truncateMultilineText(text, maxLength = 2800) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength).trimEnd()}...`
}

function looksLikeAssistantStarterText(text) {
  const normalized = normalizeInlineText(text).toLowerCase()
  if (!normalized || normalized.length > 160) return false

  const chineseStarter =
    /^(我先|我会先|先)/.test(normalized) &&
    /(再给你|然后给你|再总结|再汇总|稍后给你|随后给你|并行看一下|看一下这个仓库|梳理整体架构|检查当前分支)/.test(
      normalized,
    )
  const englishStarter =
    /^(i['’]ll|i will|let me)\b/.test(normalized) &&
    /(then|after that|afterwards|and get back to you)/.test(normalized)

  return chineseStarter || englishStarter
}

function isToolCallError(toolCall) {
  const status = normalizeInlineText(
    toolCall?.status || toolCall?.subagent?.status,
  ).toLowerCase()
  return Boolean(toolCall?.subagent?.is_error) || status === 'error' || status === 'failed'
}

function getToolCallBody(toolCall) {
  const raw = firstNonEmptyMultiline(
    toolCall?.subagent?.summary,
    toolCall?.subagent?.result,
    toolCall?.result,
  )
  return truncateMultilineText(stripTaskOutputMetadata(raw))
}

function getToolCallTitle(toolCall) {
  return getInlineTaskLabel(
    {
      ...(toolCall?.subagent || {}),
      description: firstNonEmptyText(
        toolCall?.subagent?.description,
        toolCall?.input?.description,
      ),
    },
    'Agent',
  )
}

function compactErrorLine(text, maxLength = 220) {
  const singleLine = normalizeInlineText(text)
  if (!singleLine) return '任务失败'
  if (singleLine.length <= maxLength) return singleLine
  return `${singleLine.slice(0, maxLength).trimEnd()}...`
}

function isUnknownEmptyToolCall(toolCall) {
  const name = String(toolCall?.name || '').trim()
  return (
    (!name || name === 'unknown') &&
    !hasObjectEntries(toolCall?.input) &&
    !hasRuntimeMessageValue(toolCall?.result) &&
    !hasRuntimeMessageValue(toolCall?.textBefore) &&
    !hasRuntimeMessageValue(toolCall?.childToolCalls)
  )
}

function isAnonymousToolCall(toolCall) {
  const name = String(toolCall?.name || '').trim()
  return !name || name === 'unknown'
}

function isAnonymousResultToolCall(toolCall) {
  return (
    isAnonymousToolCall(toolCall) &&
    !hasObjectEntries(toolCall?.input) &&
    hasRuntimeMessageValue(toolCall?.result) &&
    !hasRuntimeMessageValue(toolCall?.childToolCalls) &&
    !hasRuntimeMessageValue(toolCall?.subagent)
  )
}

function shouldHideAnonymousTaskOutput(toolCall) {
  return isAnonymousResultToolCall(toolCall)
}

function isAnonymousCompatTaskContainer(toolCall) {
  if (!isAnonymousToolCall(toolCall)) return false
  if (!Array.isArray(toolCall?.childToolCalls) || toolCall.childToolCalls.length === 0) {
    return false
  }
  const text =
    typeof toolCall?.result === 'string'
      ? toolCall.result
      : Array.isArray(toolCall?.result)
        ? toolCall.result
            .map((item) => (typeof item?.text === 'string' ? item.text : ''))
            .join('\n')
        : ''
  return /Async agent launched successfully|agentId:\s*[a-z0-9_-]+|output_file:/i.test(text)
}

function cloneToolCallTree(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return toolCall
  return {
    ...toolCall,
    childToolCalls: Array.isArray(toolCall.childToolCalls)
      ? toolCall.childToolCalls.map((child) => cloneToolCallTree(child))
      : toolCall.childToolCalls,
  }
}

function extractTaskOutputPathFromToolResult(result) {
  const text =
    typeof result === 'string'
      ? result
      : Array.isArray(result)
        ? result
            .map((item) => (typeof item?.text === 'string' ? item.text : ''))
            .join('\n')
        : ''
  const xmlMatch = text.match(/<output_file>([^<]+)<\/output_file>/i)
  const lineMatch = text.match(/(?:^|\n)\s*output_file:\s*([^\n]+)/i)
  return String(xmlMatch?.[1] || lineMatch?.[1] || '').trim()
}

function extractTaskIdFromToolCall(toolCall) {
  const taskId = String(toolCall?.subagent?.task_id || '').trim()
  if (taskId) return taskId
  const text =
    typeof toolCall?.result === 'string'
      ? toolCall.result
      : Array.isArray(toolCall?.result)
        ? toolCall.result
            .map((item) => (typeof item?.text === 'string' ? item.text : ''))
            .join('\n')
        : ''
  const idMatch = text.match(/agentId:\s*([a-z0-9_-]+)/i)
  return String(idMatch?.[1] || '').trim()
}

function isSyntheticTaskOutputAgent(toolCall) {
  return toolCall?.name === 'Agent' && String(toolCall?.id || '').startsWith('desktop-task:')
}

function rawFallbackChildId(toolCallId) {
  const text = String(toolCallId || '').trim()
  const match = text.match(/(call_[A-Za-z0-9]+)$/)
  return String(match?.[1] || text).trim()
}

function liveAgentMatchesSyntheticTask(liveAgent, syntheticAgent) {
  if (!liveAgent || !syntheticAgent || liveAgent === syntheticAgent) return false
  if (liveAgent?.name !== 'Agent' || isSyntheticTaskOutputAgent(liveAgent)) return false
  const syntheticTaskId = extractTaskIdFromToolCall(syntheticAgent)
  const liveTaskId = extractTaskIdFromToolCall(liveAgent)
  if (syntheticTaskId && liveTaskId && syntheticTaskId === liveTaskId) return true

  const liveChildIds = new Set(
    (liveAgent?.childToolCalls || [])
      .map((child) => String(child?.id || '').trim())
      .filter(Boolean),
  )
  for (const child of syntheticAgent?.childToolCalls || []) {
    const rawId = rawFallbackChildId(child?.id)
    if (rawId && liveChildIds.has(rawId)) return true
  }

  const syntheticOutputFile = String(syntheticAgent?.subagent?.output_file || '').trim()
  const liveOutputFile = extractTaskOutputPathFromToolResult(liveAgent?.result)
  return Boolean(
    syntheticOutputFile && liveOutputFile && syntheticOutputFile === liveOutputFile,
  )
}

function mergeSyntheticTaskOutputIntoLiveAgent(liveAgent, syntheticAgent) {
  if (!liveAgent || !syntheticAgent) return
  if (!hasRuntimeMessageValue(liveAgent.subagent) && hasRuntimeMessageValue(syntheticAgent.subagent)) {
    liveAgent.subagent = syntheticAgent.subagent
  }
  const liveChildren = Array.isArray(liveAgent.childToolCalls) ? liveAgent.childToolCalls : []
  liveAgent.childToolCalls = liveChildren
  for (const fallbackChild of syntheticAgent.childToolCalls || []) {
    const rawId = rawFallbackChildId(fallbackChild?.id)
    let existing = liveChildren.find(
      (child) => String(child?.id || '').trim() === rawId,
    )
    if (!existing) {
      existing = liveChildren.find(
        (child) =>
          String(child?.id || '').trim() ===
          String(fallbackChild?.id || '').trim(),
      )
    }
    if (existing) {
      if (isAnonymousToolCall(existing) && !isAnonymousToolCall(fallbackChild)) {
        existing.name = fallbackChild.name
      }
      if (!hasObjectEntries(existing.input) && hasObjectEntries(fallbackChild.input)) {
        existing.input = fallbackChild.input
      }
      if (
        !hasRuntimeMessageValue(existing.result) &&
        hasRuntimeMessageValue(fallbackChild.result)
      ) {
        existing.result = fallbackChild.result
      }
      if ((!existing.status || existing.status === 'running') && fallbackChild.status) {
        existing.status = fallbackChild.status
      }
      continue
    }
    liveChildren.push({
      ...cloneToolCallTree(fallbackChild),
      id: rawId || fallbackChild.id,
    })
  }
}

function mergeCompatTaskContainerIntoLiveAgent(liveAgent, compatToolCall) {
  if (!liveAgent || !compatToolCall) return
  const liveChildren = Array.isArray(liveAgent.childToolCalls) ? liveAgent.childToolCalls : []
  liveAgent.childToolCalls = liveChildren
  for (const compatChild of compatToolCall.childToolCalls || []) {
    const compatId = String(compatChild?.id || '').trim()
    if (!compatId) continue
    const existing = liveChildren.find(
      (child) => String(child?.id || '').trim() === compatId,
    )
    if (existing) continue
    liveChildren.push(cloneToolCallTree(compatChild))
  }
}

function projectToolCalls(toolCalls) {
  const clonedToolCalls = (toolCalls || []).map((toolCall) =>
    cloneToolCallTree(toolCall),
  )
  const syntheticTaskOutputIds = new Set()
  for (const toolCall of clonedToolCalls) {
    if (!isSyntheticTaskOutputAgent(toolCall)) continue
    const liveAgent = clonedToolCalls.find((candidate) =>
      liveAgentMatchesSyntheticTask(candidate, toolCall),
    )
    if (!liveAgent) continue
    mergeSyntheticTaskOutputIntoLiveAgent(liveAgent, toolCall)
    syntheticTaskOutputIds.add(String(toolCall.id || ''))
  }

  const hiddenCompatIds = new Set()
  for (const toolCall of clonedToolCalls) {
    if (!isAnonymousCompatTaskContainer(toolCall)) continue
    const compatTaskId = extractTaskIdFromToolCall(toolCall)
    const liveAgent = clonedToolCalls.find(
      (candidate) =>
        candidate?.name === 'Agent' &&
        !isSyntheticTaskOutputAgent(candidate) &&
        extractTaskIdFromToolCall(candidate) &&
        extractTaskIdFromToolCall(candidate) === compatTaskId,
    )
    if (!liveAgent) continue
    mergeCompatTaskContainerIntoLiveAgent(liveAgent, toolCall)
    hiddenCompatIds.add(String(toolCall.id || ''))
  }

  const result = []
  let lastAgent = null
  for (const toolCall of clonedToolCalls) {
    if (syntheticTaskOutputIds.has(String(toolCall?.id || ''))) continue
    if (hiddenCompatIds.has(String(toolCall?.id || ''))) continue
    if (isUnknownEmptyToolCall(toolCall)) continue
    if (isAnonymousResultToolCall(toolCall) && lastAgent) {
      lastAgent.childToolCalls = [
        ...(lastAgent.childToolCalls || []),
        { ...toolCall, __orphanSourceId: toolCall.id },
      ]
      continue
    }

    const nextToolCall = {
      ...toolCall,
      childToolCalls: Array.isArray(toolCall.childToolCalls)
        ? [...toolCall.childToolCalls]
        : toolCall.childToolCalls,
    }
    if (Array.isArray(nextToolCall.childToolCalls)) {
      nextToolCall.childToolCalls = nextToolCall.childToolCalls.filter(
        (child) =>
          !isUnknownEmptyToolCall(child) && !shouldHideAnonymousTaskOutput(child),
      )
    }
    if (shouldHideAnonymousTaskOutput(nextToolCall)) continue
    result.push(nextToolCall)
    if (nextToolCall.name === 'Agent') {
      lastAgent = nextToolCall
    } else if (!isAnonymousResultToolCall(nextToolCall)) {
      lastAgent = null
    }
  }
  return result
}

function selectVisibleAssistantText(currentText, toolCalls) {
  const visibleText = normalizeMultilineText(extractTextContent(currentText))
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return visibleText
  if (visibleText && !looksLikeAssistantStarterText(visibleText)) return visibleText

  const agentCards = toolCalls
    .filter((toolCall) => toolCall?.name === 'Agent')
    .map((toolCall) => ({
      title: getToolCallTitle(toolCall),
      body: getToolCallBody(toolCall),
      isError: isToolCallError(toolCall),
    }))
    .filter((item) => item.body)

  if (agentCards.length === 0) return visibleText

  const completedCards = agentCards.filter((item) => !item.isError)
  if (completedCards.length === 1) {
    return completedCards[0].body
  }

  if (completedCards.length > 0) {
    const sections = []
    for (const card of completedCards) {
      sections.push(`### ${card.title}\n${card.body}`)
    }
    return sections.join('\n\n').trim() || visibleText
  }

  const failedCards = agentCards.filter((item) => item.isError)
  const sections = []
  for (const card of failedCards) {
    sections.push(`### ${card.title}\n${card.body}`)
  }

  return sections.join('\n\n').trim() || visibleText
}

function projectConversationMessageView(message) {
  if (!message || message.role !== 'assistant') return message
  const projectedToolCalls = projectToolCalls(message.toolCalls || [])
  const projectedContent = selectVisibleAssistantText(
    message.content,
    projectedToolCalls,
  )
  return {
    ...message,
    viewProjection: {
      version: 1,
      source: 'electron-main',
    },
    rawContent: message.content,
    rawToolCalls: message.toolCalls || [],
    content: projectedContent,
    toolCalls: projectedToolCalls,
    projectedContent,
    projectedToolCalls,
  }
}

module.exports = {
  projectConversationMessageView,
  projectToolCalls,
  selectVisibleAssistantText,
}
