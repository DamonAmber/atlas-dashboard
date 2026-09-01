// Electron 外壳的服务端管理器（纯 Node，刻意不 import electron，方便用普通 node 冒烟测试）。
//
// 职责：
//   1. 确保 ~/.atlas/config.json 存在 —— server.js 在配置缺失时会 process.exit(1)，
//      所以桌面 App 首次启动必须先写一份默认配置（用户之后可在设置里改扫描目录）。
//   2. 复用已在跑的 Atlas（CLI 守护进程）—— 避免两个 server 同时写 store.json / 重复挂监听。
//   3. 挑一个空闲端口，spawn server.js。在 Electron 主进程里 nodeBinary 是 Electron 可执行文件，
//      配合 ELECTRON_RUN_AS_NODE=1 让它以纯 Node 模式跑 server.js（无需另外打包一份 Node 运行时）。
//   4. 健康检查（GET /api/state）确认服务真的起来了，再让窗口去加载。

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const paths = require('../lib/paths');
const { DEFAULT_IGNORE } = require('../lib/init');

const ROOT_DIR = path.join(__dirname, '..');
const SERVER_FILE = path.join(ROOT_DIR, 'server.js');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// 首次启动写入的默认配置：优先扫 ~/Documents，没有就退回 home。
function defaultConfig() {
  const docs = path.join(os.homedir(), 'Documents');
  const root = fs.existsSync(docs) ? docs : os.homedir();
  return {
    scanRoots: [root],
    ignore: DEFAULT_IGNORE,
    port: 4321,
    maxDepth: 6,
    docTypes: ['html', 'md'],
  };
}

// 确保配置文件存在；不存在则写默认。返回 { created, path }。
function ensureConfig() {
  paths.ensureConfigDir();
  const cp = paths.configPath();
  if (!fs.existsSync(cp)) {
    fs.writeFileSync(cp, JSON.stringify(defaultConfig(), null, 2), 'utf8');
    return { created: true, path: cp };
  }
  return { created: false, path: cp };
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(paths.configPath(), 'utf8')); }
  catch { return null; }
}

// 从 start 起找一个能监听的端口（127.0.0.1）。
function findFreePort(start = 4321, maxTry = 40) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + maxTry) return reject(new Error('找不到空闲端口'));
      const s = net.createServer();
      s.once('error', () => { try { s.close(); } catch {} tryPort(p + 1); });
      s.once('listening', () => { const port = s.address().port; s.close(() => resolve(port)); });
      // 不指定 host，和 server.js 的 app.listen(PORT) 一致（绑 :: 双栈）。
      // 若探测时绑 127.0.0.1，会漏判一个绑在 :: 上的占用者（如 CLI 守护进程），
      // 导致挑出的端口其实被占，spawn 的 server 撞 EADDRINUSE 后退出。
      s.listen(p);
    };
    tryPort(start);
  });
}

// GET /api/state 通了就算健康。
function healthCheck(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/state`, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// 读 CLI 写的 pid 文件，进程还活着就返回它记录的端口，用于复用已运行实例。
// 兼容旧版纯数字 pid 格式。
function readRunningPort() {
  try {
    const raw = fs.readFileSync(paths.pidPath(), 'utf8').trim();
    const obj = /^\d+$/.test(raw) ? { pid: parseInt(raw, 10) } : JSON.parse(raw);
    if (!obj || typeof obj.pid !== 'number') return null;
    try { process.kill(obj.pid, 0); } catch { return null; }   // 进程已不在
    return obj.port || null;
  } catch { return null; }
}

async function waitForHealth(port, { attempts = 40, interval = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await healthCheck(port, 500)) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

/**
 * 启动（或复用）Atlas 服务。
 * @param {object} opts
 * @param {string} opts.nodeBinary  用来跑 server.js 的可执行文件（Electron 里传 process.execPath）
 * @param {boolean} opts.asElectronNode 是否加 ELECTRON_RUN_AS_NODE=1（Electron 主进程里为 true）
 * @param {(line:string)=>void} [opts.onLog] server 的 stdout/stderr 回调
 * @returns {Promise<{url,port,child,reused}>}
 */
async function startServer({ nodeBinary, asElectronNode = false, onLog } = {}) {
  ensureConfig();

  // 已有健康实例（多半是 CLI 的 `atlas start` 守护进程）→ 直接复用，不再起第二个
  const runningPort = readRunningPort();
  if (runningPort && await healthCheck(runningPort)) {
    return { url: `http://127.0.0.1:${runningPort}`, port: runningPort, child: null, reused: true };
  }

  const cfg = readConfig() || {};
  const wantPort = cfg.port || 4321;
  const port = await findFreePort(wantPort);

  const env = {
    ...process.env,
    ATLAS_CONFIG_PATH: paths.configPath(),
    ATLAS_STORE_PATH: paths.storePath(),
    ATLAS_PUBLIC_DIR: PUBLIC_DIR,
    ATLAS_PORT: String(port),
    ATLAS_ELECTRON: '1',   // 让 server / 前端将来能识别"跑在桌面 App 里"（比如换掉 npm 升级提示）
  };
  if (asElectronNode) env.ELECTRON_RUN_AS_NODE = '1';

  const child = spawn(nodeBinary, [SERVER_FILE], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  if (onLog) {
    child.stdout.on('data', d => onLog(String(d)));
    child.stderr.on('data', d => onLog(String(d)));
  }

  const ok = await waitForHealth(port);
  if (!ok) {
    try { child.kill('SIGKILL'); } catch {}
    throw new Error(`server 在预期时间内没有在 :${port} 响应`);
  }
  return { url: `http://127.0.0.1:${port}`, port, child, reused: false };
}

module.exports = {
  ensureConfig,
  readConfig,
  defaultConfig,
  findFreePort,
  healthCheck,
  readRunningPort,
  waitForHealth,
  startServer,
  SERVER_FILE,
  PUBLIC_DIR,
};
