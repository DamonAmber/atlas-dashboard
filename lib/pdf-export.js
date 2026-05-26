// 把本地 HTML 文件用本机 Chromium（Chrome / Edge / Brave / Arc / Chromium）渲染成 PDF
// 路径检测覆盖 macOS / Linux / Windows 常见安装位置；找不到时返回 null 让上层降级

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

// 候选路径——按用户体感优先级（Chrome 用得最多）
function chromiumCandidates() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      ['Google Chrome',    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
      ['Microsoft Edge',   '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
      ['Brave',            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
      ['Arc',              '/Applications/Arc.app/Contents/MacOS/Arc'],
      ['Chromium',         '/Applications/Chromium.app/Contents/MacOS/Chromium'],
      ['Vivaldi',          '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi'],
    ];
  }
  if (process.platform === 'linux') {
    return [
      ['Google Chrome',    '/usr/bin/google-chrome'],
      ['Google Chrome',    '/usr/bin/google-chrome-stable'],
      ['Chromium',         '/usr/bin/chromium'],
      ['Chromium',         '/usr/bin/chromium-browser'],
      ['Microsoft Edge',   '/usr/bin/microsoft-edge'],
      ['Brave',            '/usr/bin/brave-browser'],
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local');
    return [
      ['Google Chrome',  path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['Google Chrome',  path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['Google Chrome',  path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['Microsoft Edge', path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      ['Microsoft Edge', path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      ['Brave',          path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')],
    ];
  }
  return [];
}

function findChromium() {
  for (const [name, p] of chromiumCandidates()) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return { name, path: p };
    } catch {}
  }
  return null;
}

function downloadsDir() {
  return path.join(os.homedir(), 'Downloads');
}

// 文件名清洗：去掉斜杠/冒号等，保留中文
function sanitizeFileName(name) {
  return name
    .replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200) || 'export';
}

// 找一个不冲突的文件名：foo.pdf → foo.pdf 不存在直接用，否则 foo (2).pdf, foo (3).pdf, ...
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

// 把 HTML 文件路径转成 file:// URL（注意 Windows 反斜杠）
function fileUrl(absPath) {
  let p = absPath.replace(/\\/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + encodeURI(p).replace(/#/g, '%23');
}

// 串行队列——快速连续 spawn 多个 chromium 会因为内部状态冲突全部失败；同时只允许一个跑
let _exportQueue = Promise.resolve();
function exportPdf(args, onPhase) {
  const next = _exportQueue.then(() => _doExportPdfWithRetry(args, onPhase));
  _exportQueue = next.catch(() => {});  // 队列吞掉异常，不让单次失败阻塞后续
  return next;
}

// Chrome --headless 偶尔会因 "Trying to load the allocator multiple times" 警告
// 被信号 kill 而不写出 PDF——这是 Chrome 内部的 intermittent bug。重试一次通常就好
async function _doExportPdfWithRetry(args, onPhase) {
  const r1 = await _doExportPdf(args, onPhase);
  if (r1.ok) return r1;
  // 只对 render-failed 重试（其他错误如 no-chromium / source-missing 重试无意义）
  if (r1.reason !== 'render-failed') return r1;
  if (onPhase) onPhase({ phase: 'retrying', message: '首次失败，重试中…' });
  await new Promise(r => setTimeout(r, 400));
  const r2 = await _doExportPdf(args, onPhase);
  return r2.ok ? r2 : r1; // 重试还失败的话返回首次的 error，避免覆盖
}

// 导出主入口：返回 { ok, savedPath?, browser?, reason? }
async function _doExportPdf({ htmlPath, fileName }, onPhase) {
  const emit = (p) => { try { onPhase && onPhase(p); } catch {} };
  if (!htmlPath || !fs.existsSync(htmlPath)) {
    return { ok: false, reason: 'source-missing' };
  }
  const browser = findChromium();
  if (!browser) {
    return { ok: false, reason: 'no-chromium' };
  }
  emit({ phase: 'launching', message: `启动 ${browser.name}…`, browser: browser.name });
  const dir = downloadsDir();
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {
      return { ok: false, reason: 'no-downloads-dir' };
    }
  }

  const safeStem = sanitizeFileName(fileName || path.basename(htmlPath, '.html') || 'export');
  const outPath = nonConflictingPath(dir, safeStem + '.pdf');

  // Chrome headless flags：
  // --headless=new           Chrome 109+ 的新无头（更好的字体 / fixed 元素 / 复杂布局）
  // --disable-gpu            旧 Mac 兼容；新 Mac 上无害
  // --no-pdf-header-footer   去掉默认页眉页脚（"file:///..." / 页码 / 时间戳）
  // --print-to-pdf=<path>    输出路径
  // --virtual-time-budget=8000  等待异步渲染最多 8s（图表 / 字体 / SVG 动画）
  // --hide-scrollbars        防止 PDF 上印出滚动条
  // --no-sandbox             某些 Linux/Docker 环境必需；macOS 用户态无害
  // 最后是 file:// URL
  // 独立 user-data-dir：避免和用户当前正在跑的 Chrome 冲突
  // （Chrome 单实例机制对 user-data-dir 加锁；不加 --user-data-dir 时 headless
  // 会因检测到已有 Chrome 实例报 "Trying to load the allocator multiple times"）
  const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-pdf-'));

  // 用 --headless=old：成熟稳定，PDF 功能久经考验。--headless=new 在某些 Chrome 版本上
  // 会出 "Trying to load the allocator multiple times" 然后被信号 kill
  const args = [
    '--headless=old',
    '--disable-gpu',
    '--no-pdf-header-footer',
    '--hide-scrollbars',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--disable-background-networking',
    `--user-data-dir=${tmpProfile}`,
    `--virtual-time-budget=8000`,
    `--print-to-pdf=${outPath}`,
    fileUrl(htmlPath),
  ];

  const cleanupProfile = () => {
    try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch {}
  };

  return new Promise((resolve) => {
    const child = spawn(browser.path, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // 设一个超时——避免文件渲染卡住时永远不返回
    });
    let stderr = '';
    let renderingEmitted = false;
    let writingEmitted = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // chromium 一旦开始 stderr 输出（通常是 "Created TensorFlow Lite XNNPACK..." 或别的初始化信息），
      // 说明启动完成、即将开始渲染页面
      if (!renderingEmitted) {
        renderingEmitted = true;
        emit({ phase: 'rendering', message: '正在渲染页面…' });
      }
    });
    // 兜底：3s 内若 stderr 还没输出，也认为已进入渲染态——不要让用户看半天 "启动中"
    const renderingFallback = setTimeout(() => {
      if (!renderingEmitted) {
        renderingEmitted = true;
        emit({ phase: 'rendering', message: '正在渲染页面…' });
      }
    }, 3000);
    // 监测 PDF 文件何时被创建——chromium 渲染完之后才会写文件，文件出现 = 进入"写入"阶段
    const writePoll = setInterval(() => {
      if (!writingEmitted && fs.existsSync(outPath)) {
        writingEmitted = true;
        emit({ phase: 'writing', message: '正在写入 PDF…' });
      }
    }, 250);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
    }, 30_000); // 30s 硬超时

    const cleanupAll = () => {
      clearTimeout(timer);
      clearTimeout(renderingFallback);
      clearInterval(writePoll);
      cleanupProfile();
    };

    child.on('error', (err) => {
      cleanupAll();
      resolve({ ok: false, reason: 'spawn-failed', message: err.message, browser: browser.name });
    });
    child.on('exit', (code) => {
      cleanupAll();
      // 判定标准：PDF 文件存在且 > 0 字节即视为成功——
      // Chrome --headless 即使因为 allocator/v8 警告被信号 kill（exit code = null）
      // 实际文件也已经成功落地，没必要因为退出码报错让用户白干一场
      let ok = false;
      let size = 0;
      try {
        if (fs.existsSync(outPath)) {
          size = fs.statSync(outPath).size;
          ok = size > 0;
        }
      } catch {}
      if (ok) {
        resolve({ ok: true, savedPath: outPath, browser: browser.name, size });
      } else {
        resolve({
          ok: false,
          reason: 'render-failed',
          exitCode: code,
          message: stderr.split('\n').filter(l => l && !l.startsWith('[')).slice(0, 3).join('\n'),
          browser: browser.name,
        });
      }
    });
  });
}

module.exports = {
  exportPdf,
  findChromium,
  downloadsDir,
};
