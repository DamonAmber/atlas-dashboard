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

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, shell } = require('electron');
const path = require('path');
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

// 收掉我们自己 spawn 的 server（复用已有实例时 child 为 null，不误杀 CLI 守护进程），然后退出。
function cleanupAndExit(code) {
  if (smokeTimer) { clearTimeout(smokeTimer); smokeTimer = null; }
  if (serverInfo && serverInfo.child) { try { serverInfo.child.kill('SIGTERM'); } catch {} }
  app.exit(code);
}

async function boot() {
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
  if (!isSmoke) createTray();
}

// PDF 导出：前端 window.atlasDesktop.exportPdf({ path, fileName }) → 主进程用内置 Chromium 打印
ipcMain.handle('atlas:export-pdf', async (_e, args) => {
  if (!serverInfo) return { ok: false, error: '服务未就绪' };
  const a = args || {};
  return pdf.exportPdf({ serverUrl: serverInfo.url, filePath: a.path, fileName: a.fileName });
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
