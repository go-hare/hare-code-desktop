# hare-code 公共 Kernel / CLI 能力接口清单

## 1. 目的

本文整理新 `claude-code` 内核要开放的公共接口与语言无关运行协议。

目标不是只适配桌面端。目标是把 CLI 背后的 runtime 能力整体从 CLI host 里抽出来，经由 `@go-hare/hare-code/kernel` 与常驻 runtime wire protocol 暴露给任意 host：CLI、desktop、daemon、remote、worker、Python/Go SDK、未来机器人宿主都走同一套能力面。

边界一句话：

- 要开放：CLI 的行为能力、协议、状态、事件、配置和扩展系统。
- 不开放：Ink/React 终端 UI、按键布局、终端组件渲染细节。

关联执行方案见 `docs/headless-embed-multi-session-plan.md`。

## 2. 当前结论

- JS/TS 进程内公共入口是 `@go-hare/hare-code/kernel`。
- 其它语言 host 的公共入口是常驻 `KernelRuntime` 进程暴露的 wire protocol；Python/Go/机器人 SDK 只是这个协议的 typed client。
- CLI 不再是这些能力的唯一 owner，而是 public kernel 的第一个 host。
- 新增给外部 host 用的能力必须从 `claude-code/src/kernel/index.ts` 导出，并进入 package `./kernel` surface。
- 外部 host 不直接 import `claude-code/src/runtime/*`、`src/bootstrap/*`、`src/screens/*`、`src/commands/*`、`src/utils/plugins/*`、`src/skills/*` 等内部源码路径。
- desktop worker 仍然建议保留，用来隔离进程级全局状态、stdout patch 和多会话并发；但 worker 内部也只 import `@go-hare/hare-code/kernel`。
- desktop worker 对 Electron Main 暴露的控制面不能写成桌面私有协议；它必须是 `KernelRuntimeWireProtocol` 的一个本地传输实现。
- 不恢复旧 SDK 兼容层：不再提供 `createHeadlessChatSession()`、`session.stream()`、`electron/vendor/hare-code-sdk.js` 这套接口。

## 3. 公共入口形态

公共入口分三层：

1. `@go-hare/hare-code/kernel`：JS/TS host 的进程内 API。
2. `KernelRuntimeWireProtocol`：非 JS host、desktop main/worker、机器人 host 共用的语言无关协议。
3. 各语言 SDK：Python/Go/Rust 等只做 wire protocol 的 typed client，不重新实现 CLI runtime 能力。

JS/TS host 示例：

示例：

```ts
import {
  createKernelRuntime,
  createKernelHeadlessController,
  createKernelHeadlessInputQueue,
  createKernelHeadlessProviderEnv,
  normalizeKernelHeadlessEvent,
  resolveKernelRuntimeCapabilities,
  reloadKernelRuntimeCapabilities,
} from '@go-hare/hare-code/kernel'
```

约束：

- `src/kernel/index.ts` 是源码层唯一 public 导出口。
- `@go-hare/hare-code/kernel` 是 package 级 semver surface。
- `src/kernel/*` 叶子模块可以存在，但外部 host 只依赖 package entry。
- runtime 内部 seam 可以继续演进；host contract 由 `@go-hare/hare-code/kernel` 承担。
- `KernelRuntimeWireProtocol` 的 schema 与 `KernelRuntime` / `KernelEvent` 同步演进；新增能力必须同时考虑 package API 与 wire protocol 可序列化形态。

## 4. 要开放的 CLI 能力范围

这些能力都属于 CLI runtime capability，不是桌面专用能力：

