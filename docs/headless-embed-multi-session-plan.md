# hare-code-desktop 多会话并发 Headless Embed 方案

## 1. 需求摘要

- 目标：桌面端继续走 `headless embed`，但支持多会话并发。
- 上层目标：把 CLI 背后的 runtime 能力开放为 `@go-hare/hare-code/kernel` 公共能力面；桌面端只是第一个外部 host，不是唯一目标。
- 上层目标：同时定义常驻 `KernelRuntimeWireProtocol`，让 Python、Go、机器人宿主等非 JS host 也能连接同一套 runtime 能力。
- 约束：不兼容旧 SDK 形态，不再依赖旧 SDK bundle、`electron/vendor/hare-code-sdk.js`、`createHeadlessChatSession()`、`session.stream()` 这套旧接口。
- 约束：不采用公开 `direct-connect server/ws` 作为桌面端主接入路径，桌面端仍由 Electron 主进程统一调度。
- 约束：保留当前渲染层到本地 Express API 的交互形态，尽量不重写前端流式消费逻辑。
- 约束：第一阶段桌面迁移只追求文本流式主链、停止、删除、重连、多会话隔离闭环；但内核接口规划必须覆盖 CLI runtime 全能力，不能把 tools/hooks/skills/plugins/pet/Kairos 等写成后续桌面私有补丁。
- 约束：桌面 worker 协议必须复用 `KernelRuntimeWireProtocol` 的 schema；桌面端只能做传输和 SSE 映射，不能另起一套桌面私有 runtime 协议。

## 2. 当前现状

