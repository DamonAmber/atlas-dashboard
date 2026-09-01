// 桌面 App 的 PDF 导出（主进程）：用 Electron 内置 Chromium 的 webContents.printToPDF，
// 不依赖用户本机是否装了 Chrome。流程：
//   1) 让本地 server 把文档渲染成"打印版 HTML"落到临时文件（POST /api/export-pdf-html，
//      复用服务端现有渲染），拿到 htmlPath；
//   2) 用一个隐藏窗口加载这份 HTML，等图表/公式渲染完，printToPDF；
//   3) 存到 ~/Downloads（自动避重名）。
//
// 非 Electron（浏览器 / npm 用户）不走这里，仍用 server 的 /api/export-pdf + 系统 Chromium。

const { BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function downloadsDir() { return path.join(os.homedir(), 'Downloads'); }

// 与 lib/pdf-export.js 同口径的文件名清洗（去非法字符、保留中文）
function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200) || 'export';
}

// foo.pdf 已存在就 foo (2).pdf, foo (3).pdf …
function nonConflictingPath(dir, baseName) {
  let candidate = path.join(dir, baseName);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, -ext.length);
  for (let i = 2; i < 1000; i++) {
    candidate = path.join(dir, `${stem} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return candidate;
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': data.length },
    }, (res) => {
      let buf = '';
      res.on('data', d => buf += d);
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(buf) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('渲染请求超时')); });
    req.write(data); req.end();
  });
}

/**
 * @param {object} opts
 * @param {string} opts.serverUrl  本地 server 基址，如 http://127.0.0.1:4321
 * @param {string} opts.filePath   要导出的文档绝对路径
 * @param {string} [opts.fileName] 输出 PDF 的文件名（不含扩展名）
 * @returns {Promise<{ok:true, savedPath:string} | {ok:false, error:string, reason?:string}>}
 */
async function exportPdf({ serverUrl, filePath, fileName }) {
  // 1) 服务端渲染打印版 HTML
  let prep;
  try {
    prep = await postJson(`${serverUrl}/api/export-pdf-html`, { path: filePath });
  } catch (e) {
    return { ok: false, error: '无法连接本地服务：' + e.message };
  }
  if (!prep.json || !prep.json.ok) {
    const j = prep.json || {};
    return { ok: false, error: j.message || `渲染失败 (HTTP ${prep.status})`, reason: j.reason };
  }
  const { htmlPath, tempDir } = prep.json;

  // 2) 隐藏窗口加载 → printToPDF
  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1400,
    webPreferences: {
      // 这个窗口只加载我们自己生成的、本机可信的打印 HTML，且要能读 file:// 下的
      // 图片与 vendor 脚本（mermaid/katex），所以关掉 webSecurity。用完即销毁。
      webSecurity: false,
      javascript: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  try {
    await win.loadFile(htmlPath);
    // 等图表(mermaid)/公式(katex)异步渲染完成。服务端系统 Chromium 路径用的是
    // --virtual-time-budget=8000；这里用固定等待覆盖绝大多数文档，重度图表文档可后续再调。
    await new Promise(r => setTimeout(r, 1800));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' },
    });
    const dir = downloadsDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const out = nonConflictingPath(dir, sanitizeFileName(fileName) + '.pdf');
    fs.writeFileSync(out, pdf);
    return { ok: true, savedPath: out };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    try { win.destroy(); } catch {}
    if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = { exportPdf };
