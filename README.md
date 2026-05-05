# hare-code-desktop

桌面端当前直接消费 sibling `claude-code` 产出的新内核 `dist/kernel.js` package surface。

当前它还是 sibling 目录，不是独立 git 仓库；`.github/workflows/release.yml` 已按独立仓库形态准备好，后续提仓即可直接启用。

## 版本联动

当前以 sibling 内核包 `../claude-code` 的版本号为真源。桌面端版本建议始终与内核包保持一致：

```bash
node ./scripts/sibling-version.cjs sync
node ./scripts/sibling-version.cjs check
```

## 本地开发

1. 先构建并同步内核产物：

```bash
bun run kernel:build
```

2. 再构建桌面端前端：

```bash
bun run build
```

`bun run kernel:build` 会先在 `../claude-code` 执行 build，再把包含 `kernel.js`、`kernel-runtime.js`、CLI 入口和 `chunk-*` 的整套 `dist` 同步到 `electron/vendor/hare-code-kernel/dist`。Electron 主进程运行时优先导入 sibling `../claude-code/dist/kernel.js`，打包发布时使用 vendor 内核产物。

## 独立发布 / 独立仓库模式

如果 desktop 未来提成独立仓库，不再有 sibling `../claude-code`，可以改用已发布包来供应本地 vendor 内核产物：

```bash
bun run kernel:build:package
```

默认会按当前桌面端版本优先查找 sibling 目录里的 `claude-code-<version>.tgz`；如果当前工作区存在 sibling `../claude-code`，脚本会先重新 build 并刷新这个本地 tgz，再从打包产物里抽出整套 `dist` 到 `electron/vendor/hare-code-kernel/dist`。如果本地没有该 tarball，则会自动从 GitHub Release 下载 `claude-code-<version>.tgz`。

如需指定发布仓库，可设置：

```bash
CLAUDE_CODE_RELEASE_REPO=go-hare/hare-code
```

兼容旧环境变量：

```bash
HARE_CODE_RELEASE_REPO=go-hare/hare-code
```

如果要在当前工作区模拟这条链，也可以指定本地 package spec：

```bash
node ./scripts/sync-hare-sdk.cjs --source=package --package-spec ..\\claude-code
```

发布构建脚本：

```bash
bun run electron:build:release:win
bun run electron:build:release:mac
bun run electron:build:release:linux
```

## 当前限制

- 手动 `compact` 目前仍未接通。桌面端现在会明确返回
  `kernel_compact_session_context_unavailable`，原因是 public kernel command
  execution 还拿不到当前 conversation 的 session message context。

## 最近验证

- `node ./scripts/sibling-version.cjs check` 通过，当前 desktop 与 sibling
  `claude-code` 版本同为 `1.7.3`。
- `bun test electron/kernelChatSemanticEvents.test.js electron/kernelChatRuntimeHelpers.test.js src/utils/runtimeTaskEventLinking.test.ts src/utils/desktopBackgroundTurnParity.test.ts`
  通过，`19 pass`。
- vendor `kernel.js` / `kernel-runtime.js` 已重新同步到当前 sibling `dist`，
  且 sha256 一致。
- `bun run build` 通过。
- `CSC_IDENTITY_AUTO_DISCOVERY=false ELECTRON_CACHE="$PWD/.cache/electron" ./node_modules/.bin/electron-builder --dir`
  通过，生成 `release/mac-arm64/hare Desktop.app`；这是一轮 unsigned / ad-hoc
  release smoke，不包含 notarization。
