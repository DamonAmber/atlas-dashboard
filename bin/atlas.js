#!/usr/bin/env node
// Atlas CLI 入口
//
// 用法：
//   atlas                       前台启动（首次会引导配置；Ctrl+C 退出）
//   atlas start                 后台启动，写 PID + 日志，立即返回
//   atlas stop                  停止后台服务
//   atlas restart               重启后台服务
//   atlas status                显示运行状态（pid / url / 健康检查）
//   atlas log                   tail -f 日志（Ctrl+C 退出）
//   atlas init                  重新进入交互引导（不启动）
//   atlas --port <n>            临时使用其他端口
//   atlas --root <path>         临时加扫描根（可重复）
//   atlas --config              打印配置文件路径
//   atlas --version / -v
//   atlas --help / -h

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const paths = require('../lib/paths');
const { runInit } = require('../lib/init');
const updateCheck = require('../lib/update-check');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SERVER_FILE = path.join(__dirname, '..', 'server.js');
const SUBCOMMANDS = new Set(['start', 'stop', 'restart', 'status', 'log', 'init']);

// ==================== 参数解析 ====================
function parseArgs(argv) {
  const args = {
    port: null,
    extraRoots: [],
    init: false,
    showConfig: false,
    help: false,
    version: false,
    _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--reset-config' || a === '--reset') args.init = true;
    else if (a === '--config') args.showConfig = true;
    else if (a === '--port' || a === '-p') {
      args.port = parseInt(argv[++i], 10);
      if (!args.port) fail('--port 需要一个数字');
    } else if (a.startsWith('--port=')) {
      args.port = parseInt(a.slice(7), 10);
      if (!args.port) fail('--port 需要一个数字');
    } else if (a === '--root' || a === '-r') {
      args.extraRoots.push(paths.expand(argv[++i] || ''));
    } else if (a.startsWith('--root=')) {
      args.extraRoots.push(paths.expand(a.slice(7)));
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fail(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

function printHelp() {
  console.log(`
Atlas — 本地 HTML 文档统一浏览/管理 dashboard

用法:
  atlas                     前台启动（首次会引导配置；Ctrl+C 退出）
  atlas start               后台启动，写 PID 与日志后立即返回
  atlas stop                停止后台服务
  atlas restart             重启后台服务
  atlas status              显示运行状态（pid / url / 健康检查）
  atlas log                 tail -f 日志，跟随输出
  atlas init                重新进入交互引导（仅配置，不启动）

选项:
  --port <n>                临时使用其他端口（不写回配置）
  --root <path>             临时加扫描根目录，可重复（不写回配置）
  --config                  打印配置文件路径
  --version, -v             打印版本号
  --help, -h                显示本帮助

环境变量:
  ATLAS_HOME                覆盖配置存储目录（默认 ~/.atlas）

文件位置:
  配置: ${paths.configPath()}
  存储: ${paths.storePath()}
  日志: ${paths.logPath()}
  PID:  ${paths.pidPath()}
`);
}

// ==================== 进程探活 ====================
function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// PID 文件存 JSON：{ pid, port, startedAt }；兼容旧版的纯数字格式
function readPidFile() {
  try {
    const raw = fs.readFileSync(paths.pidPath(), 'utf8').trim();
    if (/^\d+$/.test(raw)) return { pid: parseInt(raw, 10) };
    const obj = JSON.parse(raw);
    return obj && typeof obj.pid === 'number' ? obj : null;
  } catch { return null; }
}

function writePidFile({ pid, port }) {
  fs.writeFileSync(paths.pidPath(), JSON.stringify({
    pid, port, startedAt: Date.now(),
  }));
}

function readPid() {
  const data = readPidFile();
  if (!data || !isAlive(data.pid)) return null;
  return data.pid;
}

function readRunning() {
  const data = readPidFile();
  if (!data || !isAlive(data.pid)) return null;
  return data;
}

function clearPidFile() {
  try { fs.unlinkSync(paths.pidPath()); } catch {}
}

// ==================== 端口探测 / 健康检查 ====================
function findAvailablePort(start, maxTry = 20) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      if (p > start + maxTry) return resolve(start);
      const s = net.createServer();
      s.once('error', (err) => {
        try { s.close(); } catch {}
        if (err.code === 'EADDRINUSE') tryPort(p + 1);
        else resolve(p);
      });
      s.once('listening', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
      s.listen(p);
    };
    tryPort(start);
  });
}

function healthCheck(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/state`, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
  });
}

// ==================== 配置 / 环境组装 ====================
function loadConfig() {
  const cp = paths.configPath();
  if (!fs.existsSync(cp)) return null;
  try { return JSON.parse(fs.readFileSync(cp, 'utf8')); } catch { return null; }
}

// 应用 CLI 临时覆盖（比如 --root），返回 server 应该读的 config 路径
// 如果有 override，写一个 .runtime-config.json，server 读它，原 config 不动
function buildRuntimeConfig(args, baseConfig) {
  if (args.extraRoots.length === 0) {
    return paths.configPath();
  }
  const merged = {
    ...baseConfig,
    scanRoots: [...(baseConfig.scanRoots || []), ...args.extraRoots],
  };
  const tmpPath = path.join(paths.configDir(), '.runtime-config.json');
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2));
  return tmpPath;
}

function buildEnv(runtimeConfigPath, port) {
  return {
    ...process.env,
    ATLAS_CONFIG_PATH: runtimeConfigPath,
    ATLAS_STORE_PATH: paths.storePath(),
    ATLAS_PUBLIC_DIR: PUBLIC_DIR,
    ATLAS_PORT: String(port),
  };
}

// 确保配置就绪：不存在就跑首次引导
async function ensureConfig(args) {
  paths.ensureConfigDir();
  const cp = paths.configPath();
  const force = args.init;
  if (force || !fs.existsSync(cp)) {
    let existing = null;
    if (fs.existsSync(cp)) {
      try { existing = JSON.parse(fs.readFileSync(cp, 'utf8')); } catch {}
    }
    await runInit({ existingConfig: existing, force });
  }
}

// ==================== 子命令实现 ====================
async function cmdStart(args) {
  const existing = readPid();
  if (existing) {
    console.error(`✗ Atlas 已在运行（pid ${existing}），用 'atlas restart' 重启`);
    process.exit(1);
  }
  await ensureConfig(args);
  const baseConfig = loadConfig() || {};
  const runtimeConfigPath = buildRuntimeConfig(args, baseConfig);
  const wantPort = args.port || baseConfig.port || 4321;
  const port = await findAvailablePort(wantPort);
  if (port !== wantPort) {
    console.log(`  端口 ${wantPort} 被占用，自动切到 ${port}`);
  }

  const env = buildEnv(runtimeConfigPath, port);

  // 后台启动：daemon 模式
  const out = fs.openSync(paths.logPath(), 'a');
  const child = spawn(process.execPath, [SERVER_FILE], {
    env,
    detached: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  writePidFile({ pid: child.pid, port });

  console.log(`Atlas 启动中... (pid ${child.pid})`);

  // 等到健康检查通过或超时
  let ok = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await healthCheck(port, 500)) { ok = true; break; }
    // 进程已经死了？
    if (!isAlive(child.pid)) break;
  }

  if (ok) {
    console.log(`  ✓ Atlas 运行中 → http://localhost:${port}`);
  } else if (!isAlive(child.pid)) {
    clearPidFile();
    console.error(`  ✗ 启动失败，查看日志: atlas log（或 cat ${paths.logPath()}）`);
    process.exit(1);
  } else {
    console.warn(`  ! 进程已起，但 :${port} 在 4 秒内未响应；查看日志: atlas log`);
  }
  console.log(`  日志: ${paths.logPath()}`);
  printUpdateNotice();
}