- 会话与执行：conversation、turn、stream-json、abort、resume、dispose、multi-session isolation。
- Provider 与认证：Anthropic/OpenAI-compatible provider 配置、model override、auth token/env 映射。
- Command 系统：slash commands、command metadata、command execution、command reload。
- Tool 系统：builtin tools、MCP tools、plugin tools、host-provided tools、tool policy、permission request。
- Hook 系统：SessionStart、PreToolUse、PostToolUse、PostToolUseFailure、Stop、SubagentStop、PreCompact、PostCompact。
- Skills：bundled/user/project/managed/MCP/plugin skills，prompt context 注入和 skill discovery。
- Plugins：marketplace、本地、managed、user/project scope plugins，及其 commands、agents、hooks、MCP、skills、tools。
- MCP：server config、client lifecycle、tool/prompts/resources 暴露、permission bridge。
- Agent / Coordinator / Subagent：agents、coordinator mode、subagent spawn、task tools、owned files/write guard、worker result。
- Pet / Companion：companion state、hatch/rehatch/mute/unmute/pet、reaction side request、reaction event。
- Kairos / Proactive：常驻助手、tick、brief、channel/webhook event、dream/memory、push notification。
- Memory / Context / Compaction：project/user memory、session transcript、context assembly、auto/manual compaction hooks。
- Session / Logs / Background：session list/resume、logs、background/daemon worker lifecycle。
- Events：把 CLI 内部 message、tool、hook、plugin、skill、companion、Kairos 状态统一转成 public kernel events。

## 5. Public Runtime 总入口

建议新增：`claude-code/src/kernel/runtime.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export function createKernelRuntime(
  options: KernelRuntimeOptions,
): Promise<KernelRuntime>

export type KernelRuntime = {
  readonly id: string
  readonly capabilities: KernelResolvedRuntimeCapabilities
  start(): Promise<void>
  createConversation(options: KernelConversationOptions): Promise<KernelConversation>
  reloadCapabilities(request?: KernelRuntimeCapabilityReloadRequest): Promise<KernelResolvedRuntimeCapabilities>
  dispose(reason?: string): Promise<void>
  onEvent(handler: (event: KernelEvent) => void): () => void
}
```

语义：

- `createKernelRuntime()` 是 CLI runtime 能力总入口。
- `createKernelHeadlessController()` 是 conversation/headless execution 的专用 facade，可以由 runtime 创建，也可以单独用于轻量 headless embed。
- CLI、desktop、daemon、remote host 的差异通过 `KernelRuntimeOptions.host` 和 capability intent 表达，而不是通过 import 不同内部模块表达。

## 6. 常驻 Runtime Wire Protocol

建议新增：

- `claude-code/src/kernel/wireProtocol.ts`
- `claude-code/src/entrypoints/kernel-runtime.ts` 或等价 runner

必须从 `@go-hare/hare-code/kernel` 导出协议类型，并提供一个可启动的常驻 runtime runner。

`KernelRuntimeWireProtocol` 是语言无关 contract，不是桌面端私有协议。它服务于：

- desktop main <-> conversation worker。
- Python / Go / Rust SDK。
- 机器人宿主进程。
- 未来 daemon / remote / worker host。

协议消息必须是 JSON serializable，字段使用稳定 wire name，不暴露 TypeScript class、React/Ink object、runtime internal object、AbortController 或 bootstrap singleton。

### 6.1 Host -> KernelRuntime

```ts
export type KernelRuntimeCommand =
  | KernelRuntimeInitCommand
  | KernelRuntimeCreateConversationCommand
  | KernelRuntimeRunTurnCommand
  | KernelRuntimeAbortTurnCommand
  | KernelRuntimeDisposeConversationCommand
  | KernelRuntimeReloadCapabilitiesCommand
  | KernelRuntimePublishHostEventCommand
  | KernelRuntimeSubscribeEventsCommand
  | KernelRuntimePingCommand
```

最小命令集合：

- `init_runtime`
  - 字段：`requestId`、`host`、`workspacePath`、`provider`、`auth`、`model`、`capabilities`、`metadata`。
- `create_conversation`
  - 字段：`requestId`、`conversationId`、`workspacePath`、`sessionMeta`、`capabilityIntent`。
