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
const fs = require('fs');
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

// 桌面自动更新的当前状态，供前端「检查更新」UI 查询（atlas:update-state）与订阅
// （atlas:update-status 推送）。state: idle|checking|not-available|downloading|downloaded|error|unsupported
let updateStatus = { state: 'idle', version: null, percent: 0, error: null };
// 用户主动点了「检查更新」：走 in-app UI（设置里的“重启以更新”按钮），下载完不再弹原生对话框。
// 后台定时检查到的更新才弹原生框（否则用户没打开设置就完全无感）。
let manualUpdateCheck = false;

function currentAppVersion() { try { return app.getVersion(); } catch { return null; } }

// 合并并广播更新状态到所有窗口（前端 window.atlasDesktop.updates.onStatus 接收）
function broadcastUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch };
  const payload = { ...updateStatus, current: currentAppVersion() };
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('atlas:update-status', payload); } catch {}
  }
}

// ---- 「用 Atlas 打开这个文件」----
// 来源两条：① macOS 从 Finder「打开方式」/ 双击 → app 'open-file' 事件；
//          ② Windows / Linux 双击或命令行 → 文件路径落在 process.argv 里。
// 主进程只负责把路径接住、转交给前端；前端拿到后走 /api/resolve-open 判断该文件
// 在不在扫描根内，必要时提示把所在目录加为扫描根，然后打开（见 app.js openExternalPath）。
// 冷启动时窗口 / 前端还没就绪：先存进 pendingOpenPath，前端初始化时用
// atlas:take-pending-open 主动来取；已运行时则直接 push 给前端。
let pendingOpenPath = null;
const OPEN_DOC_EXT = new Set(['.md', '.markdown', '.html', '.htm', '.txt', '.text', '.csv', '.tsv', '.json', '.svg']);

// 从一组命令行参数里挑出第一个"存在于磁盘、且是受支持文档类型"的文件路径。
// 跳过选项（- 开头）与自身的脚本参数。
function fileArgFrom(argv) {
  for (const a of (argv || [])) {
    if (!a || typeof a !== 'string' || a.startsWith('-')) continue;
    const ext = path.extname(a).toLowerCase();
    if (!OPEN_DOC_EXT.has(ext)) continue;
    try { if (fs.statSync(a).isFile()) return path.resolve(a); } catch {}
  }
  return null;
}

// 把待打开路径 push 给前端（仅当窗口已建好且页面加载完成）。否则留在 pendingOpenPath 里，
// 由 did-finish-load 或前端的 take-pending-open 兜底。
function flushOpenPath() {
  if (!pendingOpenPath || !mainWindow || mainWindow.isDestroyed()) return;
  const wc = mainWindow.webContents;
  if (wc.isLoading()) return;   // 等 did-finish-load 再发
  const p = pendingOpenPath;
  pendingOpenPath = null;
  wc.send('atlas:open-path', p);
}