async function cmdStop({ silentIfStopped = false } = {}) {
  const pid = readPid();
  if (!pid) {
    clearPidFile();
    if (!silentIfStopped) console.log('● Atlas 未在运行');
    return;
  }
  console.log(`停止 Atlas (pid ${pid})...`);
  try { process.kill(pid, 'SIGTERM'); } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
  // 等待最多 2 秒优雅退出
  for (let i = 0; i < 40 && isAlive(pid); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (isAlive(pid)) {
    console.log('  优雅退出超时，强制 kill');
    try { process.kill(pid, 'SIGKILL'); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  clearPidFile();
  // 顺便清理 runtime config
  try { fs.unlinkSync(path.join(paths.configDir(), '.runtime-config.json')); } catch {}
  console.log('  ✓ 已停止');
}

async function cmdRestart(args) {
  await cmdStop({ silentIfStopped: true });
  await new Promise(r => setTimeout(r, 300));
  await cmdStart(args);
}

async function cmdStatus() {
  const running = readRunning();
  const cfg = loadConfig() || {};

  if (!running) {
    console.log('● Atlas: 未运行');
    console.log(`  config:  ${paths.configPath()}${fs.existsSync(paths.configPath()) ? '' : ' (不存在)'}`);
    return;
  }

  // 优先用 PID 文件里记录的实际端口（处理"端口冲突时自动切换"的情况）
  const port = running.port || cfg.port || 4321;
  const alive = await healthCheck(port, 1500);
  console.log(`● Atlas: ${alive ? '运行中' : '进程存在但未响应'}`);
  console.log(`  pid:     ${running.pid}`);
  console.log(`  url:     http://localhost:${port}`);
  if (running.startedAt) {
    const mins = Math.floor((Date.now() - running.startedAt) / 60000);
    const human = mins < 1 ? '刚刚启动' :
                  mins < 60 ? `已运行 ${mins} 分钟` :
                  mins < 1440 ? `已运行 ${Math.floor(mins/60)} 小时 ${mins%60} 分` :
                  `已运行 ${Math.floor(mins/1440)} 天`;
    console.log(`  uptime:  ${human}`);
  }
  console.log(`  config:  ${paths.configPath()}`);
  console.log(`  log:     ${paths.logPath()}`);
  if (cfg.scanRoots) {
    console.log(`  扫描根:`);
    cfg.scanRoots.forEach(r => console.log(`    · ${r}`));
  }
  printUpdateNotice();
}

function cmdLog() {
  const lp = paths.logPath();
  if (!fs.existsSync(lp)) {
    console.log(`日志文件不存在: ${lp}`);
    console.log(`(后台启动 'atlas start' 后会创建)`);
    return;
  }
  const content = fs.readFileSync(lp, 'utf8');
  const lines = content.split('\n');
  process.stdout.write(lines.slice(-100).join('\n'));
  if (!content.endsWith('\n')) process.stdout.write('\n');
  console.log('--- 跟随中（Ctrl+C 退出） ---');
  let lastSize = fs.statSync(lp).size;
  fs.watchFile(lp, { interval: 250 }, (curr) => {
    if (curr.size > lastSize) {
      const fd = fs.openSync(lp, 'r');
      const buf = Buffer.alloc(curr.size - lastSize);
      fs.readSync(fd, buf, 0, buf.length, lastSize);
      fs.closeSync(fd);
      process.stdout.write(buf);
      lastSize = curr.size;
    } else if (curr.size < lastSize) {
      // 日志被截断或轮转
      lastSize = curr.size;
    }
  });
  process.on('SIGINT', () => process.exit(0));
}

async function cmdInit(args) {
  await ensureConfig({ ...args, init: true });
  console.log('提示: 用 atlas / atlas start 启动服务');
}

// 默认（无子命令）：前台启动
async function cmdForeground(args) {
  printUpdateNotice();
  const existing = readPid();
  if (existing) {
    console.warn(`! 注意：已有后台 Atlas 运行（pid ${existing}），即将启动一个新前台实例。`);
    console.warn(`  如需停止后台：另开终端跑 'atlas stop'`);
  }
  await ensureConfig(args);
  const baseConfig = loadConfig() || {};
  const runtimeConfigPath = buildRuntimeConfig(args, baseConfig);
  const wantPort = args.port || baseConfig.port || 4321;
  const port = await findAvailablePort(wantPort);
  if (port !== wantPort) {
    console.log(`  端口 ${wantPort} 被占用，自动切到 ${port}`);
  }
  const env = buildEnv(runtimeConfigPath, port);

  const child = spawn(process.execPath, [SERVER_FILE], { env, stdio: 'inherit' });

  const cleanup = () => {
    if (runtimeConfigPath !== paths.configPath()) {
      try { fs.unlinkSync(runtimeConfigPath); } catch {}
    }
  };
  child.on('exit', (code) => { cleanup(); process.exit(code || 0); });
  process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch {} });
  process.on('SIGTERM', () => { try { child.kill('SIGTERM'); } catch {} });
  process.on('exit', cleanup);
}

// ==================== main ====================
function printUpdateNotice() {
  const r = updateCheck.getCachedResult(pkg.version);
  if (!r) return;
  // 框格式提示
  const cmd = `npm i -g atlas-dashboard@latest`;
  const lines = [
    '',
    `  ╭─ Atlas: 新版本可用 ──`,
    `  │  ${r.current}  →  ${r.latest}`,
    `  │  升级: ${cmd}`,
    `  ╰─`,
    '',
  ];
  console.log(lines.join('\n'));
}

async function main() {
  // 后台异步检查更新，不阻塞主流程
  updateCheck.refreshInBackground(pkg.name);

  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  if (args.version) return console.log(pkg.version);
  if (args.showConfig) {
    console.log('config:', paths.configPath());
    console.log('store: ', paths.storePath());
    console.log('log:   ', paths.logPath());
    console.log('pid:   ', paths.pidPath());
    return;
  }

  const sub = args._[0];
  if (sub && !SUBCOMMANDS.has(sub)) {
    fail(`未知子命令: ${sub}\n  运行 'atlas --help' 查看可用命令`);
  }

  switch (sub) {
    case 'start':   return cmdStart(args);
    case 'stop':    return cmdStop();
    case 'restart': return cmdRestart(args);
    case 'status':  return cmdStatus();
    case 'log':     return cmdLog();
    case 'init':    return cmdInit(args);
    default:        return cmdForeground(args);
  }
}

main().catch((e) => {
  console.error('Atlas CLI 错误:', e.stack || e.message);
  process.exit(1);
});
