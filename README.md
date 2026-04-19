# hare-code-desktop

桌面端当前直接消费 sibling `hare-code` 产出的 SDK bundle。

当前它还是 sibling 目录，不是独立 git 仓库；`.github/workflows/release.yml` 已按独立仓库形态准备好，后续提仓即可直接启用。

## 版本联动

当前以 sibling SDK 包 `../hare-code` 的版本号为真源。桌面端版本建议始终与 SDK 保持一致：

```bash
node ../hare-code/scripts/sync-sibling-version.mjs --only hare-code-desktop
node ../hare-code/scripts/check-sibling-version.mjs --only hare-code-desktop
```

## 本地开发

1. 先构建并同步 SDK：

```bash
bun run sdk:build
```

2. 再构建桌面端前端：

```bash
bun run build
```

`bun run sdk:build` 会先在 `../hare-code` 执行 build，再把生成的 `dist/code.js` 同步到 `electron/vendor/hare-code-sdk.js`，Electron 主进程运行时直接动态导入这份本地 bundle。

## 独立发布 / 独立仓库模式

如果 desktop 未来提成独立仓库，不再有 sibling `../hare-code`，可以改用已发布 SDK 包来供应本地 vendor bundle：

```bash
bun run sdk:build:package
```

默认会按当前桌面端版本优先查找 sibling 目录里的 `hare-code-<version>.tgz`；如果当前工作区存在 sibling `../hare-code`，脚本会先重新 build 并刷新这个本地 tgz，再从打包产物里抽出 `dist/code.js` 到 `electron/vendor/hare-code-sdk.js`。如果本地没有该 tarball，则会自动从 GitHub Release 下载 `hare-code-<version>.tgz`。

如需指定发布仓库，可设置：

```bash
HARE_CODE_RELEASE_REPO=go-hare/hare-code
```

如果要在当前工作区模拟这条链，也可以指定本地 package spec：

```bash
node ./scripts/sync-hare-sdk.cjs --source=package --package-spec ..\\hare-code
```

发布构建脚本：

```bash
bun run electron:build:release:win
bun run electron:build:release:mac
bun run electron:build:release:linux
```
