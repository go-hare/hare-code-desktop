import { describe, expect, test } from 'bun:test';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  buildTaskEventPayload,
  extractTaskOutputToolPayloads,
  extractSessionIdFromTaskOutputPath,
  findLatestPersistedTaskForContinuation,
  findLatestPersistedTaskSessionId,
  pruneIncompleteToolCalls,
  reconcilePreviousRunForNewTurn,
  resolveTaskOutputFile,
  resolveHistoricalContinuationSession,
  selectVisibleRunFinalText,
  shouldTrackBackgroundTask,
} = require('./kernelChatRuntimeHelpers.cjs');
const {
  projectConversationMessageView,
} = require('./chatViewProjection.cjs');
const {
  createRecentKernelRunStore,
} = require('./kernelRunStore.cjs');
const {
  createKernelConversationStore,
} = require('./kernelConversationStore.cjs');
const {
  createKernelRuntimeBridge,
} = require('./kernelRuntimeBridge.cjs');
const {
  createDesktopKernelRunController,
} = require('./desktopKernelRunController.cjs');
const {
  runKernelTurn,
} = require('./kernelTurnExecutor.cjs');

describe('kernelChatRuntimeHelpers', () => {
  test('keeps foreground-done run alive when a new turn starts', () => {
    let stopCalled = false;
    const activeRuns = new Map([
      ['conv-1', {
        id: 'run-1',
        foregroundDone: true,
        stop() {
          stopCalled = true;
        },
      }],
    ]);
    const logs = [];

    const result = reconcilePreviousRunForNewTurn({
      activeRuns,
      conversationId: 'conv-1',
      debugLog: (line) => logs.push(line),
    });

    expect(result.keptBackgroundRun).toBe(true);
    expect(result.abortedForegroundRun).toBe(false);
    expect(stopCalled).toBe(false);
    expect(activeRuns.get('conv-1')?.id).toBe('run-1');
    expect(logs.some((line) => line.includes('keep background run alive'))).toBe(true);
  });

  test('aborts unfinished foreground run when a new turn starts', () => {
    const stopCalls = [];
    const activeRuns = new Map([
      ['conv-2', {
        id: 'run-2',
        foregroundDone: false,
        stop(payload) {
          stopCalls.push(payload);
        },
      }],
    ]);

    const result = reconcilePreviousRunForNewTurn({
      activeRuns,
      conversationId: 'conv-2',
      debugLog: () => {},
    });

    expect(result.keptBackgroundRun).toBe(false);
    expect(result.abortedForegroundRun).toBe(true);
    expect(stopCalls).toEqual([{ mode: 'abort' }]);
    expect(activeRuns.has('conv-2')).toBe(false);
  });

  test('tracks expanded task family and preserves workflow payload fields', () => {
    expect(shouldTrackBackgroundTask('local_workflow')).toBe(true);
    expect(shouldTrackBackgroundTask('monitor_mcp')).toBe(true);
    expect(shouldTrackBackgroundTask('dream')).toBe(true);
    expect(shouldTrackBackgroundTask('unknown')).toBe(false);

    const workflowProgress = [{ type: 'step', index: 0, phaseIndex: 1, label: 'compile' }];
    const payload = buildTaskEventPayload({
      message: {
        subtype: 'task_progress',
        task_id: 'task-1',
        tool_use_id: 'tool-1',
        description: 'Running workflow',
        summary: 'still running',
        status: 'running',
        task_type: 'local_workflow',
        workflow_name: 'build-release',
        workflow_progress: workflowProgress,
        prompt: 'ship it',
      },
      turnId: 'turn-1',
      taskFinal: null,
      stringifyToolValue: (value) => JSON.stringify(value),
    });

    expect(payload.task_id).toBe('task-1');
    expect(payload.task_type).toBe('local_workflow');
    expect(payload.workflow_name).toBe('build-release');
    expect(payload.workflow_progress).toEqual(workflowProgress);
    expect(payload.prompt).toBe('ship it');
  });

  test('drops incomplete running tool calls before completing a turn', () => {
    const toolCalls = [
      {
        id: 'real-agent',
        name: 'Agent',
        input: { description: 'read project', prompt: 'inspect files' },
        status: 'running',
      },
      {
        id: 'empty-agent',
        name: 'Agent',
        input: {},
        status: 'running',
      },
      {
        id: 'parent',
        name: 'Agent',
        input: { description: 'parent', prompt: 'run' },
        status: 'running',
        childToolCalls: [
          {
            id: 'empty-child',
            name: 'Read',
            input: {},
            status: 'running',
          },
        ],
      },
    ];

    pruneIncompleteToolCalls(toolCalls);

    expect(toolCalls.map((toolCall) => toolCall.id)).toEqual(['real-agent', 'parent']);
    expect(toolCalls[1].childToolCalls).toEqual([]);
  });

  test('prefers foreground assistant text over background task result at run completion', () => {
    expect(selectVisibleRunFinalText({
      lastAssistantText: '已收到',
      streamedText: '',
      lastResultText: 'kernel:build\nkernel:build:package\nsdk:build',
    })).toBe('已收到');
  });

  test('falls back to background task result when no assistant text exists', () => {
    expect(selectVisibleRunFinalText({
      lastAssistantText: '',
      streamedText: '',
      lastResultText: 'kernel:build\nkernel:build:package\nsdk:build',
    })).toBe('kernel:build\nkernel:build:package\nsdk:build');
  });

  test('projects assistant snapshot view with visible summary and without compat tool output', () => {
    const message = projectConversationMessageView({
      id: 'msg-1',
      role: 'assistant',
      content: '我先从两个方向并行看一下这个仓库：一边梳理整体架构和主要模块，一边检查当前分支上的改动在做什么。',
      toolCalls: [
        {
          id: 'agent-1',
          name: 'Agent',
          status: 'done',
          subagent: {
            task_id: 'task-1',
            description: 'Map repo architecture',
            status: 'completed',
            summary: '已按要求做就地只读分析，结论如下。',
          },
          childToolCalls: [],
        },
        {
          id: 'agent-2',
          name: 'Agent',
          status: 'done',
          subagent: {
            task_id: 'task-2',
            description: 'Inspect current changes',
            status: 'completed',
            summary: '当前在 main 分支，工作区改动集中在桌面聊天运行时重构。',
          },
          childToolCalls: [],
        },
        {
          id: 'compat-1',
          name: 'unknown',
          status: 'done',
          result: [
            {
              type: 'text',
              text: 'Async agent launched successfully.\nagentId: task-1\noutput_file: /tmp/task-1.output',
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
        {
          id: 'noise-1',
          name: 'unknown',
          status: 'done',
          result: 'Sleep interrupted after 0s',
        },
      ],
    });

    expect(message.content).toContain('### Agent Map repo architecture');
    expect(message.content).toContain('### Agent Inspect current changes');
    expect(message.content).not.toContain('我先从两个方向并行看一下这个仓库');
    expect(message.viewProjection).toEqual({ version: 1, source: 'electron-main' });
    expect(message.toolCalls.map((toolCall) => toolCall.id)).toEqual(['agent-1', 'agent-2']);
    expect(message.toolCalls[0].childToolCalls).toHaveLength(1);
    expect(message.toolCalls[0].childToolCalls[0]).toMatchObject({
      id: 'child-1',
      name: 'Read',
    });
  });

  test('derives CLI task output path from workspace, session and task id', () => {
    const outputFile = resolveTaskOutputFile({
      workspacePath: '/Users/apple/Downloads/codex-oauth-automation-extension-master',
      sessionId: 'session-1',
      taskId: 'task-1',
      env: { CLAUDE_CODE_TMPDIR: '/tmp' },
    });

    const normalized = outputFile.replace(/\\/g, '/');
    expect(normalized).toContain('/claude/');
    expect(normalized).toContain('/-Users-apple-Downloads-codex-oauth-automation-extension-master/session-1/tasks/task-1.output');
  });

  test('stores and retrieves recent kernel run snapshots by run id and latest conversation', () => {
    const store = createRecentKernelRunStore({ ttlMs: 60_000 });
    store.rememberKernelRunForReplay({
      id: 'run-1',
      conversationId: 'conv-1',
      foregroundDone: true,
      buffer: [{ sequence: 1, line: 'data: one\\n\\n' }],
    }, 'completed');
    const firstSnapshot = store.getRecentKernelRunSnapshot('conv-1', 'run-1');
    firstSnapshot.timer?.refresh?.();
    store.rememberKernelRunForReplay({
      id: 'run-2',
      conversationId: 'conv-1',
      foregroundDone: false,
      buffer: [{ sequence: 2, line: 'data: two\\n\\n' }],
    }, 'failed');

    expect(store.getRecentKernelRunSnapshot('conv-1', 'run-1')).toMatchObject({
      id: 'run-1',
      conversationId: 'conv-1',
      terminalState: 'completed',
      foregroundDone: true,
    });
    const latestSnapshot = store.getRecentKernelRunSnapshot('conv-1');
    expect(['run-1', 'run-2']).toContain(latestSnapshot?.id);
    expect(latestSnapshot?.conversationId).toBe('conv-1');

    store.forgetRecentKernelRuns('conv-1');
    expect(store.getRecentKernelRunSnapshot('conv-1', 'run-1')).toBe(null);
    expect(store.getRecentKernelRunSnapshot('conv-1')).toBe(null);
  });

  test('tracks active runs for status, replay and stop delegation', () => {
    const store = createRecentKernelRunStore({ ttlMs: 60_000 });
    const stopCalls = [];
    store.registerActiveRun('conv-2', {
      id: 'run-9',
      foregroundDone: false,
      fullText: 'hello',
      assistantMessage: { id: 'msg-9', content: 'hello' },
      toolCalls: [{ id: 'tool-1', name: 'Read' }],
      buffer: [{ sequence: 1, line: 'data: one\\n\\n' }],
      stop(payload) {
        stopCalls.push(payload);
      },
    });

    expect(store.kernelRunStatus('conv-2')).toMatchObject({
      active: true,
      foregroundActive: true,
      runId: 'run-9',
      text: 'hello',
      assistantMessageId: 'msg-9',
    });
    expect(store.replayKernelRun('conv-2')).toMatchObject({
      active: true,
      runId: 'run-9',
      eventCount: 1,
    });

    expect(store.stopKernelRun('conv-2', { mode: 'finish' })).toEqual({ ok: true });
    expect(stopCalls).toEqual([{ mode: 'finish' }]);

    store.unregisterActiveRun('conv-2', 'run-9');
    expect(store.kernelRunStatus('conv-2')).toMatchObject({
      active: false,
      foregroundActive: false,
      runId: null,
    });
  });

  test('prepares for a new turn without aborting foreground-done runs', () => {
    const store = createRecentKernelRunStore({ ttlMs: 60_000 });
    let stopCalled = false;
    store.registerActiveRun('conv-keep', {
      id: 'run-keep',
      foregroundDone: true,
      stop() {
        stopCalled = true;
      },
    });
    const logs = [];

    const result = store.prepareForNewTurn({
      conversationId: 'conv-keep',
      debugLog: (line) => logs.push(line),
    });

    expect(result.keptBackgroundRun).toBe(true);
    expect(result.abortedForegroundRun).toBe(false);
    expect(stopCalled).toBe(false);
    expect(store.getActiveRun('conv-keep')?.id).toBe('run-keep');
    expect(logs.some((line) => line.includes('keep background run alive'))).toBe(true);
  });

  test('prepares for a new turn by aborting unfinished foreground runs', () => {
    const store = createRecentKernelRunStore({ ttlMs: 60_000 });
    const stopCalls = [];
    store.registerActiveRun('conv-abort', {
      id: 'run-abort',
      foregroundDone: false,
      stop(payload) {
        stopCalls.push(payload);
      },
    });

    const result = store.prepareForNewTurn({
      conversationId: 'conv-abort',
      debugLog: () => {},
    });

    expect(result.keptBackgroundRun).toBe(false);
    expect(result.abortedForegroundRun).toBe(true);
    expect(stopCalls).toEqual([{ mode: 'abort' }]);
    expect(store.getActiveRun('conv-abort')).toBe(null);
  });

  test('delegates AskUserQuestion replies through the store', async () => {
    const store = createRecentKernelRunStore({ ttlMs: 60_000 });
    const resolveCalls = [];
    const pendingPermissions = new Map([
      ['perm-1', {
        request: {
          permission_request_id: 'perm-1',
          tool_name: 'AskUserQuestion',
          tool_use_id: 'tool-1',
          metadata: {},
          arguments_preview: {
            questions: [{ id: 'q1', question: '继续吗？' }],
          },
        },
      }],
    ]);
    store.registerActiveRun('conv-ask', {
      id: 'run-ask',
      foregroundDone: false,
      pendingPermissions,
      async resolvePermission(payload) {
        resolveCalls.push(payload);
      },
    });

    await expect(store.answerQuestion('conv-ask', {
      permission_request_id: 'perm-1',
      answers: { q1: '继续' },
      annotations: { source: 'desktop' },
      tool_use_id: 'tool-1',
    })).resolves.toEqual({ ok: true });

    expect(resolveCalls).toHaveLength(1);
    expect(resolveCalls[0]).toMatchObject({
      permissionRequestId: 'perm-1',
      decision: 'allow_once',
      decidedBy: 'host',
      metadata: {
        permissionToolOutput: {
          behavior: 'allow',
          toolUseID: 'tool-1',
          decisionClassification: 'user_temporary',
          updatedInput: {
            questions: [{ id: 'q1', question: '继续吗？' }],
            answers: { q1: '继续' },
            annotations: { source: 'desktop' },
          },
        },
      },
    });
  });

  test('drops stale kernel conversations only when requested session changed and no run is active', async () => {
    const store = createKernelConversationStore();
    const disposeCalls = [];
    await store.getOrCreateConversation({
      conversation: {
        id: 'conv-kernel',
        backend_session_id: '',
      },
      createConversation: async () => ({
        sessionId: 'session-old',
        async dispose(reason) {
          disposeCalls.push(reason);
        },
      }),
    });

    const dropped = store.dropStaleConversationForSession({
      conversation: {
        id: 'conv-kernel',
        backend_session_id: 'session-new',
      },
      hasActiveRun: false,
      debugLog: () => {},
      reason: 'desktop_stale_kernel_session',
    });
    expect(dropped).toBe(true);
    expect(disposeCalls).toEqual(['desktop_stale_kernel_session']);
    expect(store.get('conv-kernel')).toBe(null);
  });

  test('reuses kernel runtime promise and clears conversation cache on reset', async () => {
    const conversationStore = createKernelConversationStore();
    const runtimeDisposeCalls = [];
    let createRuntimeCalls = 0;
    const bridge = createKernelRuntimeBridge({
      kernelConversationStore: conversationStore,
      createRuntime: async () => {
        createRuntimeCalls += 1;
        return {
          async dispose(reason) {
            runtimeDisposeCalls.push(reason);
          },
        };
      },
    });

    const runtimeA = await bridge.getKernelRuntime();
    const runtimeB = await bridge.getKernelRuntime();
    expect(runtimeA).toBe(runtimeB);
    expect(createRuntimeCalls).toBe(1);

    await conversationStore.getOrCreateConversation({
      conversation: { id: 'conv-runtime', backend_session_id: '' },
      createConversation: async () => ({
        sessionId: 'session-runtime',
        async dispose() {},
      }),
    });
    expect(conversationStore.get('conv-runtime')).not.toBe(null);

    await bridge.resetKernelRuntime('desktop_runtime_reset');
    expect(runtimeDisposeCalls).toEqual(['desktop_runtime_reset']);
    expect(conversationStore.get('conv-runtime')).toBe(null);
  });

  test('desktop kernel run controller persists visible text and terminal replay state', () => {
    const writes = [];
    const saves = [];
    const store = createRecentKernelRunStore({ ttlMs: 60_000 });
    const conversation = {
      id: 'conv-controller',
      messages: [],
      updated_at: '',
      backend_started: true,
    };
    const controller = createDesktopKernelRunController({
      conversation,
      debugLog: () => {},
      nowIso: () => '2026-05-05T00:00:00.000Z',
      emitKernelChatEvent: (_run, payload) => writes.push(payload),
      saveState: () => saves.push('save'),
      recentKernelRunStore: store,
      normalizePermissionDecision: (value) => value,
      normalizePermissionDecisionSource: (value) => value,
      selectVisibleRunFinalText: ({ lastAssistantText, streamedText, lastResultText }) => lastAssistantText || streamedText || lastResultText || '',
      pruneIncompleteToolCalls: () => {},
      markRunningToolCallsDone: () => {},
      markRunningToolCallsFailed: () => {},
      recordPersistedToolPayload: () => {},
      recordPersistedTaskEvent: () => {},
      resetKernelRuntime: null,
      permissionRequestTimeoutMs: 120000,
    });

    controller.emitVisibleText('hello');
    controller.finishRun('hello done');

    expect(conversation.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'hello done',
    });
    expect(store.kernelRunStatus('conv-controller')).toMatchObject({
      active: false,
      foregroundActive: false,
    });
    expect(store.replayKernelRun('conv-controller')).toMatchObject({
      runId: controller.runId,
      terminalState: 'completed',
    });
    expect(writes.some((payload) => payload?.type === 'message_stop')).toBe(true);
    expect(saves.length).toBeGreaterThan(0);
  });

  test('kernel turn executor resets an empty completed turn with no visible text', async () => {
    const texts = [];
    const dones = [];
    const errors = [];
    const starts = [];
    const conversation = {
      id: 'conv-exec',
      model: 'gpt-5.4',
      backend_session_id: '',
      backend_started: true,
      backend_runtime: '',
      workspace_path: '/tmp/project',
    };
    const kernelConversation = {
      sessionId: 'session-exec',
      onEvent() {
        return () => {};
      },
      async runTurn() {
        return { state: 'completed', stopReason: 'end_turn' };
      },
      async abortTurn() {},
    };

    await runKernelTurn({
      conversation,
      provider: { id: 'provider-1' },
      prompt: 'hello',
      attachments: [],
      workspacePath: '/tmp/project',
      onText: (text) => texts.push(text),
      onDone: (text) => dones.push(text),
      onError: (text) => errors.push(text),
      onStart: (payload) => starts.push(payload),
      onPermissionRequest: () => {},
      onPermissionResolved: () => {},
      onToolUse: () => {},
      onSystemEvent: () => {},
      onForegroundDone: () => {},
      currentWorkspace: '/tmp/project',
      projectRoot: '/tmp/project',
      debugLog: () => {},
      resolveWorkspacePath: (value) => value,
      toRuntimeProviderSelection: () => ({ providerId: 'provider-1', model: 'gpt-5.4' }),
      stripThinking: (value) => value,
      getKernelRuntime: async () => ({ decidePermission: async () => {} }),
      getKernelConversation: async () => kernelConversation,
      buildKernelTurnMetadata: () => ({}),
      resolveTaskOutputFile: () => '',
      extractTaskOutputPath: () => '',
      extractTaskOutputToolPayloads: () => [],
      readTaskOutputFinalMessage: () => null,
      readTaskOutputLatestAssistantMessage: () => null,
      listRecentTaskOutputFiles: () => [],
      extractAgentTaskId: () => '',
      buildTaskEventPayload: () => null,
      projectSemanticTaskNotification: () => null,
      projectSemanticCoordinatorLifecycle: () => null,
      projectSemanticToolProgress: () => null,
      extractSemanticAssistantText: () => '',
      normalizeToolInput: () => ({}),
      stringifyToolValue: (value) => String(value || ''),
      serializePermissionRequest: (value) => value,
      serializePermissionResolved: (value) => value,
      selectVisibleRunFinalText: ({ lastAssistantText, streamedText, lastResultText }) => lastAssistantText || streamedText || lastResultText || '',
      isKernelRuntimeTransportError: () => false,
      isGenericKernelTurnFailureMessage: () => false,
      isKernelTurnErrorStopReason: () => false,
      disposeKernelConversation: async () => {},
      resetKernelRuntime: async () => {},
      nowIso: () => '2026-05-05T00:00:00.000Z',
      saveState: () => {},
      readJson: () => null,
      TASK_OUTPUT_COMPLETION_POLL_MS: 1000,
      TASK_OUTPUT_COMPLETION_MAX_ATTEMPTS: 2,
      TASK_OUTPUT_DISCOVERY_POLL_MS: 1000,
      TASK_OUTPUT_LIVE_PARENT_GRACE_MS: 1500,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(starts).toHaveLength(1);
    expect(conversation.backend_runtime).toBe('kernel');
    expect(dones).toEqual([]);
    expect(errors).toEqual(['Kernel runtime returned no text. Session was reset; please retry.']);
    expect(texts).toEqual([]);
  });

  test('extracts the parent session id from a persisted task output path', () => {
    const sessionId = 'e6b58d90-4816-4d78-8b98-a3c900e87e3f';
    const outputFile = `/private/tmp/claude-501/-Users-apple-Downloads-project/${sessionId}/tasks/a5535e8e12d99d797.output`;

    expect(extractSessionIdFromTaskOutputPath(outputFile)).toBe(sessionId);
    expect(extractSessionIdFromTaskOutputPath('/tmp/not-a-task.output')).toBe('');
  });

  test('finds the latest persisted task parent session from historical tool calls', () => {
    const conversation = {
      messages: [
        {
          role: 'assistant',
          toolCalls: [
            {
              name: 'Agent',
              result: 'output_file: /private/tmp/claude-501/-Users-apple-Downloads-project/11111111-1111-4111-8111-111111111111/tasks/agent-1.output',
            },
          ],
        },
        {
          role: 'assistant',
          toolCalls: [
            {
              name: 'Agent',
              subagent: {
                output_file: '/private/tmp/claude-501/-Users-apple-Downloads-project/22222222-2222-4222-8222-222222222222/tasks/agent-2.output',
              },
            },
          ],
        },
      ],
    };

    expect(findLatestPersistedTaskSessionId(conversation)).toBe('22222222-2222-4222-8222-222222222222');
  });

  test('returns latest persisted task metadata for continuation recovery', () => {
    const outputFile = '/private/tmp/claude-501/-Users-apple-Downloads-project/22222222-2222-4222-8222-222222222222/tasks/agent-2.output';
    const conversation = {
      messages: [
        {
          role: 'assistant',
          toolCalls: [
            {
              name: 'Agent',
              input: { description: 'Old task' },
              subagent: {
                task_id: 'agent-1',
                status: 'completed',
                output_file: '/private/tmp/claude-501/-Users-apple-Downloads-project/11111111-1111-4111-8111-111111111111/tasks/agent-1.output',
              },
            },
          ],
        },
        {
          role: 'assistant',
          toolCalls: [
            {
              name: 'Agent',
              input: { description: 'Scan and summarize project' },
              subagent: {
                task_id: 'agent-2',
                status: 'failed',
                summary: 'Agent failed',
                output_file: outputFile,
              },
            },
          ],
        },
      ],
    };

    expect(findLatestPersistedTaskForContinuation(conversation)).toEqual({
      taskId: 'agent-2',
      outputFile,
      status: 'failed',
      summary: 'Agent failed',
      description: 'Scan and summarize project',
      toolName: 'Agent',
    });
  });

  test('restores historical continuation after an invalid task-id retry session', () => {
    const conversation = {
      backend_session_id: 'e41fce21-de36-464b-9cf8-a6062b8b81fb',
      messages: [
        {
          role: 'assistant',
          toolCalls: [
            {
              name: 'Agent',
              subagent: {
                output_file: '/private/tmp/claude-501/-Users-apple-Downloads-project/e6b58d90-4816-4d78-8b98-a3c900e87e3f/tasks/a5535e8e12d99d797.output',
              },
            },
          ],
        },
        {
          role: 'assistant',
          content: '可以继续，不过你给的 `[id:NaN]` 不是有效任务 ID。',
        },
      ],
    };

    expect(resolveHistoricalContinuationSession(conversation, '继续')).toEqual({
      sessionId: 'e6b58d90-4816-4d78-8b98-a3c900e87e3f',
      reason: 'invalid_task_resume_session',
    });
    expect(resolveHistoricalContinuationSession(conversation, '新的问题')).toBeNull();
  });

  test('projects child tool events from persisted task output jsonl', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hare-task-output-'));
    const outputFile = path.join(tempDir, 'agent-read.jsonl');
    fs.writeFileSync(outputFile, [
      JSON.stringify({
        uuid: 'assistant-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: '/tmp/demo/package.json' } },
          ],
        },
      }),
      JSON.stringify({
        uuid: 'user-1',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-read', content: '{ "scripts": { "build": "vite build" } }' },
          ],
        },
      }),
    ].join('\n'), 'utf8');

    const seenEventKeys = new Set();
    const toolUseIdMap = new Map();
    const toolNameById = new Map();

    const payloads = extractTaskOutputToolPayloads({
      outputFile,
      parentToolUseId: 'desktop-task:agent-1',
      seenEventKeys,
      toolUseIdMap,
      toolNameById,
    });

    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({
      type: 'tool_use_start',
      parent_tool_use_id: 'desktop-task:agent-1',
      tool_use_id: 'desktop-task:agent-1:call-read',
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/demo/package.json' },
    });
    expect(payloads[1]).toMatchObject({
      type: 'tool_use_done',
      parent_tool_use_id: 'desktop-task:agent-1',
      tool_use_id: 'desktop-task:agent-1:call-read',
      tool_name: 'Read',
      content: '{ "scripts": { "build": "vite build" } }',
    });

    expect(extractTaskOutputToolPayloads({
      outputFile,
      parentToolUseId: 'desktop-task:agent-1',
      seenEventKeys,
      toolUseIdMap,
      toolNameById,
    })).toEqual([]);
  });

  test('recursively projects nested agent tool events from persisted task outputs', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hare-task-nested-'));
    const nestedOutputFile = path.join(tempDir, 'nested-agent.jsonl');
    fs.writeFileSync(nestedOutputFile, [
      JSON.stringify({
        uuid: 'nested-assistant-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-grep', name: 'Grep', input: { pattern: 'kernelRunStatus', path: '/tmp/demo/electron/main.cjs' } },
          ],
        },
      }),
      JSON.stringify({
        uuid: 'nested-user-1',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-grep', content: '2862:function kernelRunStatus(conversationId) {' },
          ],
        },
      }),
    ].join('\n'), 'utf8');

    const outputFile = path.join(tempDir, 'top-agent.jsonl');
    fs.writeFileSync(outputFile, [
      JSON.stringify({
        uuid: 'assistant-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-agent', name: 'Agent', input: { description: 'Inspect runtime status' } },
          ],
        },
      }),
      JSON.stringify({
        uuid: 'user-1',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-agent', content: `output_file: ${nestedOutputFile}` },
          ],
        },
      }),
    ].join('\n'), 'utf8');

    const payloads = extractTaskOutputToolPayloads({
      outputFile,
      parentToolUseId: 'desktop-task:parent-agent',
      seenEventKeys: new Set(),
      toolUseIdMap: new Map(),
      toolNameById: new Map(),
    });

    expect(payloads).toHaveLength(4);
    expect(payloads[0]).toMatchObject({
      type: 'tool_use_start',
      parent_tool_use_id: 'desktop-task:parent-agent',
      tool_use_id: 'desktop-task:parent-agent:call-agent',
      tool_name: 'Agent',
    });
    expect(payloads[1]).toMatchObject({
      type: 'tool_use_done',
      parent_tool_use_id: 'desktop-task:parent-agent',
      tool_use_id: 'desktop-task:parent-agent:call-agent',
      tool_name: 'Agent',
    });
    expect(payloads[2]).toMatchObject({
      type: 'tool_use_start',
      parent_tool_use_id: 'desktop-task:parent-agent:call-agent',
      tool_use_id: 'desktop-task:parent-agent:call-agent:call-grep',
      tool_name: 'Grep',
      tool_input: { pattern: 'kernelRunStatus', path: '/tmp/demo/electron/main.cjs' },
    });
    expect(payloads[3]).toMatchObject({
      type: 'tool_use_done',
      parent_tool_use_id: 'desktop-task:parent-agent:call-agent',
      tool_use_id: 'desktop-task:parent-agent:call-agent:call-grep',
      tool_name: 'Grep',
      content: '2862:function kernelRunStatus(conversationId) {',
    });
  });

  test('can preserve raw tool ids when enriching an existing live agent tree', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hare-task-raw-ids-'));
    const outputFile = path.join(tempDir, 'agent-live.jsonl');
    fs.writeFileSync(outputFile, [
      JSON.stringify({
        uuid: 'assistant-1',
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-read', name: 'Read', input: { file_path: '/tmp/demo/package.json' } },
          ],
        },
      }),
      JSON.stringify({
        uuid: 'user-1',
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-read', content: 'ok' },
          ],
        },
      }),
    ].join('\n'), 'utf8');

    const payloads = extractTaskOutputToolPayloads({
      outputFile,
      parentToolUseId: 'call-parent',
      seenEventKeys: new Set(),
      toolUseIdMap: new Map(),
      toolNameById: new Map(),
      useRawToolUseIds: true,
    });

    expect(payloads[0]).toMatchObject({
      type: 'tool_use_start',
      parent_tool_use_id: 'call-parent',
      tool_use_id: 'call-read',
      tool_name: 'Read',
    });
    expect(payloads[1]).toMatchObject({
      type: 'tool_use_done',
      parent_tool_use_id: 'call-parent',
      tool_use_id: 'call-read',
      tool_name: 'Read',
      content: 'ok',
    });
  });
});
