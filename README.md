# hare-code-desktop

桌面端当前直接消费 sibling `claude-code` 产出的新内核 `dist/kernel.js` package surface。

当前它还是 sibling 目录，不是独立 git 仓库；`.github/workflows/release.yml` 已按独立仓库形态准备好，后续提仓即可直接启用。

## 版本联动

当前以 sibling 内核包 `../claude-code` 的版本号为真源。桌面端版本建议始终与内核包保持一致：

```bash
node ../claude-code/scripts/sync-sibling-version.mjs --only hare-code-desktop
node ../claude-code/scripts/check-sibling-version.mjs --only hare-code-desktop
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

默认会按当前桌面端版本优先查找 sibling 目录里的 `hare-code-<version>.tgz`；如果当前工作区存在 sibling `../claude-code`，脚本会先重新 build 并刷新这个本地 tgz，再从打包产物里抽出整套 `dist` 到 `electron/vendor/hare-code-kernel/dist`。如果本地没有该 tarball，则会自动从 GitHub Release 下载 `hare-code-<version>.tgz`。

如需指定发布仓库，可设置：

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
