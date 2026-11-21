# Atlas 桌面 App（Electron 外壳）

开源桌面版：把现有 Atlas（Node/Express 服务 + Web 前端）包成一个可双击运行的桌面 App，
面向不熟悉 npm / 终端的用户。**不改 `server.js` 与现有测试**，只在壳里复用它们。

## 怎么跑（开发模式）

```bash
npm install        # 首次需要装上 electron（devDependency）
npm run app        # 启动桌面 App
```

## 它做了什么

- `server-manager.js`（纯 Node，可单独用 node 冒烟测试）
  - 确保 `~/.atlas/config.json` 存在（缺失就写一份默认配置，扫描 `~/Documents`）；
  - 若已有健康的 Atlas 在跑（CLI 的 `atlas start` 守护进程），**直接复用**，不再起第二个 server（避免两个进程抢写 `store.json`）；
  - 否则挑一个空闲端口，用 `ELECTRON_RUN_AS_NODE=1` 让 Electron 以纯 Node 跑 `server.js`（不额外打包 Node 运行时）；
  - 健康检查（`GET /api/state`）通过后再让窗口加载。
- `main.js`：单实例、开窗加载 `http://127.0.0.1:<port>`、mac 关窗留 dock、Cmd+Q 收掉自起的 server。
- 数据与配置和 CLI 版共用 `~/.atlas`，两者是同一份看板。

## 打包成 macOS App（DMG）

```bash
npm run app:build         # 需要签名证书时用（自动发现 Keychain 里的 Developer ID）
# 无签名验证构建（本机自测用，产物在 dist-app/）：
CSC_IDENTITY_AUTO_DISCOVERY=false npm run app:dir
```

构建配置在 `package.json` 的 `build` 字段：

- `extraMetadata.main = electron/main.js` —— 只改**打包产物**里的入口，源码 `package.json`
  的 `main` 仍是 `server.js`，不影响 npm 包。
- **`asar: false`** —— 这是刻意的：App 通过 `ELECTRON_RUN_AS_NODE` 以纯 Node 模式派生
  `server.js`，而纯 Node 读不了 asar 包里的文件。关掉 asar 让 `server.js` / `lib` / `public` /
  `node_modules` 以普通文件躺在 `Atlas.app/Contents/Resources/app/` 下，派生才能跑起来。
  （代价是源码在包里可见、启动略慢，对这个 MIT 工具都无所谓。）
- `mac.hardenedRuntime + entitlements` —— 为公证做好准备。`entitlements.mac.plist` 里放开了
  `allow-dyld-environment-variables`（否则硬化运行时会拦掉带 `ELECTRON_RUN_AS_NODE` 的子进程）等项。

图标：`electron/build/icon.icns`（由 `public/favicon.svg` 渲染而来）。

## 和 npm 包的关系

- `electron/` 不在 `package.json` 的 `files` 白名单里，**不会被 `npm publish` 发出去**；
  `electron` / `electron-builder` 都是 devDependency，也不进用户的 npm 安装。
  npm 渠道（`atlas` CLI）完全不受影响。`dist-app/` 已在 `.gitignore` 里。

## 当前状态与安全验证

- 保持 MIT 开源；桌面版与 npm CLI 继续并行分发，不引入闭源混淆或遥测。
- 已实现菜单栏常驻、内置 Chromium PDF 导出、electron-updater 自动更新与 macOS 签名/公证发布流程。
- 当前分发 arm64 DMG / zip，Intel / 通用二进制和 Windows 尚未支持。
- 凭据不放仓库目录。首选用户本人在终端执行 `xcrun notarytool store-credentials atlas-notary`，构建时使用 `APPLE_KEYCHAIN_PROFILE=atlas-notary npm run app:build`；完整流程以根目录 `PUBLISHING.md` 为准。
- `build.files` 是显式运行时白名单，`afterPack` 检查最终 App（包括生产依赖）的凭据文件和内容特征。两张托盘图标需要进入 App；构建用图标源文件、entitlements 和公证配置不进入 App 的源码目录。
- 无签名验证：`CSC_IDENTITY_AUTO_DISCOVERY=false npm run app:dir`，同样必须过产物门禁；验证实例使用独立 `ATLAS_HOME`，不得操作正在使用的看板。验证包不能发布。
- 正式发布前仍须验证 App 签名、公证与 DMG 容器 staple；门禁通过不代替这些检查。
