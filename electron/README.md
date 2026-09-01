# Atlas 桌面 App（Electron 外壳）

阶段 1 POC：把现有 Atlas（Node/Express 服务 + Web 前端）包成一个可双击运行的桌面 App，
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
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg --arm64
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

## 已完成（阶段 1–2）

- 桌面外壳复用 `server.js`，`npm run app` 可跑；
- App 图标（`.icns`）；
- electron-builder 打包出 **arm64 DMG**（目前**未签名**，仅本机自测）。

## 还没做（后续阶段）

- **签名 + 公证**：用 Apple Developer ID 证书签名，再 `notarytool` 公证 —— 否则非技术用户
  会被 Gatekeeper 拦。需要开发者信息（Team ID / 证书 / Apple ID + app-specific password）。
- 托盘/菜单栏常驻形态（当前是标准窗口，关窗留 dock）；
- PDF 导出改用 Electron 自带 Chromium 的 `printToPDF`，替掉"在本机找 Chromium"那条脆弱路径；
- App 模式下把"npm 升级提示"换成 App 自己的自动更新（electron-updater）；
- Intel（x64）/ 通用二进制、以及后续的 Windows。