// 收到一个待打开路径：记下来，确保有窗口，然后尽力立刻转交。
function handleOpenPath(p) {
  if (!p) return;
  pendingOpenPath = p;
  if (serverInfo) { if (mainWindow) showWindow(); else createWindow(); }
  flushOpenPath();
}

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
    if (isSmoke) { console.log('ATLAS_SMOKE_OK'); cleanupAndExit(0); return; }
    // 冷启动带文件（open-file / argv 在窗口就绪前就到了）：页面加载完再转交
    flushOpenPath();
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
  // 冷启动带文件（Windows / Linux 双击或命令行）：文件路径在 argv 里。
  // macOS 走 open-file 事件（可能已在 will-finish-launching 期间把 pendingOpenPath 填好），
  // 这里不覆盖已有的 pending。
  if (!isSmoke && !pendingOpenPath) {
    const initial = fileArgFrom(process.argv);
    if (initial) pendingOpenPath = initial;
  }
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
      appVersion: app.getVersion(),   // 复用旧 CLI 守护进程前用它校验版本，避免升级后仍加载旧 server
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

  autoUpdater.on('error', (err) => {
    const msg = err && err.message ? err.message : String(err);
    console.error('[updater] error:', msg);
    broadcastUpdateStatus({ state: 'error', error: msg });
    manualUpdateCheck = false;
  });
  autoUpdater.on('checking-for-update', () => broadcastUpdateStatus({ state: 'checking', error: null }));
  autoUpdater.on('update-available', (info) => {
    console.log('[updater] 有新版本:', info && info.version);
    // autoDownload=true，随后进入下载；先把状态切到 downloading（0%）
    broadcastUpdateStatus({ state: 'downloading', version: info && info.version, percent: 0, error: null });
  });
  autoUpdater.on('update-not-available', () => {
    console.log('[updater] 已是最新');
    broadcastUpdateStatus({ state: 'not-available', version: null, error: null });
    manualUpdateCheck = false;
  });
  autoUpdater.on('download-progress', (p) => {
    broadcastUpdateStatus({ state: 'downloading', percent: p && typeof p.percent === 'number' ? Math.round(p.percent) : 0 });
  });
  autoUpdater.on('update-downloaded', async (info) => {
    broadcastUpdateStatus({ state: 'downloaded', version: info && info.version, percent: 100, error: null });
    // 用户主动检查触发的：交给 in-app UI（设置里“重启以更新”按钮），不弹原生框避免重复打扰。
    if (manualUpdateCheck) { manualUpdateCheck = false; return; }
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

// 前端初始化时主动来取"待打开文件"（冷启动场景：open-file / argv 在前端就绪前就到了）。
// 取走即清空，避免和 flushOpenPath 的 push 重复打开同一个文件。
ipcMain.handle('atlas:take-pending-open', () => {
  const p = pendingOpenPath;
  pendingOpenPath = null;
  return p || null;
});

// ---- 桌面自动更新桥：前端设置里的「检查更新」按钮通过 preload 的 updates 调用 ----
// App bundle 的权威版本号。前端优先用它显示，避免复用旧 server 时版本号错乱。
ipcMain.handle('atlas:app-version', () => currentAppVersion());

// 当前更新状态（打开设置时同步一次）。
ipcMain.handle('atlas:update-state', () => ({ ...updateStatus, current: currentAppVersion() }));

// 用户主动检查更新。开发 / 未打包环境没有 app-update.yml，直接返回 unsupported。
ipcMain.handle('atlas:update-check', async () => {
  if (!app.isPackaged) {
    broadcastUpdateStatus({ state: 'unsupported', error: null });
    return { state: 'unsupported', current: currentAppVersion() };
  }
  manualUpdateCheck = true;
  broadcastUpdateStatus({ state: 'checking', error: null });
  try {
    // 有更新时（autoDownload=true）随后经事件进入 downloading → downloaded；
    // 已是最新则经 update-not-available 事件置为 not-available。这里只负责触发。
    const r = await autoUpdater.checkForUpdates();
    return { ...updateStatus, current: currentAppVersion(), latest: r && r.updateInfo ? r.updateInfo.version : null };
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    manualUpdateCheck = false;
    broadcastUpdateStatus({ state: 'error', error: msg });
    return { state: 'error', error: msg, current: currentAppVersion() };
  }
});

// 一键重启并安装已下载好的更新（Squirrel.Mac 替换 bundle 后重启，版本随即变为新版）。
ipcMain.handle('atlas:update-install', () => {
  if (updateStatus.state !== 'downloaded') return { ok: false, error: '还没有已下载完成的更新' };
  quitting = true;
  // 先让本次 IPC 有机会回执，再退出安装
  setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch (e) { console.error('[updater] quitAndInstall 失败:', e); } });
  return { ok: true };
});

// macOS：从 Finder「打开方式」/ 双击文件启动或唤起 Atlas 时走 open-file 事件。
// 必须在 app ready 之前注册（冷启动时它会先于 whenReady 触发），所以放在
// will-finish-launching 里。handleOpenPath 会缓存路径并在窗口就绪后转交前端。
app.on('will-finish-launching', () => {
  app.on('open-file', (e, filePath) => {
    e.preventDefault();
    handleOpenPath(filePath);
  });
});

// 单实例：再次双击/启动时聚焦已有窗口，而不是又起一个
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  // second-instance：已在运行时又双击一个文件（Windows / Linux 把路径放在 argv 里；
  // macOS 走上面的 open-file，argv 里没有，fileArgFrom 返回 null 即只聚焦窗口）
  app.on('second-instance', (_e, argv) => {
    showWindow();
    const p = fileArgFrom(argv);
    if (p) handleOpenPath(p);
  });
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
