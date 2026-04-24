# hare-code-desktop 多会话并发 Headless Embed 方案

## 1. 需求摘要

- 目标：桌面端继续走 `headless embed`，但支持多会话并发。
- 约束：不兼容旧 SDK 形态，不再依赖 `dist/sdk.js`、`createHeadlessChatSession()`、`session.stream()` 这套旧接口。
- 约束：不采用公开 `direct-connect server/ws` 作为桌面端主接入路径，桌面端仍由 Electron 主进程统一调度。
- 约束：保留当前渲染层到本地 Express API 的交互形态，尽量不重写前端流式消费逻辑。

## 2. 当前现状

- 桌面端当前在 Electron 主进程内直接加载本地 vendor SDK，并将每个会话保存在 `activeRuns` 中，说明现有模型是“主进程内嵌 runtime”，不是 client/server。参考 `hare-code-desktop/electron/main.cjs:24`、`hare-code-desktop/electron/main.cjs:711`、`hare-code-desktop/electron/main.cjs:718`、`hare-code-desktop/electron/main.cjs:782`。
- 当前桌面端的聊天主链是 `POST /api/chat -> runViaSdk() -> SSE 回写前端`，停止、重连、状态查询也都围绕这条主链实现。参考 `hare-code-desktop/electron/main.cjs:1499`、`hare-code-desktop/electron/main.cjs:1500`、`hare-code-desktop/electron/main.cjs:1506`、`hare-code-desktop/electron/main.cjs:1541`。
- 桌面端构建链仍然假设 sibling 仓库名是 `hare-code`，并且能产出单文件 `dist/sdk.js`。参考 `hare-code-desktop/package.json:13`、`hare-code-desktop/README.md:3`、`hare-code-desktop/README.md:30`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:7`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:180`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:230`。
- `claude-code` 当前的稳定对外入口已经切到 `kernel`，包级公开导出是 `@go-hare/hare-code/kernel`，而不是 `sdk.js`。参考 `claude-code/README.md:14`、`claude-code/README.md:50`、`claude-code/package.json:31`。
- `claude-code` 当前构建只显式打 `cli` 和 `kernel` 两个 entrypoint，没有 `sdk.js` 产物。参考 `claude-code/build.ts:19`。

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

### 3.3 不采用旧 SDK 兼容层

- 用户要求“不兼容旧的”，所以不新增 `createHeadlessChatSession()` 之类的旧接口壳。
- 新桌面端直接面向新的 worker 协议和 kernel 会话模型。

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

- 需要新增 worker 进程协议和调度器。
- 需要在 `claude-code` 增加桌面宿主内部 entrypoint。
- 停止当前生成不再通过旧 session 实例方法完成，而是通过 worker 控制面完成。

### Follow-ups

- 第一阶段先跑通文本流式对话、停止、删除、重连。
- 第二阶段再补工具事件、文档事件、代码执行事件等富事件映射。

## 5. 目标架构

### 5.1 进程模型

- Renderer
  - 继续请求本地 Express API。
- Electron Main
  - 持有 `ConversationRuntimeRegistry`。
  - 负责 worker 生命周期、事件缓冲、SSE 转发、状态查询。
- Conversation Worker
  - 每个 conversation 一个独立子进程。
  - 进程内加载 `@go-hare/hare-code/kernel`。
  - 持有该会话独立的 environment、store、kernel session。

### 5.2 数据流

- `Renderer -> POST /api/chat -> Electron Main`
- `Electron Main -> worker(run_turn)`
- `worker -> stdout/IPC 输出结构化事件`
- `Electron Main -> 转换为现有 SSE 事件 -> Renderer`

### 5.3 生命周期

- 创建 conversation 时不必立刻起 worker。
- 第一次发消息时 lazy spawn worker。
- 同一 conversation 后续 turn 复用同一个 worker。
- 删除 conversation 或明确关闭时销毁 worker。
- worker 异常退出时，主进程更新状态并允许前端重试重建。

## 6. 协议设计

### 6.1 主进程到 worker 的控制消息

- `init_session`
  - 字段：`conversationId`、`workspacePath`、`provider`、`model`、`sessionMeta`
- `run_turn`
  - 字段：`turnId`、`prompt`、`attachments`
- `abort_turn`
  - 字段：`turnId`
- `dispose_session`
  - 字段：`reason`
- `ping`
  - 字段：`requestId`

### 6.2 worker 到主进程的事件

- `session_ready`
- `turn_started`
- `content_block_delta`
- `content_block_start`
- `message_stop`
- `tool_use_start`
- `tool_use_done`
- `status`
- `thinking_summary`
- `document_created`
- `document_updated`
- `code_execution`
- `code_result`
- `result`
- `error`
- `aborted`
- `session_closed`
- `pong`

### 6.3 传输建议

- 优先方案：`child_process.fork()` + IPC 控制消息 + `stdout` 读取 stream-json 事件。
- 原因：worker 内部使用 `outputFormat: 'stream-json'` 时，stdout 污染会被限制在单 worker 进程内，不会跨会话串话。
- 备选方案：全部事件都走 IPC，但这要求在 worker 内自己截获 runtime 事件，不如直接复用现有 stream-json 输出链。

## 7. 关键实现策略

### 7.1 claude-code 侧

新增一个桌面宿主内部 worker entrypoint，不纳入 `kernel` 的对外 semver 承诺面。

建议新增文件：

- `claude-code/src/entrypoints/desktop-worker.ts`
- `claude-code/src/hosts/desktop/desktopWorkerHost.ts`
- `claude-code/src/hosts/desktop/protocol.ts`
- `claude-code/tests/integration/desktop-worker-smoke.test.ts`

实现要点：

- worker 启动时完成最小 bootstrap，参考 `claude-code/examples/kernel-headless-embed.ts:42`、`claude-code/examples/kernel-headless-embed.ts:71`、`claude-code/examples/kernel-headless-embed.ts:79`。
- worker 内部使用 `createDefaultKernelHeadlessEnvironment()` 和 `createKernelHeadlessSession()` 创建长生命周期会话，参考 `claude-code/src/kernel/headless.ts:97`、`claude-code/src/kernel/headless.ts:159`。
- turn 执行时使用 `outputFormat: 'stream-json'`、`verbose: true`，让主进程可以消费结构化流。
- 由于 public kernel session API 只有 `run/getState/setState`，没有外部 `abort`，需要在 worker host 内部补一个 turn-level 控制面。证据见 `claude-code/src/kernel/headless.ts:53`。
- 可以复用 runtime 内部已有的 abort seam 来实现 turn abort，相关内部能力存在于 `claude-code/src/runtime/capabilities/execution/internal/headlessManagedSession.ts:30`、`claude-code/src/runtime/capabilities/execution/internal/headlessManagedSession.ts:119`、`claude-code/src/runtime/capabilities/execution/internal/headlessManagedSession.ts:122`。

### 7.2 hare-code-desktop 侧

建议新增文件：

- `hare-code-desktop/electron/kernel-runtime-manager.cjs`
- `hare-code-desktop/electron/kernel-worker-wrapper.cjs`
- `hare-code-desktop/electron/kernel-protocol.cjs`

建议修改文件：

- `hare-code-desktop/electron/main.cjs`
- `hare-code-desktop/package.json`
- `hare-code-desktop/README.md`

实现要点：

- 用 `ConversationRuntimeRegistry` 替换当前基于 `activeRuns` + 旧 SDK session 的管理方式。参考现有接线点 `hare-code-desktop/electron/main.cjs:24`、`hare-code-desktop/electron/main.cjs:1541`。
- 删除 `loadHareSdkModule()`、`runViaSdk()` 和 `sdk-session:*` 的路径，替换为 worker spawn / lookup / dispatch。参考 `hare-code-desktop/electron/main.cjs:711`、`hare-code-desktop/electron/main.cjs:782`、`hare-code-desktop/electron/main.cjs:1487`。
- `/api/chat` 不再直接调旧 SDK，会改为：
  - 获取或创建 worker
  - 发送 `run_turn`
  - 将 worker 输出缓存到 `run.buffer`
  - 继续以 SSE 形式返回给前端
- `/api/conversations/:id/stop-generation` 改为给对应 worker 发送 `abort_turn`。
- `/api/conversations/:id/reconnect` 继续复用现有缓冲转发模型，参考 `hare-code-desktop/electron/main.cjs:1506`。

### 7.3 构建与发布

- 停止依赖 `electron/vendor/hare-code-sdk.js`。当前这条链已经失效，参考 `hare-code-desktop/scripts/sync-hare-sdk.cjs:9`、`hare-code-desktop/scripts/sync-hare-sdk.cjs:230`。
- `claude-code/build.ts` 需要加入 `desktop-worker` entrypoint，当前只有 `cli` 和 `kernel`。参考 `claude-code/build.ts:19`。
- 桌面端启动脚本改为面向 `claude-code/dist/desktop-worker.js`，而不是 `dist/sdk.js`。
- 桌面端版本联动脚本要从旧的 `../hare-code` sibling 假设中解耦。参考 `hare-code-desktop/package.json:15`、`hare-code-desktop/README.md:9`。

## 8. 分阶段实施步骤

### Step 1. 产出 `claude-code` 的 desktop worker entrypoint

- 新增 worker entrypoint，能在独立进程中完成最小 bootstrap。
- 验证点：worker 启动后可成功创建 kernel headless session。

### Step 2. 定义并固化主进程 <-> worker 协议

- 固化控制消息与事件消息的 JSON schema。
- 验证点：主进程能够完成 `init_session`、`run_turn`、`dispose_session` 的 happy path。

### Step 3. 跑通单会话文本流式链路

- worker 内执行单个 prompt。
- 主进程消费 worker 输出并转发为现有 SSE。
- 验证点：前端无感切换，文本能稳定流式显示。

### Step 4. 接入 turn abort

- 在 worker host 内部暴露 turn-level abort。
- 主进程将 `/stop-generation` 映射到 `abort_turn`。
- 验证点：中途停止时，当前 turn 终止，worker 仍可复用。

### Step 5. 接入多会话并发

- 同时启动多个 conversation worker。
- 验证点：不同 conversation 的 sessionId、cwd、输出流互不污染。

### Step 6. 接入重连和异常恢复

- 保留每会话 ring buffer。
- worker 异常退出时能向前端回报失败状态，并支持重新发起新 turn。
- 验证点：刷新页面后可从 `/reconnect` 回放未完成的事件缓冲。

### Step 7. 删除旧 SDK 构建链

- 清理 `sdk:build`、`sdk:build:package`、vendor SDK 同步逻辑。
- 更新 README 与发布说明。

## 9. 验收标准

- 桌面端不再依赖 `dist/sdk.js`、`electron/vendor/hare-code-sdk.js`、`createHeadlessChatSession()`。
- 单个桌面实例可同时运行至少 3 个 conversation，且互不串话。
- `stop-generation` 只终止目标 conversation 的当前 turn，不影响其它会话。
- `reconnect` 能正确回放目标会话的事件缓冲。
- 删除 conversation 后，对应 worker 会被正确回收。
- worker 异常退出后，前端能收到明确错误，不会卡在“生成中”。
- 桌面端前端 SSE 消费层不需要大改，现有 `content_block_delta` / `message_stop` 路径保持可用。

## 10. 风险与缓解

### 风险 1：public kernel API 不直接提供 abort

- 现状：`createKernelHeadlessSession()` 只有 `run/getState/setState`，没有 `abort`。参考 `claude-code/src/kernel/headless.ts:53`。
- 缓解：在 `claude-code` 的 desktop worker host 内部接 runtime abort seam，不要求把 abort 暴露成 public kernel API。

### 风险 2：worker stdout 仍可能被非 JSON 输出污染

- 现状：stream-json 使用 stdout，相关 guard 也是进程级。参考 `claude-code/src/utils/streamJsonStdoutGuard.ts:49`。
- 缓解：每会话单独进程；父进程对非 JSON 行做兜底隔离和日志记录。

### 风险 3：会话长期驻留导致内存增长

- 缓解：引入空闲超时、最大 worker 数、LRU 回收，以及显式 `dispose_session`。

### 风险 4：工具事件和文档事件映射不完整

- 缓解：第一阶段先以文本主链为验收标准，第二阶段补全富事件映射。

## 11. 验证计划

### 单元/模块验证

- worker 协议编解码测试
- `ConversationRuntimeRegistry` 生命周期测试
- SSE ring buffer 回放测试
- abort 只作用于目标 worker 的测试

### 集成验证

- 单会话单轮文本流
- 单会话连续多轮上下文保持
- 多会话同时生成
- 一个会话 abort，另一个会话继续
- 删除会话时 worker 回收
- worker crash 后前端错误感知

### 手工 smoke

- 同时打开 3 个聊天窗口并发生成
- 中途停止其中 1 个
- 刷新页面后重连回放
- 删除 1 个会话后确认其余会话正常

## 12. 文件级改造清单

### claude-code

- `claude-code/build.ts`
  - 增加 `desktop-worker` entrypoint。
- `claude-code/src/entrypoints/desktop-worker.ts`
  - 新增 worker 进程入口。
- `claude-code/src/hosts/desktop/desktopWorkerHost.ts`
  - 新增桌面宿主控制面，负责 bootstrap、turn run、abort、dispose。
- `claude-code/src/hosts/desktop/protocol.ts`
  - 定义 worker 控制协议。
- `claude-code/tests/integration/desktop-worker-smoke.test.ts`
  - 新增 smoke test。

### hare-code-desktop

- `hare-code-desktop/electron/main.cjs`
  - 替换旧 SDK session 管理，接入 worker registry。
- `hare-code-desktop/electron/kernel-runtime-manager.cjs`
  - 新增 conversation -> worker 的注册和调度。
- `hare-code-desktop/electron/kernel-worker-wrapper.cjs`
  - 新增 worker 启停、stdout/IPC 处理。
- `hare-code-desktop/electron/kernel-protocol.cjs`
  - 新增主进程侧协议定义。
- `hare-code-desktop/package.json`
  - 删除旧 SDK build 链，新增 worker build/deploy 依赖。
- `hare-code-desktop/README.md`
  - 更新接入与发布说明。

## 13. 最终建议

- 先实现“每会话独立 worker + 单会话文本流 + 多会话并发 + stop/reconnect”这条最小闭环。
- 不要先追求把所有桌面端事件一口气迁完。
- 不要先尝试“同进程多会话 headless runtime”，当前代码基线下成本高、收益低、风险大。
