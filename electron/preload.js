// 预加载脚本：只向渲染进程（Atlas 前端）暴露一个极小、安全的桥。
// 前端据此判断"我在桌面 App 里"，并把 PDF 导出交给主进程（内置 Chromium 的 printToPDF）。
const { contextBridge, ipcRenderer } = require('electron');

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
