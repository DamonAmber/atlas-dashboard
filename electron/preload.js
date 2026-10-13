// 预加载脚本：只向渲染进程（Atlas 前端）暴露一个极小、安全的桥。
// 前端据此判断"我在桌面 App 里"，并把 PDF 导出交给主进程（内置 Chromium 的 printToPDF）。
const { contextBridge, ipcRenderer } = require('electron');

// 读 --name=数字 形式的启动参数；没有或不是有限数时返回 null
function argNum(prefix) {
  const a = (process.argv || []).find(s => typeof s === 'string' && s.startsWith(prefix));
  const v = a ? Number(a.slice(prefix.length)) : NaN;
  return Number.isFinite(v) ? v : null;
}

contextBridge.exposeInMainWorld('atlasDesktop', {
  isDesktop: true,
  electronVersion: process.versions.electron,
  // 返回 { ok:true, savedPath } 或 { ok:false, error }
  exportPdf: (args) => ipcRenderer.invoke('atlas:export-pdf', args),
  // 主进程菜单/快捷键转发过来的命令（目前：多 Tab 的 close-tab / next-tab / prev-tab）。
  // 返回取消订阅函数。
  onMenuCommand: (cb) => {
    const listener = (_e, cmd) => { try { cb(cmd); } catch {} };
    ipcRenderer.on('atlas:menu-command', listener);
    return () => ipcRenderer.removeListener('atlas:menu-command', listener);
  },
  // 关闭当前窗口（多 Tab：无 Tab 可关时，⌘W 回退为关窗，符合原生预期）
  closeWindow: () => ipcRenderer.send('atlas:close-window'),
  // 从 Finder「打开方式」/ 双击 / 命令行传入的文件路径（主进程 open-file / argv）。
  // 前端据此在看板里定位并打开这个文件（必要时先把它所在目录加为扫描根）。
  // 返回取消订阅函数。
  onOpenPath: (cb) => {
    const listener = (_e, p) => { try { cb(p); } catch {} };
    ipcRenderer.on('atlas:open-path', listener);
    return () => ipcRenderer.removeListener('atlas:open-path', listener);
  },
  // 冷启动兜底：前端初始化时主动来取一次"待打开文件"（可能在前端就绪前就到了）。
  // 返回路径字符串或 null。
  takePendingOpen: () => ipcRenderer.invoke('atlas:take-pending-open'),
  // App bundle 的权威版本号（app.getVersion()）。前端设置里优先用它显示，
  // 避免复用旧 server 时 /api/config 返回旧 pkg.version 造成"升级后仍显示旧版本"。
  appVersion: () => ipcRenderer.invoke('atlas:app-version'),
  // 平台字符串（只读，不暴露任何能力）。index.html 防闪脚本据此写 html[data-desktop]，
  // 原生化 CSS 只在这个属性下生效，浏览器版天然不受影响。
  platform: process.platform,
  // 首帧外壳参数（主进程经 additionalArguments 传入，见 main.js / titlebar.js）：
  // titlebarInset = 红绿灯组右缘 + 12px 留白；reducedTransparency = 系统「降低透明度」
  titlebarInset: argNum('--atlas-titlebar-inset='),
  reducedTransparency: argNum('--atlas-reduce-transparency=') === 1,
  // Atlas 主题（system / light / dark）同步给 nativeTheme.themeSource，让 vibrancy 材质跟着走
  setTheme: (mode) => ipcRenderer.send('atlas:set-theme', mode),
  // 外壳状态（目前只有 { focusMode }）：专注模式时隐藏红绿灯
  setChromeState: (s) => ipcRenderer.send('atlas:set-chrome-state', s),
  // 主进程推送的窗口状态（{ fullscreen }）。返回取消订阅函数。
  onWindowState: (cb) => {
    const listener = (_e, s) => { try { cb(s); } catch {} };
    ipcRenderer.on('atlas:window-state', listener);
    return () => ipcRenderer.removeListener('atlas:window-state', listener);
  },
  // 桌面自动更新桥（electron-updater）：检查 / 查询状态 / 订阅状态推送 / 一键重启安装。
  updates: {
    getState: () => ipcRenderer.invoke('atlas:update-state'),
    check: () => ipcRenderer.invoke('atlas:update-check'),
    quitAndInstall: () => ipcRenderer.invoke('atlas:update-install'),
    // 订阅主进程推送的更新状态（checking / downloading 进度 / downloaded / error）。返回取消订阅函数。
    onStatus: (cb) => {
      const listener = (_e, s) => { try { cb(s); } catch {} };
      ipcRenderer.on('atlas:update-status', listener);
      return () => ipcRenderer.removeListener('atlas:update-status', listener);
    },
  },
});
