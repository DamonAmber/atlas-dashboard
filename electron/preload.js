// 预加载脚本：只向渲染进程（Atlas 前端）暴露一个极小、安全的桥。
// 前端据此判断"我在桌面 App 里"，并把 PDF 导出交给主进程（内置 Chromium 的 printToPDF）。
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('atlasDesktop', {
  isDesktop: true,
  electronVersion: process.versions.electron,
  // 返回 { ok:true, savedPath } 或 { ok:false, error }
  exportPdf: (args) => ipcRenderer.invoke('atlas:export-pdf', args),
});
