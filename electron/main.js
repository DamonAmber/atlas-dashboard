// Atlas 桌面 App —— Electron 主进程。
//
// 形态：壳内拉起现有 server.js（见 server-manager），窗口加载 http://127.0.0.1:<port>。
// 复用现有 ~/.atlas 配置与 store，所以和 CLI 版 `atlas` 是同一份数据；若 CLI 守护进程
// 已在跑，直接复用它、不再起第二个 server。
//
// 常驻：菜单栏托盘图标（打开 / 退出）。mac 习惯——关窗不退出（留在 dock + 托盘），
// 点 dock 图标或托盘"打开"重开窗；Cmd+Q / 托盘"退出"才真正退出并收掉自起的 server。
//
// PDF 导出：前端通过 preload 暴露的 window.atlasDesktop.exportPdf 交给主进程，
// 用内置 Chromium 的 printToPDF 打印（见 electron/pdf.js），不依赖用户本机装没装浏览器。
//
// --smoke：无界面自检模式，加载成功打印 ATLAS_SMOKE_OK 并退出，供自动化验证。

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const serverManager = require('./server-manager');
const pdf = require('./pdf');

const isSmoke = process.argv.includes('--smoke');
app.setName('Atlas');

let mainWindow = null;
let tray = null;
let serverInfo = null;      // { url, port, child, reused }
let smokeTimer = null;
let quitting = false;

function createWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); return; }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Atlas',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(serverInfo.url);
  mainWindow.once('ready-to-show', () => { if (!isSmoke) mainWindow.show(); });

  mainWindow.webContents.on('did-finish-load', () => {
    if (isSmoke) { console.log('ATLAS_SMOKE_OK'); cleanupAndExit(0); }
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    console.error(`页面加载失败 (${code}): ${desc}`);
    if (isSmoke) cleanupAndExit(1);
  });

  // target=_blank / 外站链接（局域网分享等）走系统浏览器，不在 App 窗口里导航走
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showWindow() {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  else if (serverInfo) createWindow();
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'trayTemplate.png'));
  icon.setTemplateImage(true);   // 单色模板：macOS 自动适配浅色/深色菜单栏
  tray = new Tray(icon);
  tray.setToolTip('Atlas');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Atlas', click: showWindow },
    { type: 'separator' },
    { label: '退出 Atlas', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);   // 左键点图标也打开窗口
}

// 把菜单/快捷键命令转发给当前窗口的前端（多 Tab：close-tab / next-tab / prev-tab）
function sendMenuCommand(cmd) {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win) win.webContents.send('atlas:menu-command', cmd);
}