- `run_turn`
  - 字段：`requestId`、`conversationId`、`turnId`、`prompt`、`attachments`、`metadata`。
- `abort_turn`
  - 字段：`requestId`、`conversationId`、`turnId`、`reason`。
- `dispose_conversation`
  - 字段：`requestId`、`conversationId`、`reason`。
- `reload_capabilities`
  - 字段：`requestId`、`scope`、`capabilities`。
- `publish_host_event`
  - 字段：`requestId`、`event`。
- `subscribe_events`
  - 字段：`requestId`、`conversationId?`、`sinceEventId?`、`filters?`。
- `ping`
  - 字段：`requestId`。

### 6.2 KernelRuntime -> Host

```ts
export type KernelRuntimeEnvelope =
  | KernelRuntimeAckEnvelope
  | KernelRuntimeEventEnvelope
  | KernelRuntimeErrorEnvelope
  | KernelRuntimePongEnvelope
```

最小事件集合：

- `runtime_ready`
- `conversation_ready`
- `turn_started`
- `event`
  - 字段：`eventId`、`conversationId?`、`turnId?`、`event: KernelEvent`。
- `turn_completed`
- `turn_aborted`
- `conversation_disposed`
- `capabilities_reloaded`
- `error`
- `pong`

### 6.3 传输与兼容

- 本地 desktop worker 可以用 stdin/stdout NDJSON、Node IPC 或 fork IPC 承载同一协议。
- 其它语言 SDK 默认连接常驻 kernel process；传输可以是 HTTP、WebSocket、stdio NDJSON 或 Unix socket，但消息 schema 必须一致。
- 若控制事件和 runtime stream 共用 stdout，必须使用 envelope 分流，例如 `source: "kernel_runtime"`，不能把 raw `StdoutMessage` 当作协议层事件。
- `KernelEvent` 是唯一语义事件面；desktop SSE、Python callback、机器人事件循环都只是 host 映射。
- 协议必须支持 event replay：`eventId` 单调递增，host 可通过 `sinceEventId` 恢复断线后的事件。
- 同一 conversation 同一时间只允许一个 active turn；并发 turn 必须返回 `busy` 或要求 host 先 `abort_turn`。

### 6.4 与 JS API 的关系

- `createKernelRuntime()` 是 JS in-process API。
- `KernelRuntimeWireProtocol` 是同一语义 contract 的 out-of-process 形态。
- JS worker runner 可以用 `createKernelRuntime()` 实现 wire protocol。
- Python/Go/机器人 SDK 只认 wire protocol，不 import TS package，不读取 `src/*`。

## 7. 会话与 Headless 执行接口

建议文件：

- `claude-code/src/kernel/headlessController.ts`
- `claude-code/src/kernel/headlessInputQueue.ts`
- `claude-code/src/kernel/headlessProvider.ts`
- `claude-code/src/kernel/events.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelHeadlessController = {
  readonly sessionId: string
  readonly state: KernelHeadlessControllerState
  start(): Promise<void>
  runTurn(request: KernelHeadlessRunTurnRequest): Promise<KernelHeadlessTurnStarted>
  abortTurn(request?: KernelHeadlessAbortRequest): Promise<void>
  dispose(reason?: string): Promise<void>
  onEvent(handler: (event: KernelHeadlessEvent) => void): () => void
}

export type KernelHeadlessInputQueue = AsyncIterable<string> & {
  pushUserTurn(turn: KernelHeadlessQueuedUserTurn): void
  pushInterrupt(request: KernelHeadlessQueuedInterrupt): void
  close(reason?: string): void
}
```

要求：

- `abortTurn()` 优先通过 SDK control `interrupt` 实现。
- controller 保证同一 conversation 单 active turn。
- raw `StdoutMessage` 必须归一化为 public `KernelHeadlessEvent`，不能要求 host 理解 runtime 内部对象。

## 8. Runtime Capabilities

