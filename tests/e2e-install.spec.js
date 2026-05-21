// 端到端：模拟全新机器 npx 安装 + 首次引导 + 启动
// 1. 解压 tgz 到临时目录
// 2. npm install
// 3. 用一个临时 ATLAS_HOME 触发 runInit（用 prompts.inject 注入答案）
// 4. 验证 config.json 写入正确
// 5. 启动 server，验证 /api/state
// 6. 清理

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const http = require('http');

const PROJECT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-e2e-'));
const ATLAS_HOME = path.join(TMP, 'home', '.atlas');
const PKG_DIR = path.join(TMP, 'pkg');
let testRoot = null;
let serverProc = null;

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function main() {
  console.log('TMP:', TMP);

  // 1. 找 tgz
  const tgz = fs.readdirSync(PROJECT).find(f => /^atlas-dashboard-.*\.tgz$/.test(f));
  if (!tgz) { console.error('没有 tgz，先运行 npm pack'); process.exit(1); }
  console.log('使用 tgz:', tgz);

  // 2. 解压并装依赖
  fs.mkdirSync(PKG_DIR, { recursive: true });
  execSync(`tar -xzf "${path.join(PROJECT, tgz)}" -C "${PKG_DIR}"`);
  const installedDir = path.join(PKG_DIR, 'package');
  console.log('装依赖中（仅生产依赖）...');
  execSync(`npm install --omit=dev --silent`, { cwd: installedDir, stdio: 'inherit' });

  // 3. 准备一个用于扫描的根目录（含一个 HTML）
  testRoot = path.join(TMP, 'docs');
  fs.mkdirSync(path.join(testRoot, 'project1'), { recursive: true });
  fs.writeFileSync(path.join(testRoot, 'project1', 'a.html'), '<html><body>hi A</body></html>');
  fs.writeFileSync(path.join(testRoot, 'project1', 'b.html'), '<html><body>hi B</body></html>');

  // 4. 触发 runInit（用 prompts.inject 喂答案，绕过交互）
  const initScript = `
    const prompts = require('prompts');
    prompts.inject([
      ${JSON.stringify(testRoot)},   // scanRoots
      4399,                            // port
      'node_modules,.git',             // ignore
      4,                               // maxDepth
    ]);
    require('./lib/init').runInit().then(c => {
      console.log(JSON.stringify(c));
    }).catch(e => { console.error(e); process.exit(1); });
  `;
  const out = execSync(`node -e "${initScript.replace(/"/g, '\\"')}"`, {
    cwd: installedDir,
    env: { ...process.env, ATLAS_HOME },
    encoding: 'utf8',
  });
  // 抽出最后一行的 JSON（前面有 prompts 的输出）
  const lastLine = out.trim().split('\n').pop();
  const config = JSON.parse(lastLine);
  console.log('runInit 返回:', config);

  check('runInit 写入配置', fs.existsSync(path.join(ATLAS_HOME, 'config.json')));
  check('config 包含 scanRoots', Array.isArray(config.scanRoots) && config.scanRoots[0] === testRoot);
  check('config 包含 port', config.port === 4399);

  // 5. 启动 server（通过 bin/atlas.js）
  console.log('\n启动 server...');
  serverProc = spawn(process.execPath, [path.join(installedDir, 'bin', 'atlas.js')], {
    env: { ...process.env, ATLAS_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  serverProc.stdout.on('data', d => stdout += d);
  serverProc.stderr.on('data', d => stderr += d);

  // 等待 listen
  await new Promise(res => setTimeout(res, 2000));
  const listening = stdout.includes('localhost:4399') || stdout.includes('Atlas dashboard');
  check('server 启动并监听 4399', listening, stdout.split('\n').filter(Boolean).slice(-3).join(' | '));

  // 6. 验证 API
  try {
    const r = await get('http://localhost:4399/api/state');
    check('GET /api/state 返回 200', r.status === 200);
    const data = JSON.parse(r.body);
    check('扫描到 2 个 HTML 文件',
      Object.keys(data.files).length === 2,
      'count=' + Object.keys(data.files).length);
    check('files 字段含 url',
      Object.values(data.files).every(f => f.url && f.url.startsWith('/raw/')));
  } catch (e) {
    check('GET /api/state 返回 200', false, e.message);
  }

  // 7. 验证 /raw/ 静态托管
  try {
    const r = await get('http://localhost:4399/raw/0/project1/a.html');
    check('/raw/ 能访问扫描根下的 HTML', r.status === 200 && r.body.includes('hi A'));
  } catch (e) {
    check('/raw/', false, e.message);
  }

  // 8. 验证 dashboard 页面
  try {
    const r = await get('http://localhost:4399/');
    check('/ 返回 dashboard 页面（含 #tree）',
      r.status === 200 && r.body.includes('id="tree"'));
  } catch (e) {
    check('dashboard /', false, e.message);
  }

  // 9. 端口冲突自动让位
  console.log('\n测试端口冲突自动切换...');
  const child2 = spawn(process.execPath, [path.join(installedDir, 'bin', 'atlas.js')], {
    env: { ...process.env, ATLAS_HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout2 = '', stderr2 = '';
  child2.stdout.on('data', d => stdout2 += d);
  child2.stderr.on('data', d => stderr2 += d);
  // 等到 child2 显示出来 listen 信息（最多 5 秒）
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    if (/Atlas dashboard 运行中|被占用/.test(stdout2)) break;
    await new Promise(res => setTimeout(res, 100));
  }
  await new Promise(res => setTimeout(res, 300));
  console.log('  --- child2 stdout ---\n' + stdout2);
  if (stderr2) console.log('  --- child2 stderr ---\n' + stderr2);
  // 应该自动切到 4400+
  const switched = /被占用，自动切到\s+(\d+)/.test(stdout2)
    || /→\s+http:\/\/localhost:(\d+)/.test(stdout2) && !/localhost:4399\b/.test(stdout2.match(/→\s+http:\/\/localhost:(\d+)/)[0]);
  check('4399 被占时第二个实例自动切换端口', switched);
  child2.kill();
}

async function cleanup() {
  if (serverProc) {
    try { serverProc.kill(); } catch {}
  }
  // 等下子进程退出
  await new Promise(res => setTimeout(res, 200));
  // 删临时目录
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

main()
  .then(async () => {
    await cleanup();
    const failed = checks.filter(c => !c.ok);
    console.log(`\n========================`);
    console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
    if (failed.length > 0) {
      failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
      process.exit(1);
    }
  })
  .catch(async (e) => {
    console.error('test 错误:', e);
    await cleanup();
    process.exit(1);
  });
