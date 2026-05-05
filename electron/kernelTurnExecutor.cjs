const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

function runKernelTurn({
  conversation,
  provider,
  prompt,
  attachments,
  workspacePath,
  onText,
  onDone,
  onError,
  onStart,
  onPermissionRequest,
  onPermissionResolved,
  onToolUse,
  onSystemEvent,
  onForegroundDone,
  currentWorkspace,
  projectRoot,
  debugLog,
  resolveWorkspacePath,
  toRuntimeProviderSelection,
  stripThinking,
  getKernelRuntime,
  getKernelConversation,
  buildKernelTurnMetadata,
  resolveTaskOutputFile,
  extractTaskOutputPath,
  extractTaskOutputToolPayloads,
  readTaskOutputFinalMessage,
  readTaskOutputLatestAssistantMessage,
  listRecentTaskOutputFiles,
  extractAgentTaskId,
  buildTaskEventPayload,
  projectSemanticTaskNotification,
  projectSemanticCoordinatorLifecycle,
  projectSemanticToolProgress,
  extractSemanticAssistantText,
  normalizeToolInput,
  stringifyToolValue,
  serializePermissionRequest,
  serializePermissionResolved,
  selectVisibleRunFinalText,
  isKernelRuntimeTransportError,
  isGenericKernelTurnFailureMessage,
  isKernelTurnErrorStopReason,
  disposeKernelConversation,
  resetKernelRuntime,
  nowIso,
  saveState,
  readJson,
  TASK_OUTPUT_COMPLETION_POLL_MS,
  TASK_OUTPUT_COMPLETION_MAX_ATTEMPTS,
  TASK_OUTPUT_DISCOVERY_POLL_MS,
  TASK_OUTPUT_LIVE_PARENT_GRACE_MS,
} = {}) {
  const requestedWorkspace = workspacePath || currentWorkspace || projectRoot;
  const workspace = resolveWorkspacePath(requestedWorkspace, currentWorkspace, projectRoot);
  if (workspace !== requestedWorkspace) {
    debugLog(`workspace path unavailable for ${conversation.id}: requested=${requestedWorkspace} fallback=${workspace}`);
  }
  const previousSessionId = String(conversation.backend_session_id || '').trim();
  const sessionId = previousSessionId || undefined;
  const turnId = `turn-${randomUUID()}`;
  const providerSelection = toRuntimeProviderSelection(
    provider,
    stripThinking(conversation.model) || conversation.model,
    conversation.id,
  );

  let runtime = null;
  let kernelConversation = null;
  let unsubscribe = null;
  let stopRequested = false;
  let terminal = false;
  let streamedText = '';
  let lastAssistantText = '';
  let lastResultText = '';
  let lastErrorText = '';
  let lastTaskErrorText = '';
  let runtimeSessionId = previousSessionId;
  let foregroundDoneEmitted = false;
  let backgroundFinishTimer = null;
  const toolUseInputsById = new Map();
  const toolNamesById = new Map();
  const emittedToolResults = new Set();
  const pendingBackgroundTaskIds = new Set();
  const pendingPermissionRequestIds = new Set();
  const pendingTaskOutputWaitIds = new Set();
  const discoveredTaskOutputs = new Map();
  const liveTaskToolUseIdsByTaskId = new Map();
  const liveParentToolUseIdsByChildToolUseId = new Map();
  const liveTopLevelAgentToolUseIdsByDescription = new Map();
  const taskOutputWaitTimers = new Set();
  const discoveryStartedAtMs = Date.now();
  let taskDiscoveryTimer = null;
  let lastToolTextSnapshot = '';

  const cleanup = () => {
    if (backgroundFinishTimer) {
      clearTimeout(backgroundFinishTimer);
      backgroundFinishTimer = null;
    }
    for (const timer of taskOutputWaitTimers) {
      clearTimeout(timer);
    }
    taskOutputWaitTimers.clear();
    if (taskDiscoveryTimer) {
      clearInterval(taskDiscoveryTimer);
      taskDiscoveryTimer = null;
    }
    if (unsubscribe) {
      try { unsubscribe(); } catch {}
      unsubscribe = null;
    }
  };

  const finish = (kind, value) => {
    if (terminal) return;
    terminal = true;
    const finalText = selectVisibleRunFinalText({
      lastAssistantText,
      streamedText,
      lastResultText,
    });
    if (kind === 'error') {
      onError(value || lastErrorText || 'Kernel runtime request failed');
    } else {
      onDone(value || finalText || '[模型未返回文本]');
    }
    cleanup();
  };

  const stop = (options = {}) => {
    if (terminal || stopRequested) return;
    stopRequested = true;
    if (kernelConversation) {
      void kernelConversation.abortTurn(turnId, { reason: 'desktop_stop_generation' }).catch(() => {});
    }
    if (options?.mode === 'finish') {
      const finalText = selectVisibleRunFinalText({
        lastAssistantText,
        streamedText,
        lastResultText,
      });
      finish('done', finalText || '[模型未返回文本]');
      return;
    }
    finish('error', 'Task stopped.');
  };

  const emitText = (text) => {
    if (!text || terminal) return;
    streamedText += text;
    onText(text);
  };

  const emitToolUse = (payload) => {
    if (terminal || typeof onToolUse !== 'function') return;
    onToolUse(payload);
  };

  const emitSystemEvent = (payload) => {
    if (terminal || typeof onSystemEvent !== 'function') return;
    onSystemEvent(payload);
  };

  const descriptionFromTaskOutput = (record) => {
    const candidates = [];
    const pushCandidate = (file) => {
      if (file && !candidates.includes(file)) candidates.push(file);
    };
    pushCandidate(path.join(
      path.dirname(path.dirname(record.outputFile)),
      'subagents',
      `agent-${record.taskId}.meta.json`,
    ));
    try {
      const realOutputFile = fs.realpathSync(record.outputFile);
      const baseName = path.basename(realOutputFile).replace(/\.jsonl$/i, '');
      pushCandidate(path.join(path.dirname(realOutputFile), `${baseName}.meta.json`));
    } catch {}
    const meta = candidates.map((file) => readJson(file, null)).find(Boolean);
    return String(meta?.description || meta?.agentType || 'Agent task').trim();
  };

  const inferLiveParentToolUseIdFromTaskOutput = (outputFile) => {
    const probePayloads = extractTaskOutputToolPayloads({
      outputFile,
      parentToolUseId: '__probe_parent__',
      seenEventKeys: new Set(),
      toolUseIdMap: new Map(),
      toolNameById: new Map(),
      useRawToolUseIds: true,
      maxDepth: 2,
    });
    for (const payload of probePayloads) {
      const childToolUseId = String(payload?.tool_use_id || '').trim();
      if (!childToolUseId) continue;
      const liveParentToolUseId = String(liveParentToolUseIdsByChildToolUseId.get(childToolUseId) || '').trim();
      if (liveParentToolUseId) return liveParentToolUseId;
    }
    return '';
  };

  const inferLiveParentToolUseIdFromDescription = (description) => {
    const key = String(description || '').trim();
    if (!key) return '';
    const matches = Array.from(liveTopLevelAgentToolUseIdsByDescription.get(key) || []).filter(Boolean);
    return matches.length === 1 ? matches[0] : '';
  };

  const maybeEmitForegroundDone = () => {
    if (foregroundDoneEmitted || pendingBackgroundTaskIds.size === 0) return;
    const finalText = (lastAssistantText || streamedText || '').trim();
    if (!finalText) return;
    foregroundDoneEmitted = true;
    if (typeof onForegroundDone === 'function') {
      onForegroundDone(finalText);
    }
  };

  const maybeFinishBackgroundRun = () => {
    if (!foregroundDoneEmitted || pendingBackgroundTaskIds.size > 0 || terminal) return;
    if (backgroundFinishTimer) clearTimeout(backgroundFinishTimer);
    backgroundFinishTimer = setTimeout(() => {
      backgroundFinishTimer = null;
      if (!foregroundDoneEmitted || pendingBackgroundTaskIds.size > 0 || terminal) return;
      const finalText = selectVisibleRunFinalText({
        lastAssistantText,
        streamedText,
        lastResultText,
      });
      finish('done', finalText || '[模型未返回文本]');
    }, 100);
  };

  const emitDiscoveredTaskOutput = (record) => {
    if (terminal || !record?.outputFile) return;
    let state = discoveredTaskOutputs.get(record.outputFile);
    if (!state) {
      const description = descriptionFromTaskOutput(record);
      const existingParentToolUseId = String(
        liveTaskToolUseIdsByTaskId.get(record.taskId)
        || inferLiveParentToolUseIdFromDescription(description)
        || inferLiveParentToolUseIdFromTaskOutput(record.outputFile)
        || '',
      ).trim();
      const taskAgeMs = Math.max(0, Date.now() - Number(record.mtimeMs || 0));
      if (!existingParentToolUseId && taskAgeMs < TASK_OUTPUT_LIVE_PARENT_GRACE_MS) {
        return;
      }
      if (!existingParentToolUseId) {
        return;
      }
      state = {
        toolUseId: existingParentToolUseId,
        taskId: record.taskId,
        outputFile: record.outputFile,
        description,
        lastSize: 0,
        completed: false,
        seenChildToolEventKeys: new Set(),
        childToolUseIdsByOriginalId: new Map(),
        childToolNamesByOriginalId: new Map(),
      };
      discoveredTaskOutputs.set(record.outputFile, state);
      pendingBackgroundTaskIds.add(record.taskId);
      runtimeSessionId = runtimeSessionId || record.sessionId;
      if (!conversation.backend_session_id) conversation.backend_session_id = record.sessionId;
      emitSystemEvent({
        type: 'task_event',
        subtype: 'task_started',
        task_id: record.taskId,
        tool_use_id: existingParentToolUseId,
        description,
        summary: 'Agent task started',
        output_file: record.outputFile,
        status: 'running',
        task_type: 'local_agent',
      });
      maybeEmitForegroundDone();
    }

    const childToolPayloads = extractTaskOutputToolPayloads({
      outputFile: record.outputFile,
      parentToolUseId: state.toolUseId,
      seenEventKeys: state.seenChildToolEventKeys,
      toolUseIdMap: state.childToolUseIdsByOriginalId,
      toolNameById: state.childToolNamesByOriginalId,
      useRawToolUseIds: true,
    });
    for (const payload of childToolPayloads) {
      emitToolUse(payload);
    }

    const latest = readTaskOutputLatestAssistantMessage(record.outputFile);
    if (latest?.text && record.size !== state.lastSize && !state.completed) {
      state.lastSize = record.size;
      emitSystemEvent({
        type: 'task_event',
        subtype: latest.isCompleted ? 'task_notification' : 'task_progress',
        task_id: state.taskId,
        tool_use_id: state.toolUseId,
        description: state.description,
        summary: latest.text,
        result: latest.isCompleted ? latest.text : undefined,
        output_file: latest.outputFile || record.outputFile,
        is_error: latest.isError || undefined,
        status: latest.isCompleted ? (latest.isError ? 'failed' : 'completed') : 'running',
        task_type: 'local_agent',
      });
    }

    if (latest?.isCompleted && !state.completed) {
      state.completed = true;
      pendingBackgroundTaskIds.delete(state.taskId);
      if (latest.isError) {
        lastTaskErrorText = latest.text || 'Background task failed';
      } else if (latest.text) {
        lastResultText = latest.text;
      }
      maybeFinishBackgroundRun();
    }
  };

  const pollDiscoveredTaskOutputs = () => {
    if (terminal) return;
    const files = listRecentTaskOutputFiles(workspace, discoveryStartedAtMs - 5000);
    for (const record of files) {
      emitDiscoveredTaskOutput(record);
    }
  };

  const startTaskOutputDiscovery = () => {
    if (taskDiscoveryTimer) return;
    pollDiscoveredTaskOutputs();
    taskDiscoveryTimer = setInterval(pollDiscoveredTaskOutputs, TASK_OUTPUT_DISCOVERY_POLL_MS);
    taskDiscoveryTimer.unref?.();
  };

  const handleSemanticTurnDelta = (payload) => {
    const text = extractSemanticAssistantText(payload);
    if (!text) return;
    lastAssistantText = text;
    maybeEmitForegroundDone();
  };

  const scheduleTaskOutputFinalization = ({ taskId, outputFile, basePayload, initialIsError }) => {
    const file = String(outputFile || '').trim();
    if (!file) return false;
    const waitId = `task-output:${taskId}`;
    if (pendingTaskOutputWaitIds.has(waitId)) return true;
    pendingTaskOutputWaitIds.add(waitId);
    pendingBackgroundTaskIds.add(waitId);
    let attempts = 0;
    const scheduleRetry = () => {
      const timer = setTimeout(() => {
        taskOutputWaitTimers.delete(timer);
        retry();
      }, 250);
      taskOutputWaitTimers.add(timer);
    };
    const retry = () => {
      attempts += 1;
      const taskFinal = readTaskOutputFinalMessage(file);
      if (!taskFinal?.text && attempts < 12 && !terminal) {
        scheduleRetry();
        return;
      }
      pendingTaskOutputWaitIds.delete(waitId);
      pendingBackgroundTaskIds.delete(waitId);
      if (taskFinal?.text) {
        const isTaskError = Boolean(taskFinal.isError || initialIsError);
        if (isTaskError) {
          lastTaskErrorText = taskFinal.text;
        } else {
          lastResultText = taskFinal.text;
        }
        emitSystemEvent({
          ...basePayload,
          result: taskFinal.text,
          output_file: taskFinal.outputFile || file,
          is_error: isTaskError || undefined,
          status: isTaskError ? 'failed' : basePayload.status,
        });
      }
      maybeFinishBackgroundRun();
    };
    scheduleRetry();
    return true;
  };

  const scheduleTaskCompletionFallback = ({ taskId, outputFile, basePayload, initialIsError }) => {
    const file = String(outputFile || '').trim();
    if (!file) return false;
    const waitId = `task-completion:${taskId}`;
    if (pendingTaskOutputWaitIds.has(waitId)) return true;
    pendingTaskOutputWaitIds.add(waitId);
    let attempts = 0;
    const cleanupWait = () => {
      pendingTaskOutputWaitIds.delete(waitId);
    };
    const scheduleRetry = () => {
      const timer = setTimeout(() => {
        taskOutputWaitTimers.delete(timer);
        retry();
      }, TASK_OUTPUT_COMPLETION_POLL_MS);
      taskOutputWaitTimers.add(timer);
    };
    const retry = () => {
      if (terminal || !pendingBackgroundTaskIds.has(taskId)) {
        cleanupWait();
        return;
      }
      attempts += 1;
      const taskFinal = readTaskOutputFinalMessage(file, { requireCompleted: true });
      if (!taskFinal?.text && attempts < TASK_OUTPUT_COMPLETION_MAX_ATTEMPTS) {
        scheduleRetry();
        return;
      }
      cleanupWait();
      pendingBackgroundTaskIds.delete(taskId);
      if (!taskFinal?.text) {
        const timeoutMessage = `Background task ${taskId} did not produce a completion notification.`;
        lastTaskErrorText = timeoutMessage;
        emitSystemEvent({
          ...basePayload,
          subtype: 'task_notification',
          summary: timeoutMessage,
          result: timeoutMessage,
          output_file: file,
          is_error: true,
          status: 'failed',
        });
        maybeFinishBackgroundRun();
        return;
      }
      const isTaskError = Boolean(taskFinal.isError || initialIsError);
      if (isTaskError) {
        lastTaskErrorText = taskFinal.text;
      } else {
        lastResultText = taskFinal.text;
      }
      emitSystemEvent({
        ...basePayload,
        subtype: 'task_notification',
        summary: taskFinal.text,
        result: taskFinal.text,
        output_file: taskFinal.outputFile || file,
        is_error: isTaskError || undefined,
        status: isTaskError ? 'failed' : 'completed',
      });
      maybeFinishBackgroundRun();
    };
    scheduleRetry();
    return true;
  };

  const handleSemanticTurnProgress = (payload) => {
    const projection = projectSemanticToolProgress({
      payload,
      streamedText,
      lastToolTextSnapshot,
      normalizeToolInput,
      toolNamesById,
      toolUseInputsById,
    });
    if (!projection?.emittedEvent) return;
    lastToolTextSnapshot = projection.lastToolTextSnapshot;
    const emittedToolUseId = String(projection.emittedEvent.tool_use_id || '').trim();
    const emittedParentToolUseId = String(projection.emittedEvent.parent_tool_use_id || '').trim();
    if (emittedToolUseId && emittedParentToolUseId) {
      liveParentToolUseIdsByChildToolUseId.set(emittedToolUseId, emittedParentToolUseId);
    }
    if (
      projection.emittedEvent.type === 'tool_use_start'
      && !emittedParentToolUseId
      && projection.emittedEvent.tool_name === 'Agent'
    ) {
      const description = String(projection.emittedEvent.tool_input?.description || '').trim();
      if (description && emittedToolUseId) {
        const existing = liveTopLevelAgentToolUseIdsByDescription.get(description) || new Set();
        existing.add(emittedToolUseId);
        liveTopLevelAgentToolUseIdsByDescription.set(description, existing);
      }
    }
    if (projection.emittedEvent.type === 'tool_use_done' && projection.emittedEvent.tool_name === 'Agent') {
      const outputFile = extractTaskOutputPath(projection.emittedEvent.content);
      const taskId = extractAgentTaskId(projection.emittedEvent.content);
      const parentToolUseId = String(projection.emittedEvent.tool_use_id || '').trim();
      if (taskId && parentToolUseId) {
        liveTaskToolUseIdsByTaskId.set(taskId, parentToolUseId);
      }
      if (outputFile && parentToolUseId) {
        const existingDiscovered = discoveredTaskOutputs.get(outputFile);
        if (existingDiscovered) {
          existingDiscovered.toolUseId = parentToolUseId;
        }
      }
    }
    emitToolUse(projection.emittedEvent);
  };

  const handleSemanticTaskNotification = (payload) => {
    const outputFile = String(payload?.outputFile || '').trim();
    const taskFinal = outputFile ? readTaskOutputFinalMessage(outputFile) : null;
    const projection = projectSemanticTaskNotification({
      payload,
      turnId,
      taskFinal,
      stringifyToolValue,
    });
    if (!projection) return;
    const {
      taskId,
      isTaskError,
      summary,
      resultText,
      taskEventPayload,
    } = projection;
    if (taskEventPayload?.tool_use_id) {
      liveTaskToolUseIdsByTaskId.set(taskId, taskEventPayload.tool_use_id);
    }
    if (resultText && !isTaskError) {
      lastResultText = resultText;
    }
    if (isTaskError) {
      lastTaskErrorText = resultText || summary || 'Background task failed';
    }
    pendingBackgroundTaskIds.delete(taskId);
    emitSystemEvent(taskEventPayload);
    if (!resultText && outputFile && scheduleTaskOutputFinalization({
      taskId,
      outputFile,
      basePayload: taskEventPayload,
      initialIsError: isTaskError,
    })) {
      return;
    }
    maybeFinishBackgroundRun();
  };

  const handleSemanticCoordinatorLifecycle = (eventType, payload) => {
    const projection = projectSemanticCoordinatorLifecycle(eventType, payload);
    if (!projection) return;
    if (projection.toolUseId && projection.taskId) {
      liveTaskToolUseIdsByTaskId.set(projection.taskId, projection.toolUseId);
    }
    const outputFile = resolveTaskOutputFile({
      workspacePath: workspace,
      sessionId: runtimeSessionId || kernelConversation?.sessionId,
      taskId: projection.taskId,
    });
    if (projection.phase === 'started') {
      const { taskId, shouldTrackTask, taskEventPayload } = projection;
      if (shouldTrackTask) {
        pendingBackgroundTaskIds.add(taskId);
        maybeEmitForegroundDone();
      }
      emitSystemEvent(taskEventPayload);
      if (!shouldTrackTask || !outputFile) return;
      scheduleTaskCompletionFallback({
        taskId,
        outputFile,
        basePayload: taskEventPayload,
        initialIsError: false,
      });
      return;
    }

    const taskFinal = outputFile ? readTaskOutputFinalMessage(outputFile) : null;
    const taskEventPayload = buildTaskEventPayload({
      message: {
        subtype: 'task_notification',
        task_id: projection.taskId,
        tool_use_id: projection.toolUseId,
        output_file: outputFile,
        summary: projection.summary,
        status: projection.status,
        task_type: projection.taskType || undefined,
      },
      turnId,
      taskFinal,
      stringifyToolValue,
    });
    const resultText = String(taskFinal?.text || '');
    if (resultText && !projection.isTaskError) {
      lastResultText = resultText;
    }
    if (projection.isTaskError) {
      lastTaskErrorText = resultText || projection.summary || 'Background task failed';
    }
    if (projection.shouldTrackTask) {
      pendingBackgroundTaskIds.delete(projection.taskId);
    }
    emitSystemEvent(taskEventPayload);
    if (
      projection.shouldTrackTask &&
      !resultText &&
      outputFile &&
      scheduleTaskOutputFinalization({
        taskId: projection.taskId,
        outputFile,
        basePayload: taskEventPayload,
        initialIsError: projection.isTaskError,
      })
    ) {
      return;
    }
    maybeFinishBackgroundRun();
  };

  const finishTaskLocalFailure = (source, detail = '') => {
    debugLog(`task-local failure completed without ending run as error ${conversation.id}: source=${source} message=${detail || lastTaskErrorText}`);
    pendingBackgroundTaskIds.clear();
    pendingTaskOutputWaitIds.clear();
    const finalText = selectVisibleRunFinalText({
      lastAssistantText,
      streamedText,
      lastResultText,
    });
    finish('done', finalText || '[模型未返回文本]');
  };

  const abortForegroundReleasedPermission = (permissionRequestId) => {
    if (!foregroundDoneEmitted) return false;
    debugLog(`permission requested after foreground_done for ${conversation.id}: request=${permissionRequestId}`);
    void decidePermission({
      permissionRequestId,
      decision: 'abort',
      decidedBy: 'host',
      reason: 'Foreground response already finished; desktop will not wait for post-foreground tool approval.',
    }).catch((error) => {
      debugLog(`failed to abort post-foreground permission ${permissionRequestId}: ${error?.message || error}`);
    }).finally(() => {
      pendingPermissionRequestIds.delete(permissionRequestId);
      maybeFinishBackgroundRun();
    });
    return true;
  };

  const decidePermission = async ({ permissionRequestId, decision, decidedBy = 'host', reason = '', metadata }) => {
    const normalizedRequestId = String(permissionRequestId || '').trim();
    if (!runtime || !normalizedRequestId) {
      throw new Error('Kernel runtime permission broker unavailable');
    }
    return runtime.decidePermission({
      permissionRequestId: normalizedRequestId,
      decision,
      decidedBy,
      reason: String(reason || '').trim(),
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    });
  };

  const failTurn = (message) => {
    debugLog(`kernel turn failed for ${conversation.id}: ${message || 'Kernel runtime turn failed'}`);
    conversation.backend_runtime = 'kernel';
    conversation.backend_started = false;
    conversation.backend_session_id = undefined;
    void disposeKernelConversation(conversation.id, 'desktop_turn_failed');
    finish('error', message || 'Kernel runtime turn failed');
  };

  const completeTurn = (stopReason) => {
    debugLog(`kernel turn completed for ${conversation.id}: stopReason=${stopReason || 'end_turn'}`);
    conversation.backend_runtime = 'kernel';
    conversation.backend_session_id = runtimeSessionId || conversation.backend_session_id || kernelConversation?.sessionId;
    conversation.backend_started = false;
    if (stopReason === 'foreground_done') {
      conversation.backend_started = true;
      conversation.updated_at = nowIso();
      saveState();
      return;
    }
    if (stopRequested || stopReason === 'aborted') {
      finish('error', 'Task stopped.');
      return;
    }
    if (lastErrorText && isKernelTurnErrorStopReason(stopReason)) {
      conversation.backend_session_id = undefined;
      void disposeKernelConversation(conversation.id, 'desktop_turn_failed');
      finish('error', lastErrorText);
      return;
    }
    if (!(lastAssistantText || lastResultText || streamedText || '').trim()) {
      conversation.backend_session_id = undefined;
      void disposeKernelConversation(conversation.id, 'desktop_turn_empty_output');
      void resetKernelRuntime('desktop_turn_empty_output');
      finish('error', 'Kernel runtime returned no text. Session was reset; please retry.');
      return;
    }
    conversation.backend_started = true;
    finish('done');
  };

  const handlePermissionRequest = (request) => {
    const permissionRequestId = String(request?.permissionRequestId || '').trim();
    if (!permissionRequestId) return;
    pendingPermissionRequestIds.add(permissionRequestId);
    if (abortForegroundReleasedPermission(permissionRequestId)) {
      return;
    }
    const serialized = serializePermissionRequest(request);
    debugLog(`permission requested for ${conversation.id}: tool=${serialized.tool_name || ''} risk=${serialized.risk || ''}`);
    if (typeof onPermissionRequest === 'function') {
      onPermissionRequest(serialized);
      return;
    }
    void decidePermission({
      permissionRequestId,
      decision: 'abort',
      decidedBy: 'host',
      reason: 'Desktop permission UI not connected yet',
    }).catch((error) => {
      debugLog(`failed to resolve permission request ${permissionRequestId}: ${error?.message || error}`);
    });
  };

  const handleKernelEnvelope = (envelope) => {
    if (!envelope || terminal) return;
    if (envelope.kind === 'error') {
      if (isKernelRuntimeTransportError(envelope.error)) {
        void resetKernelRuntime('desktop_runtime_worker_error');
      }
      finish('error', envelope.error?.message || 'Kernel runtime request failed');
      return;
    }

    const eventType = envelope.payload?.type;
    const eventPayload = envelope.payload?.payload;
    if (eventType === 'permission.requested') {
      handlePermissionRequest(eventPayload);
      return;
    }

    if (eventType === 'permission.resolved') {
      const permissionRequestId = String(eventPayload?.permissionRequestId || eventPayload?.permission_request_id || '').trim();
      if (permissionRequestId) pendingPermissionRequestIds.delete(permissionRequestId);
      if (typeof onPermissionResolved === 'function') {
        onPermissionResolved(serializePermissionResolved(eventPayload));
      }
      maybeFinishBackgroundRun();
      return;
    }

    if (eventType === 'turn.delta') {
      handleSemanticTurnDelta(eventPayload);
      return;
    }

    if (eventType === 'turn.output_delta') {
      const text = typeof eventPayload?.text === 'string' ? eventPayload.text : '';
      if (text) emitText(text);
      return;
    }

    if (eventType === 'turn.progress') {
      handleSemanticTurnProgress(eventPayload);
      return;
    }

    if (eventType === 'tasks.notification') {
      handleSemanticTaskNotification(eventPayload);
      return;
    }

    if (['handoff.started', 'handoff.completed', 'handoff.failed'].includes(eventType)) {
      handleSemanticCoordinatorLifecycle(eventType, eventPayload);
      return;
    }

    if (eventType === 'turn.failed') {
      const eventMessage = typeof eventPayload?.error?.message === 'string'
        ? eventPayload.error.message
        : '';
      if (lastTaskErrorText && !lastErrorText && isGenericKernelTurnFailureMessage(eventMessage)) {
        finishTaskLocalFailure('turn.failed', eventMessage);
        return;
      }
      const message = !isGenericKernelTurnFailureMessage(eventMessage)
        ? eventMessage
        : lastErrorText;
      failTurn(message);
      return;
    }

    if (eventType === 'turn.abort_requested') {
      conversation.backend_runtime = 'kernel';
      conversation.backend_started = false;
      finish('error', 'Task stopped.');
      return;
    }

    if (eventType === 'turn.completed') {
      completeTurn(eventPayload?.stopReason);
    }
  };

  onStart({
    stop,
    sessionId,
    decidePermission,
  });

  void (async () => {
    try {
      debugLog(`runViaKernel start ${conversation.id}: session=${sessionId || ''} workspace=${workspace}`);
      runtime = await getKernelRuntime();
      debugLog(`runViaKernel runtime ready ${conversation.id}`);
      kernelConversation = await getKernelConversation({
        ...conversation,
        workspace_path: workspace,
        backend_session_id: previousSessionId || undefined,
      }, providerSelection, runtime);
      debugLog(`runViaKernel conversation ready ${conversation.id}: runtimeSession=${kernelConversation.sessionId || ''}`);
      runtimeSessionId = conversation.backend_session_id || kernelConversation.sessionId || runtimeSessionId;
      conversation.backend_session_id = runtimeSessionId;
      unsubscribe = kernelConversation.onEvent(handleKernelEnvelope);
      startTaskOutputDiscovery();

      if (stopRequested) {
        finish('error', 'Task stopped.');
        return;
      }

      debugLog(`runViaKernel runTurn ${conversation.id}: turn=${turnId}`);
      const turnSnapshot = await kernelConversation.runTurn(prompt, {
        turnId,
        attachments: attachments || undefined,
        providerOverride: providerSelection,
        metadata: {
          ...buildKernelTurnMetadata({
            conversation,
            provider,
            providerSelection,
            sessionId,
            isResuming: Boolean(previousSessionId),
          }),
        },
      });
      debugLog(`runViaKernel runTurn returned ${conversation.id}: state=${turnSnapshot?.state || 'unknown'} stopReason=${turnSnapshot?.stopReason || ''}`);
      if (terminal) {
        return;
      }
      if (turnSnapshot?.state === 'completed') {
        completeTurn(turnSnapshot.stopReason);
        return;
      }
      if (turnSnapshot?.state === 'failed') {
        const snapshotMessage = typeof turnSnapshot?.error?.message === 'string'
          ? turnSnapshot.error.message
          : '';
        if (lastTaskErrorText && !lastErrorText && isGenericKernelTurnFailureMessage(snapshotMessage)) {
          finishTaskLocalFailure('snapshot.failed', snapshotMessage);
          return;
        }
        failTurn(snapshotMessage || lastErrorText);
        return;
      }
    } catch (error) {
      if (isKernelRuntimeTransportError(error)) {
        await resetKernelRuntime('desktop_runtime_failed');
      }
      conversation.backend_runtime = 'kernel';
      conversation.backend_started = false;
      finish('error', error?.message || 'Kernel runtime request failed');
    }
  })();
}

module.exports = {
  runKernelTurn,
}