建议文件：`claude-code/src/kernel/capabilities.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelRuntimeCapabilitiesInput = {
  commands?: boolean | KernelCommandsCapabilityOptions
  tools?: boolean | KernelToolsCapabilityOptions
  hooks?: boolean | KernelHooksCapabilityOptions
  skills?: boolean | KernelSkillsCapabilityOptions
  plugins?: boolean | KernelPluginsCapabilityOptions
  mcp?: boolean | KernelMcpCapabilityOptions
  agents?: boolean | KernelAgentsCapabilityOptions
  companion?: boolean | KernelCompanionCapabilityOptions
  kairos?: boolean | KernelKairosCapabilityOptions
  memory?: boolean | KernelMemoryCapabilityOptions
  sessions?: boolean | KernelSessionsCapabilityOptions
}

export type KernelResolvedRuntimeCapabilities = {
  commands: KernelCommandRegistry
  tools: KernelToolCatalog
  hooks: KernelHookRegistry
  skills: KernelSkillCatalog
  plugins: KernelPluginManager
  mcp: KernelMcpManager
  agents: KernelAgentRegistry
  companion: KernelCompanionRuntime | null
  kairos: KernelKairosRuntime | null
  memory: KernelMemoryManager
  sessions: KernelSessionManager
}
```

要求：

- `KernelRuntimeOptions.capabilities` 接收 host intent；具体加载和合并由 kernel 内部 resolver 完成。
- `reloadKernelRuntimeCapabilities()` 是通用 reload，不绑定 CLI `/reload-plugins` 命令。
- capability resolver 可以复用现有 CLI 加载逻辑，但不能要求 host import CLI 内部路径。

## 9. Command 系统

建议文件：`claude-code/src/kernel/commands.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelCommandRegistry = {
  list(): KernelCommandDescriptor[]
  resolve(name: string): KernelCommandDescriptor | null
  execute(request: KernelCommandExecuteRequest): Promise<KernelCommandResult>
  reload(request?: KernelCommandReloadRequest): Promise<KernelCommandRegistrySnapshot>
}
```

范围：

- 内置 slash commands。
- plugin commands。
- skills/commands 目录派生出的命令。
- host-provided commands。

要求：

- command metadata、参数 schema、执行结果进入 public API。
- CLI 的菜单、快捷键、Ink 渲染不进入 public API。

## 10. Tool / Permission / MCP 系统

建议文件：

- `claude-code/src/kernel/tools.ts`
- `claude-code/src/kernel/permissions.ts`
- `claude-code/src/kernel/mcp.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelToolCatalog = {
  list(): KernelToolDescriptor[]
  resolve(name: string): KernelToolDescriptor | null
  withPolicy(policy: KernelToolPolicy): KernelToolCatalog
}

export type KernelPermissionBridge = {
  request(request: KernelPermissionRequest): Promise<KernelPermissionDecision>
}

export type KernelMcpManager = {
  listServers(): KernelMcpServerDescriptor[]
  listTools(): KernelToolDescriptor[]
  connect(request?: KernelMcpConnectRequest): Promise<KernelMcpConnectionSnapshot>
  disconnect(serverName: string): Promise<void>
}
```

范围：

- builtin tools。
- MCP tools。
- plugin tools。
- host-provided tools。
- tool allow/deny policy。
- permission request/decision schema。

要求：

- permission UI 属于 host；permission request/decision schema 属于 kernel。
- MCP server lifecycle 与 tool catalog 要能被 host 查询和 reload。

## 11. Hooks 系统

建议文件：`claude-code/src/kernel/hooks.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelHookRegistry = {
  list(eventName?: KernelHookEventName): KernelHookDefinition[]
  register(hook: KernelHookDefinition): Promise<KernelHookRegistration>
  unregister(registrationId: string): Promise<void>
  run(request: KernelHookRunRequest): Promise<KernelHookRunResult>
}

export type KernelHookEventName =
  | 'SessionStart'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'
```

要求：