// 应用菜单。存在的主因：默认菜单里 ⌘W = 关闭窗口，会抢在前端 keydown 之前触发，
// 多 Tab 下我们要让 ⌘W 关的是"当前标签"而不是整个窗口。于是自建 File 菜单，
// 把 ⌘W 绑到 close-tab（转发给前端），关窗改用 ⇧⌘W。其余沿用标准 role，
// 保证复制/粘贴/缩放/最小化等原生行为不丢。
function buildAppMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: '文件',
      submenu: [
        { label: '关闭标签', accelerator: 'CmdOrCtrl+W', click: () => sendMenuCommand('close-tab') },
        { label: '关闭窗口', accelerator: 'Shift+CmdOrCtrl+W', role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        // ⌘F：在当前文档内查找。默认编辑菜单没有 Find，桌面 App 里 ⌘F 因此什么都不做，
        // 这里显式绑定并转发给前端（见 app.js 的 onMenuCommand / openFind）。
        { label: '在文档内查找…', accelerator: 'CmdOrCtrl+F', click: () => sendMenuCommand('find-in-page') },
      ],
    },
    {
      label: '显示',
      submenu: [
        { label: '下一个标签', accelerator: 'Control+Tab', click: () => sendMenuCommand('next-tab') },
        { label: '上一个标签', accelerator: 'Control+Shift+Tab', click: () => sendMenuCommand('prev-tab') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}

// 收掉我们自己 spawn 的 server（复用已有实例时 child 为 null，不误杀 CLI 守护进程），然后退出。
function cleanupAndExit(code) {
  if (smokeTimer) { clearTimeout(smokeTimer); smokeTimer = null; }
  if (serverInfo && serverInfo.child) { try { serverInfo.child.kill('SIGTERM'); } catch {} }
  app.exit(code);
}

async function boot() {
  // 原生「关于 Atlas」面板显示版本号（菜单栏 Atlas → 关于 Atlas）
  app.setAboutPanelOptions({
    applicationName: 'Atlas',
    applicationVersion: app.getVersion(),
    copyright: 'MIT · github.com/DamonAmber/atlas-dashboard',
  });
  try {
    serverInfo = await serverManager.startServer({
      nodeBinary: process.execPath,
      asElectronNode: true,
      onLog: (line) => process.stdout.write(`[atlas-server] ${line}`),
    });
    console.log(`Atlas 服务就绪 → ${serverInfo.url}${serverInfo.reused ? '（复用已运行实例）' : ''}`);
  } catch (e) {
    console.error('Atlas 服务启动失败:', e && e.message ? e.message : e);
    cleanupAndExit(1);
    return;
  }
  createWindow();
  if (!isSmoke) {
    Menu.setApplicationMenu(buildAppMenu());
    createTray();
  }
  setupAutoUpdate();
}

// 自动更新（electron-updater + GitHub Releases）：检测新版本 → 后台下载 → 提示重启安装。
// 只在打包后的 App 里跑（dev / npm run app 没有 app-update.yml，直接跳过）；
// 任何错误只记日志、不影响 App 正常使用。更新源即本仓库的 GitHub Releases（读 latest-mac.yml）。
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => console.warn('[updater]', m),
    error: (m) => console.error('[updater]', m),
    debug: () => {},
  };

  autoUpdater.on('error', (err) => console.error('[updater] error:', err && err.message ? err.message : err));
  autoUpdater.on('update-available', (info) => console.log('[updater] 有新版本:', info && info.version));
  autoUpdater.on('update-not-available', () => console.log('[updater] 已是最新'));
  autoUpdater.on('update-downloaded', async (info) => {
    const win = mainWindow || BrowserWindow.getAllWindows()[0] || undefined;
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      message: `Atlas ${info && info.version ? info.version : ''} 已下载`,
      detail: '重启后即用上新版本；也可以稍后退出 App 时自动完成更新。',
    });
    if (response === 0) { quitting = true; autoUpdater.quitAndInstall(); }
  });

  const check = () => autoUpdater.checkForUpdates()
    .catch((e) => console.error('[updater] 检查失败:', e && e.message ? e.message : e));
  check();                                   // 启动即查一次
  setInterval(check, 3 * 60 * 60 * 1000);    // 之后每 3 小时查一次
}

// PDF 导出：前端 window.atlasDesktop.exportPdf({ path, fileName }) → 主进程用内置 Chromium 打印
ipcMain.handle('atlas:export-pdf', async (_e, args) => {
  if (!serverInfo) return { ok: false, error: '服务未就绪' };
  const a = args || {};
  return pdf.exportPdf({ serverUrl: serverInfo.url, filePath: a.path, fileName: a.fileName });
});

// 多 Tab：⌘W 在没有可关标签时回退为关窗（前端判断后调 atlasDesktop.closeWindow）
ipcMain.on('atlas:close-window', () => {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (win) win.close();
});

// 单实例：再次双击/启动时聚焦已有窗口，而不是又起一个
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot);
  app.on('activate', () => { if (serverInfo) showWindow(); });   // 点 dock 图标
  app.on('window-all-closed', () => {
    // mac：关窗留 dock + 托盘，不退出；其它平台直接退出
    if (process.platform !== 'darwin') cleanupAndExit(0);
  });
  app.on('before-quit', () => {
    quitting = true;
    if (serverInfo && serverInfo.child) { try { serverInfo.child.kill('SIGTERM'); } catch {} }
  });
}

// smoke 兜底：加载迟迟不完成也不会挂住自动化
if (isSmoke) {
  smokeTimer = setTimeout(() => { console.error('ATLAS_SMOKE_TIMEOUT'); cleanupAndExit(1); }, 25000);
}