- 桌面端当前在 Electron 主进程内直接加载本地 vendor SDK。`activeRuns` 同时承担两类职责：`sdk-session:${conversationId}` 保存旧 SDK session，`conversationId` 保存当前 turn 的 SSE buffer/emitter/stop handle。参考 `hare-code-desktop/electron/main.cjs:31`、`hare-code-desktop/electron/main.cjs:806`、`hare-code-desktop/electron/main.cjs:816`、`hare-code-desktop/electron/main.cjs:842`、`hare-code-desktop/electron/main.cjs:1855`。
- 当前桌面端的普通聊天旧链路是 `POST /api/chat -> runViaSdk() -> session.stream() -> SSE 回写前端`。停止、重连、状态查询围绕 `activeRuns.get(conversation.id)` 里的 turn handle/buffer 实现；删除会话额外清理 `sdk-session:${conversationId}`。参考 `hare-code-desktop/electron/main.cjs:882`、`hare-code-desktop/electron/main.cjs:892`、`hare-code-desktop/electron/main.cjs:1788`、`hare-code-desktop/electron/main.cjs:1800`、`hare-code-desktop/electron/main.cjs:1801`、`hare-code-desktop/electron/main.cjs:1806`、`hare-code-desktop/electron/main.cjs:1807`、`hare-code-desktop/electron/main.cjs:1842`。
- 桌面端构建链仍然假设 sibling 仓库名是 `hare-code`，并且同步旧 SDK bundle。当前脚本实际查找并复制的是 `dist/code.js` 到 `electron/vendor/hare-code-sdk.js`，不是 `dist/sdk.js`。参考 `hare-code-desktop/package.json:13`、`hare-code-desktop/README.md:3`、`hare-code-desktop/README.md:30`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:7`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:180`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:230`。
- `claude-code` 当前的稳定对外入口已经切到 `kernel`，包级公开导出是 `@go-hare/hare-code/kernel`，而不是 `sdk.js`。参考 `claude-code/README.md:14`、`claude-code/README.md:50`、`claude-code/package.json:31`。
- `claude-code` 当前构建只显式打 `cli` 和 `kernel` 两个 entrypoint，没有桌面 worker entrypoint。参考 `claude-code/build.ts:19`。
- `claude-code` 的 public headless session API 当前只有 `run/getState/setState`，没有 `abort`；但底层 headless runtime 输入支持 `AsyncIterable<string>`，且已有 SDK control `interrupt` 消息。参考 `claude-code/src/kernel/headless.ts:100`、`claude-code/src/kernel/headless.ts:229`、`claude-code/src/runtime/capabilities/execution/HeadlessRuntime.ts:11`、`claude-code/src/entrypoints/sdk/controlSchemas.ts:97`、`claude-code/src/runtime/capabilities/execution/internal/headlessRuntimeLoop.ts:2789`。
- `claude-code` 的 `stream-json` 输出顶层消息不是直接的 `content_block_delta`，而是 `StdoutMessage`；文本增量通常表现为顶层 `stream_event`，其内部 `event.type` 才是 `content_block_delta`。参考 `claude-code/src/entrypoints/sdk/coreSchemas.ts:1497`、`claude-code/src/entrypoints/sdk/controlSchemas.ts:642`。

## 3. 关键技术判断

### 3.1 不采用“同一个 Electron 主进程里直接并发跑多个 headless session”

- `claude-code` 仍存在进程级全局状态单例 `STATE`。参考 `claude-code/src/bootstrap/state.ts:429`。
- session identity、cwd、project root、client type 等关键上下文仍通过全局状态切换。参考 `claude-code/src/bootstrap/state.ts:468`、`claude-code/src/bootstrap/state.ts:515`、`claude-code/src/bootstrap/state.ts:1073`。
- headless runtime 当前使用的 bootstrap provider 仍然代理到上述全局状态。参考 `claude-code/src/runtime/core/state/bootstrapProvider.ts:99`、`claude-code/src/runtime/core/state/bootstrapProvider.ts:117`、`claude-code/src/runtime/core/state/bootstrapProvider.ts:120`、`claude-code/src/runtime/core/state/bootstrapProvider.ts:123`。
- `stream-json` 模式会 patch `process.stdout.write`，这在单进程多并发下天然存在串流污染风险。参考 `claude-code/src/utils/streamJsonStdoutGuard.ts:49`、`claude-code/src/utils/streamJsonStdoutGuard.ts:55`、`claude-code/src/utils/streamJsonStdoutGuard.ts:59`。

结论：当前代码基线下，不应把“多会话并发”建立在同一个 Electron 主进程内的多 headless session 上。

### 3.2 采用“Electron 主进程调度 + 每会话独立 kernel worker 子进程”

- 每个 conversation 独占一个 worker 进程，天然隔离全局状态、stdout patch 和会话生命周期。
- 主进程只负责调度、缓冲、SSE 转发、重连、状态查询和回收。
- 这条路仍然属于 `headless embed`，因为桌面端自己拉起本地 worker 并直接嵌入 kernel，不依赖公开 server/ws。
- worker 传输优先复用当前 desktop 已经使用的子进程模型：父进程写 `KernelRuntimeWireProtocol` 控制消息，子进程输出 `KernelRuntimeWireProtocol` envelope / NDJSON；是否使用 Node/Electron `fork()` 的 IPC，要先经过 worker 产物兼容性 smoke 后再定。

### 3.3 不采用旧 SDK 兼容层

- 用户要求“不兼容旧的”，所以不新增 `createHeadlessChatSession()` 之类的旧接口壳。
- 新桌面端直接面向新的 worker 协议和 kernel 会话模型。

### 3.4 worker 协议必须提升为 KernelRuntimeWireProtocol

- `init_session`、`run_turn`、`abort_turn`、`dispose_session` 这类桌面 worker 消息应收敛为通用 `init_runtime`、`create_conversation`、`run_turn`、`abort_turn`、`dispose_conversation`。
- 这套协议不是 Electron 专属；Python SDK、Go SDK 和机器人宿主也应该能用同一套 schema 连接常驻 kernel process。
- Electron Main 可以选择 stdin/stdout、IPC 或 socket 作为本地传输，但不能改变命令、响应、错误和事件 envelope 的语义。
- `KernelEvent` 是协议语义事件面；桌面 SSE、Python callback、机器人事件循环都只是 host 映射。

### 3.5 不把 raw runtime event 和 desktop SSE event 混成一层

- worker 输出层以 `KernelRuntimeWireProtocol` envelope 为准；当前 `StdoutMessage` / `stream-json` 只能作为实现侧输入，被归一化为 `KernelEvent` 后再给 host。
- Electron Main 负责把 `KernelEvent` 归一化为前端当前能消费的 SSE 事件。
- 第一阶段桌面端只要求 `content_block_delta`、`message_stop`、`error`、`[DONE]` 等现有文本路径保持兼容。

## 4. ADR

### Decision

采用“Electron 主进程调度 + 每会话独立 kernel worker 子进程”的多会话并发 headless embed 方案。

### Drivers

- 当前 `claude-code` 存在进程级全局状态，不适合同进程多会话并发。
- 用户明确要求不兼容旧 SDK。
- 桌面端当前渲染层与本地 API 的分层已经存在，主进程适合继续扮演 runtime 调度层。

### Alternatives Considered

- 方案 A：同一个 Electron 主进程里直接并发跑多个 headless session。
- 方案 B：改走 `direct-connect server/ws`。
- 方案 C：Electron 主进程调度 + 每会话独立 kernel worker 子进程。

### Why Chosen

- 方案 A 与当前 `claude-code` 的全局状态模型冲突，工程风险高。
- 方案 B 不符合当前“继续 headless embed”的路线选择。
- 方案 C 兼顾了并发隔离、现有桌面端分层复用和后续演进空间。

### Consequences

- 需要新增 `KernelRuntimeWireProtocol` 与 worker 调度器；desktop worker 只是该协议的本地传输实现。
- 需要在 `claude-code` 的 `@go-hare/hare-code/kernel` 公共入口补齐 CLI runtime 能力面：runtime、capabilities、events、controller、commands、tools、permissions、MCP、hooks、skills、plugins、agents、tasks、companion、Kairos、memory、sessions。
- 停止当前生成不再通过旧 session 实例方法完成，而是通过 worker 控制面完成。
- `activeRuns` 需要拆分职责，不能把 worker 生命周期和当前 turn SSE buffer 继续混在同一个 Map 里。
- worker runner 需要先验证 Node/Electron 运行兼容性；若不兼容，第一阶段按 Bun 子进程落地。

### Follow-ups

- 第一阶段先跑通文本流式对话、停止、删除、重连。
- 第二阶段再补工具事件、文档事件、代码执行事件等富事件映射。

## 5. 目标架构

### 5.1 进程模型

- Renderer
  - 继续请求本地 Express API。
- Electron Main
  - 持有 `ConversationRuntimeRegistry`。
  - 持有 `TurnStreamRegistry`。
  - 负责 worker 生命周期、`KernelRuntimeWireProtocol` 传输、事件缓冲、SSE 转发、状态查询。
- Conversation Worker
  - 每个 conversation 一个独立子进程。
  - 进程内加载 `@go-hare/hare-code/kernel`。
  - 持有该会话独立的 environment、store、kernel session 和 runtime input queue。
  - 对外只暴露 `KernelRuntimeWireProtocol`，不暴露 runtime internal object。

职责拆分：

- `ConversationRuntimeRegistry`
  - conversation -> worker。
  - 负责 lazy spawn、init、dispose、crash 标记、idle timeout、worker count limit。
- `TurnStreamRegistry`
  - conversation/current turn -> SSE buffer/emitter/stop handle。
  - 负责 `/stream-status`、`/reconnect`、当前 turn 结束后的 buffer 清理策略。

这个拆分替代当前 `activeRuns` 的混合职责，但不要求前端重写 SSE 消费模型。

### 5.2 数据流

- `Renderer -> POST /api/chat -> Electron Main`
- `Electron Main -> worker(KernelRuntimeWireProtocol: run_turn)`
- `worker -> IPC 或 stdin/stdout 输出 KernelRuntime envelope`
- `KernelRuntime envelope -> KernelEvent`
- `Electron Main -> KernelEvent 映射为现有 SSE 事件 -> Renderer`

### 5.3 生命周期

- 创建 conversation 时不必立刻起 worker。
- 第一次发消息时 lazy spawn worker。
- 同一 conversation 后续 turn 复用同一个 worker。
- 删除 conversation 或明确关闭时销毁 worker。
- worker 异常退出时，主进程更新状态并允许前端重试重建。
- 同一 conversation 同一时间只允许一个 active turn；如果收到第二个 `run_turn`，主进程应返回 busy 或先显式 abort 当前 turn，不能让同一 worker 内并行跑两个 turn。

## 6. 内核接口清单

接口边界已拆到独立文档：[`headless-embed-kernel-interfaces.md`](headless-embed-kernel-interfaces.md)。

本文后续只引用该文档的结论：CLI runtime 能力要通过 `@go-hare/hare-code/kernel` 与 `KernelRuntimeWireProtocol` 公共化。桌面 worker 通过 package API 使用内核；Electron Main、Python SDK、Go SDK、机器人 host 通过 wire protocol 使用常驻 runtime。需要新增的 runtime、wireProtocol、capabilities、events、controller、commands、tools、permissions、MCP、hooks、skills、plugins、agents、tasks、companion、Kairos、memory、sessions 都从 `claude-code/src/kernel/index.ts` 导出并进入 package `./kernel` surface。桌面端不依赖 `src/runtime/*`、`src/bootstrap/*`、`src/screens/*`、`src/commands/*` 等内部路径。

## 7. 协议设计

### 7.1 KernelRuntimeWireProtocol 命令

控制消息不是桌面宿主内部协议，而是 `KernelRuntimeWireProtocol` 的本地传输形态。第一阶段可以按 JSON line 或 IPC message 承载，但 schema 必须保持可序列化、语言无关，并和 `headless-embed-kernel-interfaces.md` 中的 wire protocol 对齐。

- `init_runtime`
  - 字段：`requestId`、`host`、`workspacePath`、`provider`、`auth`、`model`、`capabilities`、`metadata`
- `create_conversation`
  - 字段：`requestId`、`conversationId`、`workspacePath`、`sessionMeta`、`capabilityIntent`
- `run_turn`
  - 字段：`requestId`、`conversationId`、`turnId`、`prompt`、`attachments`、`metadata`
- `abort_turn`
  - 字段：`requestId`、`conversationId`、`turnId`、`reason`
- `dispose_conversation`
  - 字段：`requestId`、`conversationId`、`reason`
- `reload_capabilities`
  - 字段：`requestId`、`scope`、`capabilities`
- `publish_host_event`
  - 字段：`requestId`、`event`
- `subscribe_events`
  - 字段：`requestId`、`conversationId?`、`sinceEventId?`、`filters?`
- `ping`
  - 字段：`requestId`

### 7.2 KernelRuntimeWireProtocol envelope

worker 到主进程统一输出 `KernelRuntimeEnvelope`。envelope 分为：

1. control envelope
   - 表示 runtime 生命周期、ack、error、aborted、closed。
   - 供 Electron Main 更新 registry 状态，不直接等同于前端 SSE。
2. event envelope
   - 包含稳定 `KernelEvent`。
   - Electron Main 负责从中抽取文本 delta、工具进度、权限请求、task 状态等，再映射为现有 SSE 或桌面 UI。
3. raw/debug envelope
   - 仅用于日志和排障，不作为 host 业务协议。

control envelope：

如果没有 IPC、control event 也走 stdout NDJSON，必须使用独立 envelope，避免和 runtime stream / debug log 混淆：

```json
{ "source": "kernel_runtime", "kind": "control", "type": "conversation_ready", "requestId": "..." }
```

- `runtime_ready`
- `conversation_ready`
- `turn_started`
- `status`
- `error`
- `turn_aborted`
- `conversation_disposed`
- `capabilities_reloaded`
- `pong`

event envelope：

```json
{
  "source": "kernel_runtime",
  "kind": "event",
  "eventId": "evt_000001",
  "conversationId": "conv_...",
  "turnId": "turn_...",
  "event": { "type": "assistant_delta", "text": "..." }
}
```

第一阶段桌面 SSE mapper 必须识别：

- `KernelHeadlessEvent`
  - `assistant_delta` 映射为前端现有 `content_block_delta`。
  - `assistant_done` / `turn_completed` 映射为前端现有 `message_stop`。
  - `error` 映射为前端现有 `error`。
- `KernelToolEvent` / `KernelTaskEvent` / `KernelHookEvent`
  - 第一阶段可先记录并降级展示，但不得污染文本流。
- `KernelPermissionEvent`
  - 可以先按不可交互策略返回错误或走 host permission bridge；不能静默通过。

### 7.3 传输建议

- 第一阶段建议：`child_process.spawn()` 启动独立 worker 进程，父进程写 `KernelRuntimeWireProtocol` JSON，父进程读取 worker stdout 上的 `KernelRuntimeEnvelope` NDJSON。
- runner 选择：
  - 开发期优先显式 `spawn(bun, [desktop worker runner])`，和当前桌面端 cowork CLI 路径一致。
  - desktop worker runner 可以放在桌面仓库或构建产物中，但 runner 代码只 import `@go-hare/hare-code/kernel`。
  - 如果构建后的 runner 经过 smoke 证明可被 Electron/Node 直接运行，再切到 `child_process.fork()` + IPC。
- stdout framing：
  - worker 输出必须带 `source: "kernel_runtime"` 和 `kind`。
  - raw `StdoutMessage` 只能作为 debug/raw envelope 或 worker 内部输入，不直接暴露给 Electron Main 业务逻辑。
  - Electron Main 先按 envelope 分流，再把 `KernelEvent` 映射到 SSE。
- 原因：worker 内部使用 `outputFormat: 'stream-json'` 时，stdout 污染会被限制在单 worker 进程内，不会跨会话串话；同时不把 Electron 主进程暴露给 `claude-code` 的全局状态。
- 备选方案：全部事件都走 IPC，但 schema 仍然是 `KernelRuntimeWireProtocol`，不能因为传输不同而改变协议。
- 非 JS host 可以复用同一 schema，通过 HTTP、WebSocket、stdio NDJSON 或 Unix socket 连接常驻 kernel runtime。

## 8. 关键实现策略

### 8.1 claude-code 侧

在 public kernel surface 和 `KernelRuntimeWireProtocol` 补齐 CLI runtime 能力。CLI 变成这个 public kernel 的一个 host；桌面 worker 只 import `@go-hare/hare-code/kernel`；Electron Main、Python/Go SDK 和机器人宿主只连接常驻 runtime 协议，不 import `claude-code/src/*` 内部路径。

建议新增文件：

- `claude-code/src/kernel/runtime.ts`
- `claude-code/src/kernel/wireProtocol.ts`
- `claude-code/src/kernel/capabilities.ts`
- `claude-code/src/kernel/events.ts`
- `claude-code/src/kernel/headlessController.ts`
- `claude-code/src/kernel/headlessInputQueue.ts`
- `claude-code/src/kernel/headlessProvider.ts`
- `claude-code/src/kernel/commands.ts`
- `claude-code/src/kernel/tools.ts`
- `claude-code/src/kernel/permissions.ts`
- `claude-code/src/kernel/mcp.ts`
- `claude-code/src/kernel/hooks.ts`
- `claude-code/src/kernel/skills.ts`
- `claude-code/src/kernel/plugins.ts`
- `claude-code/src/kernel/agents.ts`
- `claude-code/src/kernel/tasks.ts`
- `claude-code/src/kernel/companion.ts`
- `claude-code/src/kernel/kairos.ts`
- `claude-code/src/kernel/memory.ts`
- `claude-code/src/kernel/context.ts`
- `claude-code/src/kernel/sessions.ts`
- `claude-code/src/kernel/index.ts`
- `claude-code/src/entrypoints/kernel-runtime.ts`
- `claude-code/src/kernel/__tests__/runtime.test.ts`
- `claude-code/src/kernel/__tests__/wireProtocol.test.ts`
- `claude-code/src/kernel/__tests__/capabilities.test.ts`
- `claude-code/src/kernel/__tests__/events.test.ts`
- `claude-code/src/kernel/__tests__/headlessController.test.ts`
- `claude-code/src/kernel/__tests__/headlessInputQueue.test.ts`
- `claude-code/src/kernel/__tests__/headlessProvider.test.ts`
- `claude-code/src/kernel/__tests__/commands.test.ts`
- `claude-code/src/kernel/__tests__/tools.test.ts`
- `claude-code/src/kernel/__tests__/hooks.test.ts`
- `claude-code/src/kernel/__tests__/skillsPlugins.test.ts`
- `claude-code/src/kernel/__tests__/agentsTasks.test.ts`
- `claude-code/src/kernel/__tests__/companionKairos.test.ts`
- `claude-code/src/kernel/__tests__/packageEntry.test.ts`

实现要点：

- `runtime` 提供 `createKernelRuntime()`，作为 CLI runtime 能力总入口。
- `wireProtocol` 定义 `KernelRuntimeCommand`、`KernelRuntimeEnvelope`、错误码、event replay 和 subscribe schema。
- `kernel-runtime` runner 用 `createKernelRuntime()` 承载 wire protocol，供 desktop worker、Python/Go SDK、机器人宿主启动或连接。
- `capabilities` 统一 resolve/reload commands、tools、permissions、MCP、hooks、skills、plugins、agents、tasks、companion、Kairos、memory、sessions。
- `events` 定义统一 `KernelEvent`，让文本流、工具进度、权限请求、hook 结果、plugin error、companion reaction、Kairos tick 都从同一事件面输出。
- `headlessController` 内部使用 `createDefaultKernelHeadlessEnvironment()` 和 `createKernelHeadlessSession()` 创建长生命周期会话，参考 `claude-code/src/kernel/headless.ts:97`、`claude-code/src/kernel/headless.ts:159`。
- `headlessController` 封装启动期 bootstrap，接收 `cwd/projectRoot/originalCwd/clientType/sessionSource/provider/tools/agents/commands/MCP` 等参数。
- `headlessInputQueue` 实现 `AsyncIterable<string>`，作为 `HeadlessRuntimeInput` 传给 kernel session。
- `controller.start()` 后启动一次长生命周期 `session.run(inputQueue, options)`，`controller.runTurn()` 时向 queue 写入 SDK user message JSON line，而不是每个 turn 都新建一次 `session.run(prompt)`。
- turn 执行时使用 `outputFormat: 'stream-json'`、`verbose: true`、`includePartialMessages: true`，让 worker 可以消费 raw `StdoutMessage`。
- `controller.abortTurn()` 优先向 queue 写入 SDK control request：`{ type: "control_request", request_id, request: { subtype: "interrupt" } }`。当前底层 `headlessRuntimeLoop` 已处理该 interrupt 并调用 active turn abort。
- `headlessProvider` 提供 OpenAI-compatible 与 Anthropic-compatible provider 到 env/run options 的公共映射，替代桌面端旧 SDK/provider 私有参数。
- `events` 提供 raw `StdoutMessage` 到 public `KernelHeadlessEvent` / `KernelEvent` 的归一化，避免外部 host 解析 runtime 内部对象。
- `commands` 开放 CLI slash command runtime，但不开放 Ink 菜单和终端快捷键。
- `tools/permissions/MCP` 开放工具目录、权限请求/决策 schema、MCP server lifecycle 和 MCP tools。
- `hooks` 开放 SessionStart、PreToolUse、PostToolUse、PostToolUseFailure、Stop、SubagentStop、PreCompact、PostCompact。
- `skills/plugins` 开放 bundled/user/project/managed/MCP/plugin skills，以及 plugin 产生的 commands、agents、hooks、MCP、skills、tools。
- `agents/tasks` 开放 agents、coordinator、subagent spawn、task tools、owned files/write guard。
- `companion` 开放 pet/companion state、hatch/rehatch/mute/unmute/pet、turn 后 reaction 和错误事件。
- `kairos` 开放常驻助手、proactive tick、brief、channel/webhook event、dream/memory、push notification。
- `memory/context/sessions` 开放 AGENTS.md/project context、memory、transcript、compaction、session list/resume、background/daemon status。
- `headlessController` 需要强制单 controller 单 active turn。`runTurn()` 到达时若已有 active turn，应返回 busy/error，避免同一 conversation 内并发 turn 污染上下文。
- `headlessController` 需要记录 `turnId -> terminal state`，从 raw `result` / `error` / abort 中生成 public event，供 Electron Main 清理 `TurnStreamRegistry`。
- `src/kernel/index.ts` 必须导出新增 API；构建后 package smoke 必须验证 `@go-hare/hare-code/kernel` 能直接导入这些接口。
- `kernel-runtime` runner smoke 必须验证：`init_runtime`、`create_conversation`、`run_turn`、`abort_turn`、`subscribe_events`、`dispose_conversation` 的基本路径。

### 8.2 hare-code-desktop 侧

建议新增文件：

- `hare-code-desktop/electron/kernel-runtime-manager.cjs`
- `hare-code-desktop/electron/kernel-worker-wrapper.cjs`
- `hare-code-desktop/electron/kernel-protocol.cjs`
- `hare-code-desktop/electron/kernel-event-mapper.cjs`
- `hare-code-desktop/electron/turn-stream-registry.cjs`

建议修改文件：

- `hare-code-desktop/electron/main.cjs`
- `hare-code-desktop/package.json`
- `hare-code-desktop/README.md`

实现要点：

- 用 `ConversationRuntimeRegistry` 替换当前基于 `activeRuns.get("sdk-session:*")` 的旧 SDK session 管理。
- 用 `TurnStreamRegistry` 承接当前 `activeRuns.get(conversation.id)` 的 SSE buffer/emitter/stop handle 职责，避免 worker 生命周期和 turn buffer 混在一起。
- 删除 `loadHareSdkModule()`、`runViaSdk()` 和 `sdk-session:*` 的路径，替换为 worker spawn / lookup / dispatch。参考 `hare-code-desktop/electron/main.cjs:806`、`hare-code-desktop/electron/main.cjs:816`、`hare-code-desktop/electron/main.cjs:842`、`hare-code-desktop/electron/main.cjs:882`、`hare-code-desktop/electron/main.cjs:1788`。
- `kernel-protocol.cjs` 只做 `KernelRuntimeWireProtocol` 的本地编码/解码、request correlation、timeout 和错误映射，不定义桌面私有 schema。
- `/api/chat` 不再直接调旧 SDK，会改为：
  - 获取或创建 worker
  - 发送 `create_conversation` / `run_turn`
  - 将 `KernelRuntimeEnvelope.event` 中的 `KernelEvent` 归一化为当前前端 SSE
  - 将 SSE line 缓存到 `TurnStreamRegistry` 的 per-turn buffer
  - 继续以 SSE 形式返回给前端
- `/api/conversations/:id/stop-generation` 改为给对应 worker 发送 `abort_turn`。
- `/api/conversations/:id/reconnect` 继续复用现有缓冲转发模型，参考 `hare-code-desktop/electron/main.cjs:1807`。
- 第一阶段只替换普通 chat 的旧 SDK 路径。当前 `runViaOpenAI()` 和 cowork `runViaCli()` 是另外两条分支，是否一并归入 kernel worker 应作为后续产品/实现决策，不能在本计划里无提示删除。

### 8.3 构建与发布

- 停止依赖 `electron/vendor/hare-code-sdk.js`。当前旧链路同步的是 `dist/code.js` 到 vendor SDK，参考 `hare-code-desktop/scripts/sync-hare-sdk.cjs:9`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:230`。
- `claude-code` 继续以 package `./kernel` 作为 JS host 依赖面；新增 API 必须进入 `@go-hare/hare-code/kernel` 的构建产物与类型声明。
- `claude-code` 同时提供常驻 `kernel-runtime` runner，作为非 JS host 的 wire protocol 入口。
- 桌面端启动脚本改为面向 desktop worker runner；该 runner 只 import `@go-hare/hare-code/kernel` 并实现 `KernelRuntimeWireProtocol`，不再面向旧 SDK bundle。
- 新增 runner smoke：验证 desktop worker runner 在开发期 Bun runner、构建后 runner、Electron packaged 环境下至少一种路径可启动并返回 `runtime_ready` / `conversation_ready`。
- 桌面端版本联动脚本要从旧的 `../hare-code` sibling 假设中解耦。参考 `hare-code-desktop/package.json:15`、`hare-code-desktop/README.md:9`。

## 9. 分阶段实施步骤

### Step 0. 校准 KernelRuntimeWireProtocol 与 runner

- 明确 `KernelRuntimeWireProtocol` command、envelope、`KernelEvent`、desktop SSE event 四层边界。
- 先决定第一阶段 runner：默认 Bun `spawn()`；只有 Node/Electron smoke 通过后才用 `fork()`。
- 验证点：一个空 worker 能启动、接收 `ping`、返回 `pong`，且 stderr/stdout 不污染 `KernelRuntimeEnvelope`。

### Step 1. 产出 `@go-hare/hare-code/kernel` 公共 runtime 总接口

- 新增 `runtime/wireProtocol/capabilities/events` 并从 `src/kernel/index.ts` 导出。
- 定义 `createKernelRuntime()`、`KernelRuntimeCapabilities`、`KernelEvent`、`KernelRuntimeWireProtocol` 四个总 contract。
- 验证点：source-level 单测通过；package-level smoke 能从 `@go-hare/hare-code/kernel` 导入 runtime 总入口。

### Step 2. 补齐常驻 kernel-runtime runner

- 新增常驻 runner，承载 `KernelRuntimeWireProtocol`。
- runner 内部使用 `createKernelRuntime()`，不直接 import runtime internal。
- 验证点：runner 能完成 `init_runtime`、`create_conversation`、`ping`，并输出 `runtime_ready` / `conversation_ready`。

### Step 3. 补齐 headless conversation 执行接口

- 新增 `headlessController/headlessInputQueue/headlessProvider` 并接入 `KernelRuntime`。
- controller 能完成最小 bootstrap、建立 input queue，并启动一次长生命周期 kernel headless session。
- 验证点：能从 package 入口和 wire protocol 创建 controller、执行一轮、abort 后复用、dispose 后拒绝新 turn。

### Step 4. 开放 CLI runtime 能力

- 分批开放 commands、tools/permissions/MCP、hooks、skills/plugins、agents/tasks、companion、Kairos、memory/context/sessions。
- CLI 侧逐步改成消费 public kernel capability，而不是继续独占这些能力的内部入口。
- 验证点：CLI 原有 commands/tools/hooks/skills/plugins/MCP/agents/pet/Kairos 行为不回退；JS host 只能依赖 package 入口；非 JS host 只能依赖 wire protocol。

### Step 5. 固化 desktop 主进程 <-> worker 传输

- 固化 `KernelRuntimeWireProtocol` 在 desktop 本地传输上的 framing。
- worker 实现只调用 `@go-hare/hare-code/kernel` 公共接口。
- 验证点：主进程能够完成 `init_runtime`、`create_conversation`、`run_turn`、`abort_turn`、`dispose_conversation` 的 happy path。

### Step 6. 跑通单会话文本流式链路

- worker 内通过 input queue 执行单个 prompt。
- 主进程消费 worker `KernelEvent`，抽取 text delta，转发为现有 SSE。
- 验证点：前端无感切换，文本能稳定流式显示。

### Step 7. 接入 turn abort

- 在 worker host 内部把 `abort_turn` 映射到 SDK control `interrupt`。
- 主进程将 `/stop-generation` 映射到 `abort_turn`。
- 验证点：中途停止时，当前 turn 终止，worker 仍可复用。

### Step 8. 接入重连、删除和异常恢复

- 保留每 turn ring buffer。
- 用 `eventId` / `sinceEventId` 支持协议级事件回放。
- 删除 conversation 时 dispose 对应 worker。
- worker 异常退出时能向前端回报失败状态，并支持重新发起新 turn。
- 验证点：刷新页面后可从 `/reconnect` 回放未完成的事件缓冲；删除会话后 worker 被回收。

### Step 9. 接入多会话并发

- 同时启动多个 conversation worker。
- 验证点：不同 conversation 的 sessionId、cwd、输出流互不污染。

### Step 10. 删除旧 SDK 构建链

- 清理 `sdk:build`、`sdk:build:package`、vendor SDK 同步逻辑。
- 更新 README 与发布说明。
- 验证点：桌面端启动不再需要 `electron/vendor/hare-code-sdk.js`，构建脚本不再查找 `dist/code.js` 作为 SDK bundle。

## 10. 验收标准

- 桌面端普通 chat 不再依赖旧 SDK bundle、`electron/vendor/hare-code-sdk.js`、`createHeadlessChatSession()`、`session.stream()`。
- 桌面端构建链不再把 `dist/code.js` 当作 SDK bundle 同步到 vendor。
- `@go-hare/hare-code/kernel` 开放 CLI runtime 总入口：`createKernelRuntime()`、`KernelRuntimeCapabilities`、`KernelEvent`。
- `KernelRuntimeWireProtocol` 开放语言无关常驻 runtime 协议：command、envelope、error、event replay、subscribe。
- 常驻 `kernel-runtime` runner 可被 Python/Go/机器人 host 通过协议启动或连接。
- CLI runtime 能力至少覆盖 commands、tools、permissions、MCP、hooks、skills、plugins、agents、tasks、companion、Kairos、memory、sessions。
- CLI 自身可逐步迁移为 public kernel 的 host，不能继续把上述能力只藏在 CLI 内部入口里。
- `desktop-worker` runner smoke 通过：能启动、`init_runtime`、`create_conversation`、`run_turn`、输出文本 delta、`dispose_conversation`。
- 单个桌面实例可同时运行至少 3 个 conversation，且互不串话。
- `stop-generation` 只终止目标 conversation 的当前 turn，不影响其它会话。
- `reconnect` 能正确回放目标会话的事件缓冲。
- 删除 conversation 后，对应 worker 会被正确回收。
- worker 异常退出后，前端能收到明确错误，不会卡在“生成中”。
- 桌面端前端 SSE 消费层不需要大改，现有 `content_block_delta` / `message_stop` 路径保持可用。
- `KernelEvent` 与 desktop SSE event 的映射有测试覆盖，不能把 raw `StdoutMessage` 或顶层 `stream_event` 直接当作前端事件名。

## 11. 风险与缓解

### 风险 1：现有 public kernel session API 不直接提供 abort

- 现状：`createKernelHeadlessSession()` 只有 `run/getState/setState`，没有 `abort`。参考 `claude-code/src/kernel/headless.ts:100`、`claude-code/src/kernel/headless.ts:229`。
- 缓解：在 `@go-hare/hare-code/kernel` 新增 public `KernelHeadlessController.abortTurn()` facade，内部优先走 long-running input queue + SDK control `interrupt`；只有该路径无法满足停止语义时，再由 kernel 包内部调整 runtime abort seam，桌面端不直接依赖 runtime internal。

### 风险 2：worker stdout 仍可能被非 JSON 输出污染

- 现状：stream-json 使用 stdout，相关 guard 也是进程级。参考 `claude-code/src/utils/streamJsonStdoutGuard.ts:49`。
- 缓解：每会话单独进程；父进程对非 JSON 行做兜底隔离和日志记录。

### 风险 3：会话长期驻留导致内存增长

- 缓解：引入空闲超时、最大 worker 数、LRU 回收，以及显式 `dispose_conversation`。

### 风险 4：工具事件和文档事件映射不完整

- 缓解：桌面迁移第一阶段先以文本主链为验收标准；但 kernel event surface 和 wire protocol 必须先定义全量 `KernelEvent` union，避免后续 tools/hooks/skills/plugins/companion/Kairos 事件各开一套私有协议。

### 风险 5：把 CLI 能力误写成桌面私有适配

- 现状：commands、tools、hooks、skills、plugins、MCP、agents、companion、Kairos 当前很多入口仍挂在 CLI/REPL/settings/plugin 内部路径上。
- 缓解：先定义 `KernelRuntimeCapabilities`、capability resolver 和 `KernelRuntimeWireProtocol`，所有 host 只声明 intent；CLI 和 JS worker 消费 `@go-hare/hare-code/kernel`，非 JS host 消费 wire protocol，不让 desktop wrapper 或 Python/Go SDK 直接复刻 CLI 私有逻辑。

### 风险 6：worker runner 与 Electron/Node/Bun 兼容性不明

- 现状：`claude-code` 的稳定构建入口是 package `./kernel`，桌面端还需要一个可启动的本地 worker runner。
- 缓解：先以 `spawn(bun, [desktop worker runner])` 跑通开发闭环；runner 只 import `@go-hare/hare-code/kernel`；新增构建后 runner smoke，再决定是否切到 `fork()`。

### 风险 7：只定义 TS API，非 JS host 无法常驻接入

- 现状：`@go-hare/hare-code/kernel` 是 JS package surface，Python/Go/机器人宿主不能直接 import。
- 缓解：同步定义常驻 `KernelRuntimeWireProtocol` 和 runner；各语言 SDK 只做 typed client，不能依赖 TS 源码路径或复制 runtime 逻辑。

### 风险 8：`activeRuns` 职责混合导致迁移漏项

- 现状：同一个 Map 同时保存旧 SDK session 和当前 turn SSE buffer。
- 缓解：先拆 `ConversationRuntimeRegistry` 与 `TurnStreamRegistry`，迁移 `/generation-status`、`/stream-status`、`/reconnect`、`/delete`、`/stop-generation` 时逐个对照旧行为。

## 12. 验证计划

### 单元/模块验证

- worker 协议编解码测试
- `KernelRuntimeWireProtocol` command/envelope/error/event replay 测试
- public kernel runtime/capabilities/events contract 测试
- public kernel provider config -> env/run options 映射测试
- public kernel input queue 顺序、interrupt、close 测试
- public kernel controller start/runTurn/abortTurn/dispose 测试
- public kernel commands registry 测试
- public kernel tools/permissions/MCP catalog 测试
- public kernel hooks registry 测试
- public kernel skills/plugins reload 测试
- public kernel agents/tasks/coordinator contract 测试
- public kernel companion/Kairos event 测试
- public kernel memory/context/sessions 测试
- public kernel event normalization 测试
- package-level `@go-hare/hare-code/kernel` 导入 smoke
- resident `kernel-runtime` runner smoke
- CLI parity 测试：commands/tools/hooks/skills/plugins/MCP/agents/pet/Kairos 仍可由 CLI 使用
- `ConversationRuntimeRegistry` 生命周期测试
- `TurnStreamRegistry` / SSE ring buffer 回放测试
- `KernelEvent` -> desktop SSE mapper 测试
- raw `StdoutMessage` -> `KernelEvent` normalization 测试
- abort 只作用于目标 worker 的测试
- runner resolver 测试：开发期 Bun source、构建后 dist、缺失 worker 时错误可读

### 集成验证

- CLI as host 集成：CLI 通过 public kernel capability 启动核心能力
- non-JS host 集成：通过 `KernelRuntimeWireProtocol` 创建 conversation、提交 turn、订阅事件、abort、dispose
- public kernel controller bootstrap smoke
- public kernel full-capability smoke：commands、tools、hooks、skills、plugins、MCP、agents、companion、Kairos 至少能 list/resolve/reload 或输出状态
- 单会话单轮文本流
- 单会话连续多轮上下文保持
- 单会话 stop 后 worker 可复用
- 多会话同时生成
- 一个会话 abort，另一个会话继续
- 删除会话时 worker 回收
- worker crash 后前端错误感知
- 构建后 desktop worker smoke

### 手工 smoke

- 同时打开 3 个聊天窗口并发生成
- 中途停止其中 1 个
- 刷新页面后重连回放
- 删除 1 个会话后确认其余会话正常

## 13. 文件级改造清单

### claude-code

- `claude-code/src/kernel/runtime.ts`
  - 新增 `createKernelRuntime()` 总入口。
- `claude-code/src/kernel/wireProtocol.ts`
  - 新增 `KernelRuntimeWireProtocol` command/envelope/error/event replay schema。
- `claude-code/src/kernel/capabilities.ts`
  - 新增 CLI runtime capabilities resolver / reload。
- `claude-code/src/kernel/events.ts`
  - 新增统一 `KernelEvent` union。
- `claude-code/src/kernel/headlessController.ts`
  - 新增 public controller facade，负责 bootstrap、input queue、turn run、abort、dispose。
- `claude-code/src/kernel/headlessInputQueue.ts`
  - 新增 public `AsyncIterable<string>` input queue，负责 user turn、interrupt、close。
- `claude-code/src/kernel/headlessProvider.ts`
  - 新增 public provider 到 env/run options 的映射。
- `claude-code/src/kernel/commands.ts`
  - 开放 CLI slash command runtime。
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
  - 导出上述 public API，确保 package `./kernel` 可用。
- `claude-code/src/entrypoints/kernel-runtime.ts`
  - 新增常驻 runtime runner，供 desktop worker、Python/Go SDK 和机器人 host 连接。
- `claude-code/src/kernel/__tests__/runtime.test.ts`
  - 覆盖 runtime 总入口。
- `claude-code/src/kernel/__tests__/wireProtocol.test.ts`
  - 覆盖 wire protocol schema 与 envelope。
- `claude-code/src/kernel/__tests__/capabilities.test.ts`
  - 覆盖 capability resolve/reload。
- `claude-code/src/kernel/__tests__/events.test.ts`
  - 覆盖统一 event surface。
- `claude-code/src/kernel/__tests__/headlessController.test.ts`
  - 覆盖 start、runTurn、abortTurn、dispose、单 active turn。
- `claude-code/src/kernel/__tests__/headlessInputQueue.test.ts`
  - 覆盖 input queue 顺序、interrupt、close。
- `claude-code/src/kernel/__tests__/headlessProvider.test.ts`
  - 覆盖 OpenAI-compatible 与 Anthropic provider 映射。
- `claude-code/src/kernel/__tests__/commands.test.ts`
  - 覆盖 command registry。
- `claude-code/src/kernel/__tests__/tools.test.ts`
  - 覆盖 tools/permissions/MCP。
- `claude-code/src/kernel/__tests__/hooks.test.ts`
  - 覆盖 hook registry。
- `claude-code/src/kernel/__tests__/skillsPlugins.test.ts`
  - 覆盖 skills/plugins reload。
- `claude-code/src/kernel/__tests__/agentsTasks.test.ts`
  - 覆盖 agents/tasks/coordinator contract。
- `claude-code/src/kernel/__tests__/companionKairos.test.ts`
  - 覆盖 companion/Kairos public events。
- `claude-code/src/kernel/__tests__/packageEntry.test.ts`
  - 验证 `@go-hare/hare-code/kernel` 能导出新增接口。

### hare-code-desktop

- `hare-code-desktop/electron/main.cjs`
  - 替换旧 SDK session 管理，接入 worker registry。
- `hare-code-desktop/electron/kernel-runtime-manager.cjs`
  - 新增 conversation -> worker 的注册和调度。
- `hare-code-desktop/electron/turn-stream-registry.cjs`
  - 新增 current turn SSE buffer、reconnect、stop handle 管理。
- `hare-code-desktop/electron/kernel-worker-wrapper.cjs`
  - 新增 worker 启停、stdout/IPC 处理；worker runner 只 import `@go-hare/hare-code/kernel`。
- `hare-code-desktop/electron/kernel-protocol.cjs`
  - 新增主进程侧 `KernelRuntimeWireProtocol` 传输封装。
- `hare-code-desktop/electron/kernel-event-mapper.cjs`
  - 新增 public `KernelEvent` -> 当前前端 SSE event 的映射。
- `hare-code-desktop/package.json`
  - 删除旧 SDK build 链，新增 worker build/deploy 依赖。
- `hare-code-desktop/README.md`
  - 更新接入与发布说明。

## 14. 最终建议

- 先实现“每会话独立 worker + input queue + 单会话文本流 + stop/reconnect/delete + 多会话并发”这条最小闭环。
- 但内核接口层不要按桌面最小闭环收窄；要先把 CLI runtime 全能力面的 public contract 和 `KernelRuntimeWireProtocol` 定住。
- CLI 背后的 commands、tools、hooks、skills、plugins、MCP、agents、companion、Kairos、memory、sessions 都要经由 `@go-hare/hare-code/kernel` 开放。
- Python、Go、机器人宿主通过常驻 runtime wire protocol 使用同一套能力；各语言 SDK 只做 typed client，不复制 kernel 行为。
- 第一阶段优先用 Bun `spawn()` 跑通，不要先把时间花在 `fork()`/Node-compatible worker 产物上；等 smoke 证明可行再收口 runner。
- 明确拆掉旧 SDK session 管理，但保留并重命名当前 SSE buffer/reconnect 职责，避免迁移时把前端重连能力一起删掉。
- 不要先追求把所有桌面端事件一口气迁完。
- 不要先尝试“同进程多会话 headless runtime”，当前代码基线下成本高、收益低、风险大。