- hooks 可以来自 settings、agent frontmatter、plugins、host-provided hooks。
- `registeredHooks` 进入 runtime bootstrap seam，不让 host 直接写 bootstrap singleton。
- hook 运行过程和结果要输出 public event。

## 12. Skills / Plugins 系统

建议文件：

- `claude-code/src/kernel/skills.ts`
- `claude-code/src/kernel/plugins.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelSkillCatalog = {
  list(): KernelSkillDescriptor[]
  resolve(name: string): KernelSkillDescriptor | null
  getPromptContext(names?: string[]): Promise<KernelSkillPromptContext>
  reload(request?: KernelSkillReloadRequest): Promise<KernelSkillCatalogSnapshot>
}

export type KernelPluginManager = {
  list(): KernelPluginDescriptor[]
  getErrors(): KernelPluginError[]
  reload(request?: KernelPluginReloadRequest): Promise<KernelPluginReloadResult>
}
```

要求：

- skills 加载覆盖 bundled、user、project、managed、MCP、plugin skills。
- plugins 加载覆盖 marketplace、本地、managed、user/project scope plugins。
- plugin 产生的 commands、agents、hooks、MCP、skills、tools 必须进入统一 capability resolver。
- loading errors 必须通过 public manager API 和 public event 暴露。

## 13. Agents / Coordinator / Task 系统

建议文件：

- `claude-code/src/kernel/agents.ts`
- `claude-code/src/kernel/tasks.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelAgentRegistry = {
  list(): KernelAgentDescriptor[]
  resolve(name: string): KernelAgentDescriptor | null
  spawn(request: KernelAgentSpawnRequest): Promise<KernelAgentHandle>
}

export type KernelTaskManager = {
  create(request: KernelTaskCreateRequest): Promise<KernelTask>
  update(request: KernelTaskUpdateRequest): Promise<KernelTask>
  list(filter?: KernelTaskListFilter): Promise<KernelTask[]>
  get(taskId: string): Promise<KernelTask | null>
}
```

范围：

- built-in agents。
- project/user/plugin agents。
- coordinator mode。
- subagent spawn。
- task tools。
- owned files / write guard。
- worker result validation。

要求：

- coordinator prompt、allowed tools、task APIs、write guard 必须作为同一个 contract 验证。
- host 可以自己展示 agent/team UI；kernel 负责 agent/task 行为和事件。

## 14. Pet / Companion 系统

建议文件：`claude-code/src/kernel/companion.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelCompanionRuntime = {
  getState(): Promise<KernelCompanionState | null>
  dispatch(action: KernelCompanionAction): Promise<KernelCompanionState | null>
  reactToTurn(request: KernelCompanionReactionRequest): Promise<void>
  onEvent(handler: (event: KernelCompanionEvent) => void): () => void
}
```

范围：

- companion state。
- hatch / rehatch。
- mute / unmute。
- pet action。
- turn 后 reaction。

要求：

- companion reaction 是 side request，不阻塞主 turn。
- reaction 失败必须以 public event 或 error event 可见，不能静默吞掉。
- sprite、头像、气泡、终端像素画属于 host renderer，不属于 kernel API。

## 15. Kairos / Proactive 系统

建议文件：`claude-code/src/kernel/kairos.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelKairosRuntime = {
  getStatus(): KernelKairosStatus
  enqueueEvent(event: KernelKairosExternalEvent): Promise<void>
  tick(request?: KernelKairosTickRequest): Promise<void>
  suspend(reason?: string): Promise<void>
  resume(reason?: string): Promise<void>
  onEvent(handler: (event: KernelKairosEvent) => void): () => void
}
```

范围：

- `kairosEnabled`。
- proactive tick。
- brief 输出。
- channel/webhook event。
- dream / memory consolidation。
- push notification。
- long-running assistant mode。

要求：

- Kairos 不应只是 boolean flag；它要成为可观察、可暂停、可恢复、可注入事件的 public capability。
- host 决定展示为通知、日志、频道消息、后台任务还是 UI badge。

## 16. Memory / Context / Session 系统

建议文件：

- `claude-code/src/kernel/memory.ts`
- `claude-code/src/kernel/context.ts`
- `claude-code/src/kernel/sessions.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelMemoryManager = {
  list(): Promise<KernelMemoryDescriptor[]>
  read(id: string): Promise<KernelMemoryDocument>
  update(request: KernelMemoryUpdateRequest): Promise<KernelMemoryDocument>
}

export type KernelSessionManager = {
  list(filter?: KernelSessionListFilter): Promise<KernelSessionDescriptor[]>
  resume(sessionId: string): Promise<KernelConversation>
  getTranscript(sessionId: string): Promise<KernelTranscript>
}
```

范围：

- AGENTS.md / project context。
- user/project memory。
- transcript。
- compaction。
- session list/resume。
- background/daemon session status。

要求：

- context assembly 和 compaction hook 结果要可观察。
- host 可以自己展示 memory/session UI；kernel 负责数据和行为 contract。

## 17. Event Surface

建议文件：`claude-code/src/kernel/events.ts`

必须从 `@go-hare/hare-code/kernel` 导出。

```ts
export type KernelEvent =
  | KernelHeadlessEvent
  | KernelCommandEvent
  | KernelToolEvent
  | KernelPermissionEvent
  | KernelHookEvent
  | KernelSkillEvent
  | KernelPluginEvent
  | KernelMcpEvent
  | KernelAgentEvent
  | KernelTaskEvent
  | KernelCompanionEvent
  | KernelKairosEvent
  | KernelMemoryEvent
  | KernelSessionEvent
  | KernelErrorEvent
```

要求：

- 不把 CLI 内部 message/render object 泄漏给 host。
- 文本流、工具进度、权限请求、hook 结果、plugin error、companion reaction、Kairos tick 都通过统一 event surface 出来。
- 桌面端 SSE 只是 `KernelEvent` 的一个 host 映射，不是内核协议本身。

## 18. 不开放的内容

明确不开放：

- Ink / React component。
- 终端快捷键与布局。
- CLI 菜单状态机。
- bootstrap singleton 的直接读写。
- runtime internal abort controller。
- `HeadlessManagedSession` 等内部实现对象。
- 旧 SDK 兼容层。

## 19. 文件级接口清单

### claude-code

- `claude-code/src/kernel/runtime.ts`
  - 新增 `createKernelRuntime()` 总入口。
- `claude-code/src/kernel/wireProtocol.ts`
  - 新增 `KernelRuntimeWireProtocol` 的命令、响应、错误和 envelope schema。
- `claude-code/src/kernel/capabilities.ts`
  - 新增 capability resolver / reload。
- `claude-code/src/kernel/headlessController.ts`
  - 新增 headless conversation facade。
- `claude-code/src/kernel/headlessInputQueue.ts`
  - 新增 public input queue。
- `claude-code/src/kernel/headlessProvider.ts`
  - 新增 provider env/run options helper。
- `claude-code/src/kernel/events.ts`
  - 新增统一 public event union。
- `claude-code/src/kernel/commands.ts`
  - 开放 CLI command runtime。
- `claude-code/src/kernel/tools.ts`
  - 开放 tool catalog。
- `claude-code/src/kernel/permissions.ts`
  - 开放 permission request/decision schema。
- `claude-code/src/kernel/mcp.ts`
  - 开放 MCP manager。
- `claude-code/src/kernel/hooks.ts`
  - 开放 hook registry。
- `claude-code/src/kernel/skills.ts`
  - 开放 skill catalog。
- `claude-code/src/kernel/plugins.ts`
  - 开放 plugin manager。
- `claude-code/src/kernel/agents.ts`
  - 开放 agents/coordinator/subagent registry。
- `claude-code/src/kernel/tasks.ts`
  - 开放 task manager。
- `claude-code/src/kernel/companion.ts`
  - 开放 pet/companion runtime。
- `claude-code/src/kernel/kairos.ts`
  - 开放 Kairos/proactive runtime。
- `claude-code/src/kernel/memory.ts`
  - 开放 memory manager。
- `claude-code/src/kernel/context.ts`
  - 开放 context assembly facade。
- `claude-code/src/kernel/sessions.ts`
  - 开放 session/log/transcript manager。
- `claude-code/src/kernel/index.ts`
  - 统一导出上述 public API。
- `claude-code/src/entrypoints/kernel-runtime.ts`
  - 新增常驻 runtime runner，承载 wire protocol，可供其它语言 SDK 与本地 worker 启动。

### hare-code-desktop

- `hare-code-desktop/electron/kernel-runtime-manager.cjs`
  - conversation -> worker 的注册和调度。
- `hare-code-desktop/electron/kernel-worker-wrapper.cjs`
  - worker 启停、stdout/IPC 处理；worker runner 只 import `@go-hare/hare-code/kernel`。
- `hare-code-desktop/electron/kernel-protocol.cjs`
  - Electron Main 到 worker 的本地传输封装，schema 必须复用 `KernelRuntimeWireProtocol`。
- `hare-code-desktop/electron/kernel-event-mapper.cjs`
  - public `KernelEvent` -> 当前前端 SSE event。
- `hare-code-desktop/electron/main.cjs`
  - 删除旧 SDK session 管理，接入 worker registry。

## 20. 验证要求

### claude-code

- source-level：`src/kernel/*` 覆盖 runtime、capabilities、controller、events、commands、tools、hooks、skills、plugins、MCP、agents、companion、Kairos。
- wire-level：`KernelRuntimeWireProtocol` 的 command/envelope/error/event replay schema 有 contract 测试。
- package-level：构建后 smoke `import('@go-hare/hare-code/kernel')`，确认新增导出真实可用。
- runner-level：常驻 `kernel-runtime` runner 可启动、响应 `init_runtime` / `ping`，并能通过协议创建 conversation。
- CLI parity：CLI 使用 public kernel capability 后，原有 commands/tools/hooks/skills/plugins/MCP/agents/pet/Kairos 行为不回退。
- host isolation：desktop/worker 测试只能依赖 `@go-hare/hare-code/kernel`，不能 import `claude-code/src/*`。

### hare-code-desktop

- worker wrapper 测试只能依赖 `@go-hare/hare-code/kernel`。
- `kernel-protocol.cjs` 测试只能验证 `KernelRuntimeWireProtocol` 的传输封装，不定义桌面私有 schema。
- `ConversationRuntimeRegistry` 生命周期测试。
- `TurnStreamRegistry` ring buffer / reconnect 测试。
- `KernelEvent` -> desktop SSE mapper 测试。
- stop 只作用于目标 worker 的测试。

## 21. 执行顺序

1. 先定义 `KernelRuntime`、`KernelRuntimeCapabilities`、`KernelEvent`、`KernelRuntimeWireProtocol` 四个总 contract。
2. 新增常驻 `kernel-runtime` runner，让非 JS host 有稳定进程边界。
3. 把 headless controller/input queue/provider/events 接到总 contract 和 wire protocol。
4. 依次开放 commands、tools/permissions/MCP、hooks、skills/plugins、agents/tasks。
5. 再开放 companion、Kairos、memory/context/sessions。
6. 增加 package-level smoke，确保 `@go-hare/hare-code/kernel` 可导入新增接口。
7. 增加 runner/wire smoke，确保常驻 runtime 可被 Python/Go/机器人 host 通过协议使用。
8. 桌面端实现 worker wrapper，worker 代码只 import `@go-hare/hare-code/kernel`，对 main 暴露 `KernelRuntimeWireProtocol`。
9. 桌面端替换旧 SDK session 路径，保留 SSE/reconnect 的外层行为。
