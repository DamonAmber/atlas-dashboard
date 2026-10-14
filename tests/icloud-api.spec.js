// iCloud 云盘：服务端接口（design §11.3，plan FEAT-002）
//
// 不碰真实 iCloud：五个隔离实例全部用临时目录 + 测试专用变量
//   ATLAS_ICLOUD_PLATFORM=darwin|linux   覆盖平台（Linux CI 上也能跑云端分支）
//   ATLAS_ICLOUD_ROOT=<tmp 目录>|off      iCloud 根
//   ATLAS_TEST_CLOUD=<ATLAS_HOME>/cloud-hook.json  测试钩子：哪些路径算 dataless、brctl / 读取回退的桩、读审计
//
//   A   darwin，iCloud 根另建、不在扫描根里：入口探测、「点击添加」的路径逐字节往返（空格和 ~）、友好名
//   U   darwin，iCloud 根 = 扫描根，brctl 不支持：零读取审计、内容路由 409、/raw、导出依赖检查、分享、
//       过期记录、no-download-method、大文件确认、not-materialized、读取失败与重试
//   S   darwin，iCloud 根 = 扫描根，brctl 支持：下载接口越界 / 400 / 403 / 404 / 202 / 去重 / 429、
//       SSE 状态事件（不清 seen、不记日志）、驱逐不亮未读、元数据事件被吞、重命名不被吞、爆发合并
//   OFF darwin，ATLAS_ICLOUD_ROOT=off：入口不可用
//   L   linux：整套云端逻辑关闭，行为与改动前一致
//
// 所有路径都用 startAtlas 给的写法（macOS 上是 /var/...，realpath 是 /private/var/...）——
// 这正是测试钩子按 realpath 记账（plan M1）要在 mac 上跑通的场景。
const path = require('path');
const fs = require('fs');
const http = require('http');
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
let total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}
function ok(name, cond, detail) {
  total++;
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond || detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeout = 3000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PLIST = (k) => `<?xml version="1.0"?><plist><dict><key>NSURLNameKey</key><string>${k}</string></dict></plist>`;
const ICLOUD_SUB = 'Mobile Documents/com~apple~CloudDocs';

// ---------- spec 内工具（design §11.0）----------

// 原生 http：要能发带 # 的原始请求行、能带 Origin / Sec-Fetch-Site 头
function request(base, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, method, path: urlPath,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout ' + urlPath)));
    if (data) req.write(data);
    req.end();
  });
}
const get = (a, p, o) => request(a.base, 'GET', p, o);
const post = (a, p, body, o = {}) => request(a.base, 'POST', p, { ...o, body: body === undefined ? {} : body });
const put = (a, p, body) => request(a.base, 'PUT', p, { body });
const q = (abs) => encodeURIComponent(abs);
const rawUrl = (idx, rel) => `/raw/${idx}/` + rel.split('/').map(encodeURIComponent).join('/');
// SSE 响应体（/api/export-pdf）→ 消息数组
const sseBody = (text) => text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const hookFile = (a) => path.join(a.homeDir, 'cloud-hook.json');
const auditOf = (a) => readJsonl(path.join(a.homeDir, 'cloud-read-audit.jsonl'));
const brctlCallsOf = (a) => readJsonl(path.join(a.homeDir, 'test-brctl-calls.jsonl')).filter((x) => x.fn === 'brctl');

// 读-改-写钩子文件。N6：先写 .tmp 再 rename，服务端 100ms 轮询不会读到半截 JSON
async function writeHook(a, patch, wait = 150) {
  const file = hookFile(a);
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = typeof patch === 'function' ? (patch(cur) || cur) : { ...cur, ...patch };
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  if (wait) await sleep(wait);
}

// 原生 http 读 /api/events，按到达顺序收集消息
function openSse(a) {
  const msgs = [];
  let buf = '';
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const req = http.get(a.base + '/api/events', (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      if (buf.includes(': connected')) resolveReady();
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { msgs.push({ at: Date.now(), m: JSON.parse(line.slice(6)) }); } catch {}
        }
      }
    });
  });
  req.on('error', () => {});
  return {
    msgs, ready,
    cloudMsgs: () => msgs.filter((x) => x.m.channel === 'cloud'),
    cloudItems: (p) => {
      const out = [];
      for (const { m } of msgs) if (m.channel === 'cloud') for (const it of m.items || []) if (!p || it.path === p) out.push(it);
      return out;
    },
    fsMsgs: (p) => msgs.filter((x) => x.m.channel === 'fs' && (!p || x.m.path === p)).map((x) => x.m),
    close() { try { req.destroy(); } catch {} },
  };
}

async function state(a) {
  const r = await get(a, '/api/state');
  return r.json || {};
}
// 等 buildIndex 之后的 3 秒竞态窗口过去（design §6.2），状态切换类断言之前调用
async function waitIndexQuiet(a) {
  await state(a);
  return !!(await waitFor(async () => {
    const r = await get(a, '/api/icloud');
    const ms = r.json && r.json._debug && r.json._debug.msSinceIndexBuilt;
    return Number.isFinite(ms) && ms >= 3500;
  }, 8000, 200));
}
async function activityCount(a, p) {
  const r = await get(a, '/api/activity');
  const j = r.json || {};
  const idx = (j.paths || []).indexOf(p);
  if (idx < 0) return 0;
  return (j.events || []).filter((e) => e[2] === idx).length;
}
async function activityKinds(a, p) {
  const r = await get(a, '/api/activity');
  const j = r.json || {};
  const idx = (j.paths || []).indexOf(p);
  return idx < 0 ? [] : (j.events || []).filter((e) => e[2] === idx).map((e) => e[1]);
}

// 起一个带钩子的实例：files 写进扫描根，hook(dirs) 返回钩子 JSON，extra(dirs) 造根外文件 / 符号链接
async function startCloud({ prefix, platform = 'darwin', icloudRoot, scanDirNames, files, hook, extra }) {
  return startAtlas({
    prefix,
    files,
    scanDirNames,
    beforeSpawn: async ({ tmp, home, scanDirs }) => {
      const dirs = { tmp, home, root: scanDirs[0], scanDirs, abs: (rel) => path.join(scanDirs[0], rel) };
      if (extra) await extra(dirs);
      const env = { ATLAS_ICLOUD_PLATFORM: platform };
      env.ATLAS_ICLOUD_ROOT = typeof icloudRoot === 'function' ? icloudRoot(dirs) : (icloudRoot || scanDirs[0]);
      if (hook) {
        const file = path.join(home, 'cloud-hook.json');
        fs.writeFileSync(file, JSON.stringify(hook(dirs), null, 2));
        env.ATLAS_TEST_CLOUD = file;
      }
      return env;
    },
  });
}

(async () => {
  const instances = [];
  const stopAll = () => { for (const a of instances) { try { a.stopSync(); } catch {} } };
  try {
    // =====================================================================
    console.log('\n[A：iCloud 根不在扫描根里 → 点击添加（AC1、AC3–5，M7）]');
    let icloudDirA = null;
    const A = await startCloud({
      prefix: 'atlas-icloud-a-',
      scanDirNames: ['scan'],
      files: { 'proj/a.md': '# a\n' },
      icloudRoot: ({ tmp }) => path.join(tmp, ICLOUD_SUB),
      extra: ({ tmp }) => {
        icloudDirA = path.join(tmp, ICLOUD_SUB);
        fs.mkdirSync(path.join(icloudDirA, 'a b'), { recursive: true });
        fs.writeFileSync(path.join(icloudDirA, 'x.md'), '# 云盘里的 x\n');
        fs.writeFileSync(path.join(icloudDirA, 'a b', 'y.html'), '<!doctype html><h1>y</h1>');
      },
      hook: () => ({ brctl: 'unsupported' }),
    });
    instances.push(A);
    {
      const r = await get(A, '/api/icloud');
      check('A /api/icloud 200 且 no-store', [r.status, r.headers['cache-control']], [200, 'no-store']);
      const j = r.json || {};
      check('A available / enabled / platform', [j.available, j.enabled, j.platform], [true, true, 'darwin']);
      ok('A root 与另建的 iCloud 根逐字节相同（含空格和 ~）', typeof j.root === 'string' && Buffer.compare(Buffer.from(j.root), Buffer.from(icloudDirA)) === 0, j.root);
      check('A 未加入时 inScanRoots:false、rootIndex:null、readable:null', [j.inScanRoots, j.rootIndex, j.readable], [false, null, null]);
      check('A label 是「iCloud 云盘」', j.label, 'iCloud 云盘');
      const cs = await get(A, '/api/icloud', { headers: { 'sec-fetch-site': 'cross-site' } });
      check('A /api/icloud 跨站请求 403', cs.status, 403);
      const cfg = await get(A, '/api/config');
      check('A GET /api/config 带 icloudRoot', cfg.json && cfg.json.icloudRoot, icloudDirA);

      const p1 = await put(A, '/api/config', { scanRoots: [A.scanDir, icloudDirA] });
      check('A PUT /api/config 加入 iCloud 根 → 200', p1.status, 200);
      const saved = A.readConfig().scanRoots;
      ok('A config.json 里 scanRoots[1] 与 iCloud 根逐字节相同', saved.length === 2 && Buffer.compare(Buffer.from(saved[1]), Buffer.from(icloudDirA)) === 0, saved);
      const cfg2 = await get(A, '/api/config');
      check('A GET /api/config 原样返回', cfg2.json && cfg2.json.scanRoots, [A.scanDir, icloudDirA]);
      const p2 = await put(A, '/api/config', { scanRoots: [A.scanDir, icloudDirA, icloudDirA] });
      check('A 重复加入 → 去重后仍是 2 个根', [p2.status, A.readConfig().scanRoots.length], [200, 2]);
      const tildeMid = await put(A, '/api/config', { scanRoots: [A.scanDir, icloudDirA, path.join(A.tmpDir, 'no~such dir')] });
      check('A 段内带 ~ 的不存在路径照常报「路径不存在」（~ 不被展开）', [tildeMid.status, /no~such dir/.test((tildeMid.json || {}).error || '')], [400, true]);

      const st = await state(A);
      const ic = (await get(A, '/api/icloud')).json || {};
      check('A 加入后 inScanRoots:true、rootIndex:1、readable:true', [ic.inScanRoots, ic.rootIndex, ic.readable], [true, 1, true]);
      const xPath = path.join(icloudDirA, 'x.md');
      const yPath = path.join(icloudDirA, 'a b', 'y.html');
      ok('A /api/state 里有新根下的 x.md 与 a b/y.html', !!(st.files && st.files[xPath] && st.files[yPath]), Object.keys(st.files || {}));
      ok('A 新根下的本地文件没有 cloud 字段', st.files && st.files[xPath] && !('cloud' in st.files[xPath]));
      check('A rootLabels', st.rootLabels, [null, 'iCloud 云盘']);
      check('A autoFolderLabels', st.autoFolderLabels, { 'com~apple~CloudDocs': 'iCloud 云盘' });
      const raw = await get(A, rawUrl(1, 'a b/y.html'));
      check('A /raw/1/a%20b/y.html → 200', raw.status, 200);
      const rmd = await get(A, '/api/render-md?path=' + q(xPath));
      check('A render-md 新根下的 x.md → 200', rmd.status, 200);
      const store = A.readStore() || {};
      const folder = (store.tree || []).find((n) => n.type === 'folder' && n.autoFor === 'com~apple~CloudDocs');
      check('A store 里分组名仍是原名（友好名只在显示层）', folder && folder.name, 'com~apple~CloudDocs');

      // 没有读取权限（模拟 macOS TCC 拒绝）：root 用户 chmod 000 也读得了，跳过
      if (typeof process.getuid === 'function' && process.getuid() !== 0) {
        const noperm = A.makeDir('noperm root');
        fs.chmodSync(noperm, 0o000);
        try {
          const r = await put(A, '/api/config', { scanRoots: [A.scanDir, icloudDirA, noperm] });
          check('A 加入不可读的根 → 400 + code', [r.status, r.json && r.json.code, /没有读取权限/.test((r.json || {}).error || '')], [400, 'EACCES', true]);
          check('A 不可读的根没有写进 config', A.readConfig().scanRoots.length, 2);
        } finally { fs.chmodSync(noperm, 0o755); }
        // 已在列表里的根变得不可读：buildIndex 记 readable:false
        fs.chmodSync(icloudDirA, 0o000);
        try {
          await put(A, '/api/config', { maxDepth: 5 });   // 只改 maxDepth：触发重建，不走加根检查
          await state(A);
          const ic2 = (await get(A, '/api/icloud')).json || {};
          check('A 已加入的根 readdir 被拒 → /api/icloud readable:false', [ic2.inScanRoots, ic2.readable], [true, false]);
          ok('A readdir 被拒时 warn 一次', /没有读取扫描根的权限/.test(A.serverLogs()));
        } finally { fs.chmodSync(icloudDirA, 0o755); }
      } else {
        console.log('  - 以 root 运行，跳过不可读目录用例');
      }
    }
    A.stopSync();

    // =====================================================================
    console.log('\n[OFF：ATLAS_ICLOUD_ROOT=off（AC2）]');
    const OFF = await startCloud({
      prefix: 'atlas-icloud-off-',
      files: { 'a.md': '# a\n' },
      icloudRoot: 'off',
      hook: () => ({ brctl: 'unsupported' }),
    });
    instances.push(OFF);
    {
      const j = (await get(OFF, '/api/icloud')).json || {};
      check('OFF enabled:true、available:false、root:null', [j.enabled, j.available, j.root], [true, false, null]);
      check('OFF GET /api/config 的 icloudRoot 为 null', ((await get(OFF, '/api/config')).json || {}).icloudRoot, null);
      const st = await state(OFF);
      check('OFF rootLabels / autoFolderLabels', [st.rootLabels, st.autoFolderLabels], [[null], {}]);
    }
    OFF.stopSync();

    // =====================================================================
    console.log('\n[L：linux，整套云端逻辑关闭（AC2、AC22 not-darwin）]');
    const L = await startCloud({
      prefix: 'atlas-icloud-l-',
      platform: 'linux',
      scanDirNames: [ICLOUD_SUB],
      files: { 'a.md': '# a\n', '.云端.md.icloud': PLIST('云端.md') },
    });
    instances.push(L);
    {
      const j = (await get(L, '/api/icloud')).json || {};
      check('L platform / enabled / available', [j.platform, j.enabled, j.available], ['linux', false, false]);
      check('L capability 全部为 false', j.capability, { brctl: { present: false, download: false }, readFallback: false, dataless: false, placeholder: false });
      ok('L 没有 _debug（钩子未启用）', !('_debug' in j));
      const d1 = await post(L, '/api/icloud/download', { path: L.filePath('a.md') });
      check('L 下载接口 → 501 not-darwin', [d1.status, d1.json && d1.json.reason], [501, 'not-darwin']);
      const d0 = await post(L, '/api/icloud/download', {});
      check('L 缺 path → 400', d0.status, 400);
      const st = await state(L);
      const keys = Object.keys(st.files || {});
      check('L 占位文件不进索引（非 darwin 不映射）', keys.some((k) => k.endsWith('云端.md')), false);
      ok('L 本地文件没有 cloud 字段', st.files && st.files[L.filePath('a.md')] && !('cloud' in st.files[L.filePath('a.md')]));
      check('L rootLabels / autoFolderLabels', [st.rootLabels, st.autoFolderLabels], [[null], {}]);
      check('L /raw 照常 200', (await get(L, rawUrl(0, 'a.md'))).status, 200);
    }
    L.stopSync();

    // =====================================================================
    console.log('\n[U：零读取审计、内容路由 409、/raw、导出、分享、过期记录（AC9–11、M1–M4）]');
    const uFiles = {
      'a b/报告.md': '# 报告\n\n本地文件\n',
      '.云端.md.icloud': PLIST('K_PH_7731'),
      'cloud-c.md': '# 云端 C\n\nK_DL_5520\n\n[报告](a%20b/报告.md)\n',
      'dup.md': '# dup 本地\n',
      '.dup.md.icloud': PLIST('dup.md'),
      'linker.md': '# linker\n\n[ref](ref.md)\n',
      'img/pic.png': PNG,
      'ref.md': '# ref\n\n![](img/pic.png)\n',
      'uq.html': '<!doctype html><body><img src=img/pic.png></body>',
      'page.html': '<!doctype html><head><link rel="stylesheet" href="s.css"></head><body>p</body>',
      's.css': 'body{background:url(img/pic.png)}',
      'script.html': '<!doctype html><body><script src=app.js></script></body>',
      'app.js': "const img = new Image(); img.src='img/pic.png';",
      'pg2.html': '<!doctype html><head><link rel=stylesheet href=s2.css></head><body>pg2</body>',
      's2.css': 'body{background:url(bg2.png)}',
      'pg3.html': '<!doctype html><body><img src="pg3.png"></body>',
      'pg3.png': PNG,
      'dlsub/index.html': '<!doctype html><h1>dlsub</h1>',
      'many.html': '<!doctype html><body>'
        + Array.from({ length: 65 }, (_, i) => `<img src="m/i${String(i + 1).padStart(3, '0')}.png">`).join('') + '</body>',
      'deep.html': '<!doctype html><head><link rel=stylesheet href=d1.css></head><body>deep</body>',
      'd1.css': '@import "d2.css";',
      'd2.css': 'body{background:url(d.png)}',
      'd.png': PNG,
      'stale.md': '# stale\n\n旧内容\n',
      'big.md': '# big\n',
      'sticky.md': '# sticky\n',
      'dl-eio.md': '# eio\n',
    };
    for (let i = 1; i <= 65; i++) uFiles[`m/i${String(i).padStart(3, '0')}.png`] = PNG;
    const U = await startCloud({
      prefix: 'atlas-icloud-u-',
      scanDirNames: [ICLOUD_SUB],
      files: uFiles,
      hook: ({ abs }) => ({
        audit: true,
        brctl: 'unsupported',
        settleMs: 500,
        dataless: ['cloud-c.md', 'img/pic.png', 's2.css', 'dlsub/index.html', 'big.md', 'dl-eio.md'].map(abs),
        stickyDataless: [abs('sticky.md')],
        sizes: { [abs('big.md')]: 209715200 },
        readBehavior: { [abs('dl-eio.md')]: 'fail:EIO' },
        // N7：钩子不扫盘，占位文件本身与它的原路径由 spec 列进审计集合
        auditExtra: [abs('.云端.md.icloud'), abs('云端.md'), abs('.dup.md.icloud')],
      }),
    });
    instances.push(U);
    const u = (rel) => U.filePath(rel);
    const uAuditBad = (filterOut = []) => auditOf(U).filter((l) => !filterOut.some((f) => l.path.endsWith(f)));
    {
      ok('U 启动日志打印了测试钩子启用', /\[test\] iCloud 测试钩子已启用/.test(U.serverLogs()));
      const st = await state(U);
      const files = st.files || {};
      const ic = (await get(U, '/api/icloud')).json || {};
      check('U available / inScanRoots / rootIndex / readable', [ic.available, ic.inScanRoots, ic.rootIndex, ic.readable], [true, true, 0, true]);
      check('U capability：读取回退可用、占位不可下载（brctl unsupported）',
        [ic.capability && ic.capability.readFallback, ic.capability && ic.capability.dataless, ic.capability && ic.capability.placeholder, ic.capability && ic.capability.brctl],
        [true, true, false, { present: true, download: false }]);
      check('U _debug.thumbCheckWired（N9）', ic._debug && ic._debug.thumbCheckWired, true);
      ok('U _debug.hook.mem 用钩子文件里的写法', ic._debug && Array.isArray(ic._debug.hook.mem) && ic._debug.hook.mem.includes(u('cloud-c.md')), ic._debug && ic._debug.hook);

      // AC11：占位以原名出现、去重
      const ph = files[u('云端.md')];
      check('U 占位条目以原路径出现，cloud:placeholder', ph && [ph.path, ph.name, ph.cloud], [u('云端.md'), '云端.md', 'placeholder']);
      ok('U 占位条目没有 size 字段（只有 dataless 才带）', ph && !('size' in ph));
      check('U 占位条目从没看过 → unread:true（「看过就不算未读」口径）', ph && ph.unread, true);
      const dupKeys = Object.keys(files).filter((k) => path.basename(k) === 'dup.md');
      check('U dup.md 只有一条且是本地（真实文件优先）', [dupKeys.length, files[u('dup.md')] && ('cloud' in files[u('dup.md')])], [1, false]);
      const cc = files[u('cloud-c.md')];
      check('U dataless 条目 cloud / size', cc && [cc.cloud, typeof cc.size], ['dataless', 'number']);
      check('U big.md 的 size 被钩子 sizes 改写为 200MB', files[u('big.md')] && files[u('big.md')].size, 209715200);
      ok('U 本地文件没有云端字段', files[u('a b/报告.md')] && !('cloud' in files[u('a b/报告.md')]) && !('cloudBusy' in files[u('a b/报告.md')]));
      check('U rootLabels / autoFolderLabels', [st.rootLabels, st.autoFolderLabels], [['iCloud 云盘'], { 'com~apple~CloudDocs': 'iCloud 云盘' }]);
      const est = (await get(U, '/api/estimate-scan?path=' + q(U.scanDir))).json || {};
      const docCount = Object.keys(uFiles).filter((k) => /\.(md|html)$/.test(k) && !path.basename(k).startsWith('.')).length;
      check('U estimate-scan 把 2 个文档类占位文件也计入', est.count, docCount + 2);

      // C：批量读取点
      const s1 = await get(U, '/api/search?q=' + q('K_PH_7731'));
      const s2 = await get(U, '/api/search?q=' + q('K_DL_5520'));
      check('U 正文搜索不命中占位 / dataless 文件', [s1.json && s1.json.matches.length, s2.json && s2.json.matches.length], [0, 0]);
      const s3 = await get(U, '/api/search?q=' + q('本地文件'));
      check('U 正文搜索仍能命中本地文件（对照）', (s3.json && s3.json.matches || []).map((m) => m.path), [u('a b/报告.md')]);
      const links = await waitFor(async () => { const r = await get(U, '/api/links'); return r.status === 200 && r.json; }, 6000, 100);
      ok('U /api/links 就绪', !!links);
      const edgeFrom = (lk, src) => (lk ? lk.edges.filter(([s]) => lk.paths[s] === src).map(([, d]) => lk.paths[d]) : []);
      check('U cloud-c.md 没有出边', edgeFrom(links, u('cloud-c.md')), []);
      check('U 本地 linker.md → ref.md 的边存在（对照）', edgeFrom(links, u('linker.md')), [u('ref.md')]);
      const th = await post(U, '/api/thumbs', { paths: [u('cloud-c.md'), u('云端.md')] });
      check('U /api/thumbs 云端路径直接 status:cloud', th.json && [th.json.items[u('cloud-c.md')], th.json.items[u('云端.md')]], [{ status: 'cloud' }, { status: 'cloud' }]);
      check('U 浏览一圈之后读审计为空（AC9）', uAuditBad(), []);

      // AC10：内容路由
      for (const [label, p] of [['dataless', u('cloud-c.md')], ['占位', u('云端.md')]]) {
        const rm = await get(U, '/api/render-md?path=' + q(p));
        check(`U render-md（${label}）→ 409 HTML 占位页`, [rm.status, /text\/html/.test(rm.headers['content-type'] || ''), rm.text.includes('尚未下载到本机')], [409, true, true]);
        const ms = await get(U, '/api/md-source?path=' + q(p));
        check(`U md-source（${label}）→ 409 cloud-only`, [ms.status, ms.json && ms.json.error], [409, 'cloud-only']);
        const sm = await post(U, '/api/save-md', { path: p, content: 'x' });
        check(`U save-md（${label}）→ 409`, sm.status, 409);
        const df = await get(U, '/api/diff?path=' + q(p));
        check(`U diff（${label}）→ 409`, df.status, 409);
        const da = await post(U, '/api/diff/accept', { path: p });
        check(`U diff/accept（${label}）→ 409`, da.status, 409);
        const rv = await post(U, '/api/revert', { path: p, version: 'v' });
        check(`U revert（${label}）→ 409`, rv.status, 409);
        const rn = await post(U, '/api/rename', { path: p, name: 'renamed.md' });
        check(`U rename（${label}）→ 409 cloud-only`, [rn.status, rn.json && rn.json.error], [409, 'cloud-only']);
        const ss = await post(U, '/api/share/start', { path: p });
        check(`U share/start（${label}）→ 409`, ss.status, 409);
        const ph2 = await post(U, '/api/export-pdf-html', { path: p });
        check(`U export-pdf-html（${label}）→ 409 cloud-only`, [ph2.status, ph2.json && ph2.json.reason], [409, 'cloud-only']);
        const ep = await post(U, '/api/export-pdf', { path: p });
        const last = sseBody(ep.text).pop() || {};
        check(`U export-pdf（${label}）→ SSE error cloud-only`, [last.phase, last.reason], ['error', 'cloud-only']);
        const seen = await post(U, '/api/seen', { path: p });
        check(`U /api/seen（${label}）只更新最近打开`, seen.json, { ok: true, cloud: label === '占位' ? 'placeholder' : 'dataless' });
      }
      const storeU = U.readStore() || {};
      check('U 云端文件 seen 没被写', [u('cloud-c.md') in (storeU.seen || {}), u('云端.md') in (storeU.seen || {})], [false, false]);
      ok('U 云端文件进了「最近打开」', (storeU.recent || []).includes(u('cloud-c.md')) && (storeU.recent || []).includes(u('云端.md')), storeU.recent);
      ok('U 云端文件没有记底本', !(storeU.seenVersions || {})[u('cloud-c.md')]);
      const ed = await get(U, '/api/edit-doc?path=' + q(u('dlsub/index.html')));
      check('U edit-doc（dataless HTML）→ 409', ed.status, 409);
      const se = await post(U, '/api/save-edits', { path: u('dlsub/index.html'), ops: [] });
      check('U save-edits（dataless HTML）→ 409', se.status, 409);
      const ro1 = await post(U, '/api/resolve-open', { path: u('云端.md') });
      check('U resolve-open 占位原路径 → ready + cloud:placeholder', ro1.json && [ro1.json.status, ro1.json.cloud], ['ready', 'placeholder']);
      const ro2 = await post(U, '/api/resolve-open', { path: u('cloud-c.md') });
      check('U resolve-open dataless → ready + cloud:dataless', ro2.json && [ro2.json.status, ro2.json.cloud], ['ready', 'dataless']);
      const ro3 = await post(U, '/api/resolve-open', { path: u('a b/报告.md') });
      check('U resolve-open 本地文件不带 cloud', ro3.json && [ro3.json.status, 'cloud' in ro3.json], ['ready', false]);

      // /raw（M2）
      const r1 = await get(U, rawUrl(0, 'img/pic.png'));
      check('U /raw dataless 图片 → 409 + X-Atlas-Cloud', [r1.status, r1.headers['x-atlas-cloud'], /text\/plain/.test(r1.headers['content-type'] || '')], [409, 'dataless', true]);
      check('U /raw ?v=2 → 409', (await get(U, rawUrl(0, 'img/pic.png') + '?v=2')).status, 409);
      check('U /raw 原始请求行带 #x → 409', (await get(U, rawUrl(0, 'img/pic.png') + '#x')).status, 409);
      check('U /raw 目录索引 dlsub/ → 409', (await get(U, '/raw/0/dlsub/')).status, 409);
      check('U /raw 占位原路径 → 404', (await get(U, rawUrl(0, '云端.md'))).status, 404);
      check('U /raw 本地文件（路径带空格）→ 200', (await get(U, rawUrl(0, 'a b/报告.md'))).status, 200);
      check('U /raw 越界交给 static（不是 409）', (await get(U, '/raw/0/..%2f..%2fetc')).status !== 409, true);
      check('U 内容路由与 /raw 之后读审计仍为空（AC10）', uAuditBad(), []);

      // 导出（M2、M3、M4）
      for (const rel of ['ref.md', 'uq.html', 'page.html', 'script.html']) {
        const r = await post(U, '/api/export-pdf-html', { path: u(rel) });
        check(`U export-pdf-html ${rel} → 409 cloud-deps`, [r.status, r.json && r.json.reason, !!(r.json && /iCloud/.test(r.json.message))], [409, 'cloud-deps', true]);
        const e = await post(U, '/api/export-pdf', { path: u(rel) });
        const last = sseBody(e.text).pop() || {};
        check(`U export-pdf ${rel} → SSE error cloud-deps`, [last.phase, last.reason], ['error', 'cloud-deps']);
      }
      for (const rel of ['many.html', 'deep.html']) {
        const r = await post(U, '/api/export-pdf-html', { path: u(rel) });
        ok(`U export-pdf-html ${rel}（全部本地）不被依赖检查拦下`, !(r.status === 409 && /cloud-deps|deps-unverified/.test((r.json || {}).reason || '')), [r.status, r.json]);
      }

      // 分享（第二轮 M1）
      const sh2 = await post(U, '/api/share/start', { path: u('pg2.html') });
      const t2 = sh2.json && sh2.json.token;
      ok('U 分享 pg2.html 拿到 token', !!t2, sh2.json);
      check('U /share/:token/pg2.html → 200', (await get(U, `/share/${t2}/pg2.html`)).status, 200);
      check('U 构建白名单没读 dataless 的 s2.css', uAuditBad().filter((l) => l.path.endsWith('s2.css')), []);
      const s2css = await get(U, `/share/${t2}/s2.css`);
      check('U /share/:token/s2.css（资源本身 dataless）→ 409 + X-Atlas-Cloud', [s2css.status, s2css.headers['x-atlas-cloud']], [409, 'dataless']);
      const sh3 = await post(U, '/api/share/start', { path: u('pg3.html') });
      const t3 = sh3.json && sh3.json.token;
      check('U 分享 pg3.html 后 pg3.png 先是 200（对照）', (await get(U, `/share/${t3}/pg3.png`)).status, 200);
      await waitIndexQuiet(U);
      await writeHook(U, (h) => { h.dataless = [...h.dataless, u('pg3.html')]; });
      const evicted = await waitFor(async () => { const s = await state(U); return s.files && s.files[u('pg3.html')] && s.files[u('pg3.html')].cloud === 'dataless'; }, 3000);
      ok('U pg3.html 被驱逐后索引记录跟着变成 dataless', !!evicted);
      check('U 入口被驱逐：/share/:token/pg3.png → 409', (await get(U, `/share/${t3}/pg3.png`)).status, 409);
      check('U 入口被驱逐：/share/:token → 409', (await get(U, `/share/${t3}`)).status, 409);
      check('U 入口判定在构建白名单之前（审计里没有 pg3.html）', uAuditBad().filter((l) => l.path.endsWith('pg3.html')), []);

      // 过期记录（首轮 M1）：钩子 silent 让 watcher「漏报」驱逐，rec.cloud 停在 null
      const seenStale = await post(U, '/api/seen', { path: u('stale.md') });
      check('U stale.md 记底本', seenStale.json && seenStale.json.ok, true);
      await sleep(30);
      fs.writeFileSync(u('stale.md'), '# stale\n\n新内容 K2_STALE_9041\n');
      // 用 store 判断 watcher 处理完了这次改写（原流程清掉 seen）。这里刻意不拉 /api/state：
      // 那会对新 mtime 调一次 currentContentHash 并缓存，后面就测不到它的新鲜 stat 了
      ok('U stale.md 改写被 watcher 当作内容变更（seen 被清）',
        !!(await waitFor(() => !((U.readStore() || {}).seen || {})[u('stale.md')], 4000, 100)));
      await sleep(1000);
      await writeHook(U, (h) => {
        h.dataless = [...h.dataless, u('stale.md')];
        h.silent = [...(h.silent || []), u('stale.md')];
      }, 300);
      const stStale = await state(U);
      check('U stale.md 记录过期（索引里仍是本地）', stStale.files && stStale.files[u('stale.md')] && ('cloud' in stStale.files[u('stale.md')]), false);
      const sK2 = await get(U, '/api/search?q=' + q('K2_STALE_9041'));
      check('U 过期记录：正文搜索被新鲜 stat 拦下', sK2.json && sK2.json.matches.length, 0);
      check('U 过期记录：getFileText / currentContentHash 都没读 stale.md', uAuditBad().filter((l) => l.path.endsWith('stale.md')), []);

      // E（实例 U）
      const sseU = openSse(U);
      await sseU.ready;
      const ac22 = await post(U, '/api/icloud/download', { path: u('云端.md') });
      check('U 占位 + brctl 不支持 → 501 no-download-method（AC22）', [ac22.status, ac22.json && ac22.json.reason, ac22.json && ac22.json.cloud], [501, 'no-download-method', 'placeholder']);
      const big1 = await post(U, '/api/icloud/download', { path: u('big.md') });
      check('U big.md 不带 confirmLarge → 409 confirm-required', [big1.status, big1.json && big1.json.error, big1.json && big1.json.size], [409, 'confirm-required', 209715200]);
      const big2 = await post(U, '/api/icloud/download', { path: u('big.md'), confirmLarge: true });
      check('U big.md 带 confirmLarge → 202', [big2.status, big2.json && big2.json.status, big2.json && big2.json.path, big2.json && big2.json.deduped], [202, 'downloading', u('big.md'), false]);
      const busyNow = await state(U);
      check('U 下载进行中 /api/state 带 cloudBusy', busyNow.files && busyNow.files[u('big.md')] && busyNow.files[u('big.md')].cloudBusy, true);
      const bigDone = await waitFor(() => sseU.cloudItems(u('big.md')).find((i) => i.phase === 'done'), 4000);
      check('U big.md 读取回退完成 → SSE done（cloud:null, busy:false）', bigDone && [bigDone.cloud, bigDone.busy], [null, false]);
      ok('U big.md 先推了 started', sseU.cloudItems(u('big.md')).some((i) => i.phase === 'started' && i.busy === true && i.cloud === 'dataless'));
      const afterBig = await state(U);
      ok('U big.md 下载后 /api/state 不再有 cloud', afterBig.files && afterBig.files[u('big.md')] && !('cloud' in afterBig.files[u('big.md')]));

      const tSticky = Date.now();
      const st1 = await post(U, '/api/icloud/download', { path: u('sticky.md') });
      check('U sticky.md → 202', st1.status, 202);
      const stErr = await waitFor(() => sseU.cloudItems(u('sticky.md')).find((i) => i.phase === 'error'), 2000);
      check('U sticky.md 2 秒内收到 not-materialized（N2）', stErr && [stErr.reason, stErr.busy, stErr.cloud], ['not-materialized', false, 'dataless']);
      ok('U not-materialized 带中文 message', stErr && typeof stErr.message === 'string' && /未下载/.test(stErr.message), stErr);
      ok('U not-materialized 用时 < 2s', Date.now() - tSticky < 2000 + 200, Date.now() - tSticky);

      const e1 = await post(U, '/api/icloud/download', { path: u('dl-eio.md') });
      check('U dl-eio.md → 202', e1.status, 202);
      const eErr = await waitFor(() => sseU.cloudItems(u('dl-eio.md')).find((i) => i.phase === 'error'), 3000);
      check('U dl-eio.md → SSE error io-error', eErr && eErr.reason, 'io-error');
      const e2 = await post(U, '/api/icloud/download', { path: u('dl-eio.md') });
      check('U 失败后可重试 → 202 且不是去重', [e2.status, e2.json && e2.json.deduped], [202, false]);
      await waitFor(() => sseU.cloudItems(u('dl-eio.md')).filter((i) => i.phase === 'error').length >= 2, 3000);
      sseU.close();
      // 正向对照：审计是活的——big.md 下载完成后引用索引会读它，这一次读要被记下来
      ok('U 读审计是活的（下载完成后对 big.md 的读取被记录）',
        !!(await waitFor(() => auditOf(U).some((l) => l.path === u('big.md')), 3000)), auditOf(U));
      check('U 全程读审计只有下载完成的 big.md（其余 0 行）', uAuditBad(['big.md']), []);
    }
    U.stopSync();

    // =====================================================================
    console.log('\n[S：下载接口（AC19–24）与 SSE 状态事件（AC25–27、M2、M5、N5）]');
    const sFiles = {
      'a b/报告.md': '# 报告\n\n本地\n',
      '.云端.md.icloud': PLIST('云端.md'),
      '.ghost.md.icloud': PLIST('ghost.md'),
      'dl-fail.md': '# dl-fail\n\n[报告](a%20b/报告.md)\n',
      'dl-dedupe.md': '# dedupe\n',
      'dl-state.md': '# state\n',
      'dl-meta.md': '# meta\n',
      '.a.md.icloud': PLIST('a.md'),
      'b.md': '# b 本地\n',
      'rn.md': '# rn\n',
    };
    for (let i = 1; i <= 11; i++) sFiles[`q/q${String(i).padStart(2, '0')}.md`] = `# q${i}\n`;
    for (let i = 1; i <= 200; i++) sFiles[`burst/b${String(i).padStart(3, '0')}.md`] = `# b${i}\n`;
    let outsideSecret = null;
    let rootEvil = null;
    const S = await startCloud({
      prefix: 'atlas-icloud-s-',
      scanDirNames: [ICLOUD_SUB],
      files: sFiles,
      extra: ({ tmp, root }) => {
        fs.mkdirSync(path.join(tmp, 'outside'), { recursive: true });
        outsideSecret = path.join(tmp, 'outside', 'secret.md');
        fs.writeFileSync(outsideSecret, '# 根外的秘密\n');
        fs.symlinkSync(outsideSecret, path.join(root, 'link.md'));
        fs.symlinkSync(path.join(tmp, 'outside', 'ghost.md'), path.join(root, 'ghost.md'));   // 悬空
        rootEvil = root + '-evil';
        fs.mkdirSync(rootEvil, { recursive: true });
        fs.writeFileSync(path.join(rootEvil, 'x.md'), '# evil\n');
      },
      hook: ({ tmp, abs, root }) => {
        const q11 = Array.from({ length: 11 }, (_, i) => abs(`q/q${String(i + 1).padStart(2, '0')}.md`));
        return {
          audit: true,
          brctl: 'supported',
          brctlBehavior: 'materialize',
          materializeContent: '# 云端 materialized\n',
          dataless: [abs('dl-fail.md'), abs('dl-dedupe.md'), abs('dl-state.md'), abs('dl-meta.md'), ...q11],
          readBehavior: {
            [abs('dl-dedupe.md')]: 'delay:800',
            ...Object.fromEntries(q11.map((p) => [p, 'delay:2000'])),
          },
          auditExtra: [
            path.join(tmp, 'outside', 'secret.md'), path.join(tmp, 'outside', 'ghost.md'),
            abs('link.md'), abs('ghost.md'), abs('.ghost.md.icloud'),
            path.join(root + '-evil', 'x.md'),
            abs('.云端.md.icloud'), abs('云端.md'), abs('.a.md.icloud'), abs('a.md'),
          ],
        };
      },
    });
    instances.push(S);
    const s = (rel) => S.filePath(rel);
    const sReal = fs.realpathSync(S.scanDir);
    const outsideTargets = () => auditOf(S).filter((l) => /outside[\\/]|link\.md$|ghost\.md|-evil[\\/]/.test(l.path));
    {
      const st0 = await state(S);
      ok('S 占位条目 ghost.md 进了索引（悬空链接本身不是文档）', st0.files && st0.files[s('ghost.md')] && st0.files[s('ghost.md')].cloud === 'placeholder');
      const ic = (await get(S, '/api/icloud')).json || {};
      check('S capability：brctl 支持 → 占位可下载', ic.capability && [ic.capability.placeholder, ic.capability.dataless], [true, true]);

      // AC19
      const brctl0 = brctlCallsOf(S).length;
      const audit0 = auditOf(S).length;
      check('S 缺 path → 400', (await post(S, '/api/icloud/download', {})).status, 400);
      check('S path 为数字 → 400', (await post(S, '/api/icloud/download', { path: 123 })).status, 400);
      check('S path 含 \\0 → 400', (await post(S, '/api/icloud/download', { path: s('a\0.md') })).status, 400);
      const forbidden = [
        ['根外文件', outsideSecret],
        ['../ 穿越', S.scanDir + '/../../outside/secret.md'],
        ['指向根外的符号链接', s('link.md')],
        ['悬空符号链接 + 同名占位', s('ghost.md')],
        ['root-evil 前缀碰撞', path.join(rootEvil, 'x.md')],
        ['扫描根本身', S.scanDir],
        ['根外不存在的路径', '/nonexistent/x.md'],
      ];
      for (const [label, p] of forbidden) {
        const r = await post(S, '/api/icloud/download', { path: p });
        check(`S ${label} → 403`, r.status, 403);
      }
      check('S 403 之后 brctl 调用数没有增加', brctlCallsOf(S).length, brctl0);
      check('S 403 之后读审计没有增加（auditExtra 列了根外目标）', auditOf(S).length, audit0);
      check('S 悬空链接的错误码', (await post(S, '/api/icloud/download', { path: s('ghost.md') })).json, { error: 'dangling-symlink' });

      // AC20
      const o1 = await post(S, '/api/icloud/download', { path: s('dl-state.md') }, { headers: { origin: 'null' } });
      const o2 = await post(S, '/api/icloud/download', { path: s('dl-state.md') }, { headers: { origin: 'http://evil.example' } });
      const o3 = await post(S, '/api/icloud/download', { path: s('dl-state.md') }, { headers: { 'sec-fetch-site': 'cross-site' } });
      check('S Origin:null / 外站 Origin / cross-site → 403', [o1.status, o2.status, o3.status], [403, 403, 403]);
      check('S 被拒的请求没有触发 brctl', brctlCallsOf(S).length, brctl0);

      // AC21
      const lc = await post(S, '/api/icloud/download', { path: s('a b/报告.md') });
      check('S 已在本地 → 200 {status:local}', [lc.status, lc.json], [200, { status: 'local' }]);
      check('S 根内不存在、也没有占位 → 404', (await post(S, '/api/icloud/download', { path: s('nope.md') })).status, 404);
      check('S 根内、父目录也不存在 → 404（N1）', (await post(S, '/api/icloud/download', { path: s('nodir/x.md') })).status, 404);
      check('S 本地 / 404 都没有触发 brctl', brctlCallsOf(S).length, brctl0);

      const sse = openSse(S);
      await sse.ready;

      // AC23a：brctl materialize（占位）
      const a23 = await post(S, '/api/icloud/download', { path: s('云端.md') });
      check('S 占位 云端.md → 202', [a23.status, a23.json && a23.json.path], [202, s('云端.md')]);
      const d23 = await waitFor(() => sse.cloudItems(s('云端.md')).find((i) => i.phase === 'done'), 5000);
      ok('S 云端.md 收到 done', !!d23, sse.cloudItems(s('云端.md')));
      const call = brctlCallsOf(S).slice(-1)[0] || {};
      check('S brctl argv 严格是 [download, 真实父目录/原名]', call.argv, ['download', path.join(sReal, '云端.md')]);
      check('S brctl opts 没有 shell', call.opts && ('shell' in call.opts), false);
      check('S brctl opts 带 windowsHide 与 timeout', call.opts && [call.opts.windowsHide, typeof call.opts.timeout], [true, 'number']);
      const st23 = await state(S);
      ok('S 云端.md 下载后 /api/state 不再有 cloud', st23.files && st23.files[s('云端.md')] && !('cloud' in st23.files[s('云端.md')]));
      check('S .云端.md.icloud 已消失、原路径已出现', [fs.existsSync(s('.云端.md.icloud')), fs.existsSync(s('云端.md'))], [false, true]);

      // AC23b：brctl 失败 → 读取回退
      await writeHook(S, { brctlBehavior: 'fail' });
      const nBr = brctlCallsOf(S).length;
      const b23 = await post(S, '/api/icloud/download', { path: s('dl-fail.md') });
      check('S dl-fail.md → 202', b23.status, 202);
      const db = await waitFor(() => sse.cloudItems(s('dl-fail.md')).find((i) => i.phase === 'done'), 5000);
      ok('S brctl 失败后转读取回退，最终 done', !!db, sse.cloudItems(s('dl-fail.md')));
      const calls = brctlCallsOf(S).slice(nBr);
      check('S dl-fail.md brctl 只调用一次，argv 是 realpath 写法', calls.map((c) => c.argv), [['download', fs.realpathSync(s('dl-fail.md'))]]);
      const readCalls = readJsonl(path.join(S.homeDir, 'test-brctl-calls.jsonl')).filter((x) => x.fn === 'read' && x.path === fs.realpathSync(s('dl-fail.md')));
      check('S 读取回退收到的是 real（不是 abs）', [readCalls.length, readCalls[0] && readCalls[0].opts && readCalls[0].opts.highWaterMark], [1, 65536]);
      const stb = await state(S);
      ok('S dl-fail.md 下载后不再有 cloud', stb.files && stb.files[s('dl-fail.md')] && !('cloud' in stb.files[s('dl-fail.md')]));
      const edge = await waitFor(async () => {
        const r = await get(S, '/api/links');
        const lk = r.status === 200 && r.json;
        if (!lk) return null;
        return lk.edges.some(([a, b]) => lk.paths[a] === s('dl-fail.md') && lk.paths[b] === s('a b/报告.md'));
      }, 3000, 100);
      ok('S 下载后引用索引补上 dl-fail.md → a b/报告.md（N7）', !!edge);

      // AC24：去重
      const nBr2 = brctlCallsOf(S).length;
      const dd1 = await post(S, '/api/icloud/download', { path: s('dl-dedupe.md') });
      const dd2 = await post(S, '/api/icloud/download', { path: s('dl-dedupe.md') });
      check('S 连续两次请求：第一次 accepted、第二次 deduped', [dd1.status, dd1.json && dd1.json.deduped, dd2.status, dd2.json && dd2.json.deduped], [202, false, 202, true]);
      await waitFor(() => sse.cloudItems(s('dl-dedupe.md')).some((i) => i.phase === 'done'), 4000);
      await sleep(400);
      check('S 去重：brctl 只多一次', brctlCallsOf(S).length - nBr2, 1);
      check('S 去重：只收到一条 done', sse.cloudItems(s('dl-dedupe.md')).filter((i) => i.phase === 'done').length, 1);
      sse.close();

      // F：状态事件
      ok('S 等过索引重建后的 3 秒窗口', await waitIndexQuiet(S));
      const seenAll = await post(S, '/api/seen/all', {});
      check('S POST /api/seen/all 预置 seen', seenAll.json && seenAll.json.ok, true);

      // AC27
      {
        const p = s('dl-state.md');
        const seen0 = (S.readStore() || {}).seen[p];
        const act0 = await activityCount(S, p);
        const ev = openSse(S);
        await ev.ready;
        await writeHook(S, (h) => { h.dataless = h.dataless.filter((x) => x !== p); });
        const it = await waitFor(() => ev.cloudItems(p).find((i) => i.phase === 'state'), 3000);
        check('S 钩子移出 dataless → cloud state 事件（cloud:null）', it && [it.cloud, it.busy, typeof it.mtime], [null, false, 'number']);
        await sleep(400);
        check('S 状态切换没有 fs 事件', ev.fsMsgs(p).length, 0);
        check('S 状态切换不清 seen', (S.readStore() || {}).seen[p], seen0);
        check('S 状态切换不记活动日志', await activityCount(S, p), act0);
        ev.close();
      }

      // 元数据事件（首轮 M2）
      {
        const p = s('dl-meta.md');
        const local = s('a b/报告.md');
        const ev0 = openSse(S);
        await ev0.ready;
        await writeHook(S, (h) => { h.dataless = h.dataless.filter((x) => x !== p); });
        ok('S dl-meta.md 先切到本地（收到 state）', !!(await waitFor(() => ev0.cloudItems(p).find((i) => i.phase === 'state'), 3000)));
        ev0.close();
        await sleep(1000);
        const seenBefore = { ...((S.readStore() || {}).seen || {}) };
        const actM = await activityCount(S, p);
        const actL = await activityCount(S, local);
        const ev = openSse(S);
        await ev.ready;
        await writeHook(S, { touchMeta: { [local]: 1, [p]: 1 } });
        await sleep(1200);
        check('S 元数据事件：没有 fs 消息', [ev.fsMsgs(p).length, ev.fsMsgs(local).length], [0, 0]);
        check('S 元数据事件：没有 cloud 消息', [ev.cloudItems(p).length, ev.cloudItems(local).length], [0, 0]);
        const seenAfter = (S.readStore() || {}).seen || {};
        check('S 元数据事件：seen 不变', [seenAfter[p], seenAfter[local]], [seenBefore[p], seenBefore[local]]);
        check('S 元数据事件：活动日志不新增', [await activityCount(S, p), await activityCount(S, local)], [actM, actL]);
        ev.close();
      }

      // AC26：占位 → 真实（真实文件操作，走完整的 watcher 管线）
      {
        const p = s('a.md');
        const seen0 = (S.readStore() || {}).seen[p];
        ok('S a.md 占位条目在 seen/all 之后有 seen', !!seen0);
        const ev = openSse(S);
        await ev.ready;
        fs.unlinkSync(s('.a.md.icloud'));
        fs.writeFileSync(p, '# a 下载好了\n');
        const it = await waitFor(() => ev.cloudItems(p).find((i) => i.phase === 'state'), 4000);
        check('S 占位 → 真实：同一路径的 state 事件（cloud:null）', it && it.cloud, null);
        await sleep(500);
        check('S 占位 → 真实：没有 fs add / unlink', ev.fsMsgs(p).map((m) => m.kind), []);
        const seen1 = (S.readStore() || {}).seen[p];
        ok('S 占位 → 真实：seen 没被清掉（继承已读，≥ 原值）', Number.isFinite(seen1) && seen1 >= seen0, [seen0, seen1]);
        const sa = await state(S);
        check('S 占位 → 真实：/api/state 无 cloud、unread:false', sa.files && sa.files[p] && ['cloud' in sa.files[p], sa.files[p].unread], [false, false]);
        ev.close();
      }

      // M5：真实 → 占位 → 真实
      {
        const p = s('b.md');
        await post(S, '/api/seen', { path: p });
        const sb0 = await state(S);
        const m0 = sb0.files && sb0.files[p] && sb0.files[p].mtime;
        check('S b.md 看过 → unread:false', sb0.files && sb0.files[p] && sb0.files[p].unread, false);
        await sleep(1200);
        const ev = openSse(S);
        await ev.ready;
        fs.unlinkSync(p);
        fs.writeFileSync(s('.b.md.icloud'), PLIST('b.md'));
        const it = await waitFor(() => ev.cloudItems(p).find((i) => i.phase === 'state'), 4000);
        check('S 真实 → 占位：一条 state（cloud:placeholder）', it && it.cloud, 'placeholder');
        await sleep(500);
        check('S 真实 → 占位：只有一条 cloud 事件、没有 fs 消息', [ev.cloudItems(p).length, ev.fsMsgs(p).length], [1, 0]);
        const sb1 = await state(S);
        const f1 = sb1.files && sb1.files[p];
        check('S 驱逐后 cloud:placeholder、unread:false、mtime 沿用 m0', f1 && [f1.cloud, f1.unread, f1.mtime], ['placeholder', false, m0]);
        ev.close();

        const ev2 = openSse(S);
        await ev2.ready;
        fs.unlinkSync(s('.b.md.icloud'));
        fs.writeFileSync(p, '# b 在别处改过、又下载回来\n');
        const it2 = await waitFor(() => ev2.cloudItems(p).find((i) => i.phase === 'state'), 4000);
        check('S 占位 → 真实：state（cloud:null）', it2 && it2.cloud, null);
        await sleep(500);
        check('S 占位 → 真实：没有 fs 消息', ev2.fsMsgs(p).length, 0);
        const sb2 = await state(S);
        const f2 = sb2.files && sb2.files[p];
        check('S 下载回来后 unread:false', f2 && f2.unread, false);
        const newMtime = fs.statSync(p).mtimeMs;
        ok('S 继承已读：store.seen[b.md] ≥ 新 mtime', ((S.readStore() || {}).seen[p] || 0) >= newMtime, [(S.readStore() || {}).seen[p], newMtime]);
        ev2.close();
      }

      // N5：重命名不被吞
      {
        const from = s('rn.md');
        const to = s('rn2.md');
        const ev = openSse(S);
        await ev.ready;
        const r = await post(S, '/api/rename', { path: from, name: 'rn2.md' });
        check('S 重命名本地文件 → 200', [r.status, r.json && r.json.path], [200, to]);
        const m = await waitFor(() => ev.fsMsgs(to).find((x) => x.selfReason === 'rename'), 4000);
        ok('S 重命名的新路径推了 fs 消息且 selfReason:rename', !!m, ev.fsMsgs(to));
        const kinds = await waitFor(async () => { const k = await activityKinds(S, to); return k.includes(0) ? k : null; }, 2000);
        ok('S 重命名记了活动日志 a', !!kinds);
        ev.close();
      }

      // AC25 服务端：钩子 5 次 × 40 个路径，间隔 200ms
      {
        ok('S 爆发前等过 3 秒窗口', await waitIndexQuiet(S));
        const ev = openSse(S);
        await ev.ready;
        const burst = Array.from({ length: 200 }, (_, i) => s(`burst/b${String(i + 1).padStart(3, '0')}.md`));
        const t0 = Date.now();
        for (let k = 0; k < 5; k++) {
          const add = burst.slice(k * 40, k * 40 + 40);
          await writeHook(S, (h) => { h.dataless = [...h.dataless, ...add]; }, 0);
          const due = t0 + (k + 1) * 200;
          if (Date.now() < due) await sleep(due - Date.now());
        }
        await sleep(Math.max(0, t0 + 4000 - Date.now()));
        const msgs = ev.cloudMsgs().filter((x) => x.at <= t0 + 4000);
        const covered = new Set();
        for (const x of msgs) for (const it of x.m.items || []) if (burst.includes(it.path) && it.phase === 'state' && it.cloud === 'dataless') covered.add(it.path);
        ok('S 爆发：4 秒内 cloud 消息 ≤ 3 条', msgs.length >= 1 && msgs.length <= 3, msgs.length);
        check('S 爆发：合计覆盖 200 个路径', covered.size, 200);
        check('S 爆发：没有 fs 消息', ev.fsMsgs().filter((m) => burst.includes(m.path)).length, 0);
        ev.close();
      }

      // AC24 的 429 映射：q01…q11（读取桩 delay:2000）
      {
        const res = [];
        for (let i = 1; i <= 11; i++) {
          const r = await post(S, '/api/icloud/download', { path: s(`q/q${String(i).padStart(2, '0')}.md`) });
          res.push(r.status);
        }
        check('S 并发 2 + 排队 8：前 10 个 202，第 11 个 429', res, [202, 202, 202, 202, 202, 202, 202, 202, 202, 202, 429]);
        const r11 = await post(S, '/api/icloud/download', { path: s('q/q11.md') });
        check('S 429 的负载', [r11.status, r11.json && r11.json.error, !!(r11.json && r11.json.message)], [429, 'busy', true]);
      }

      check('S 全程没有读根外目标 / 符号链接 / 悬空占位', outsideTargets(), []);
    }
    S.stopSync();
  } catch (e) {
    failures++;
    console.error('\n  ✗ 异常：', e && e.stack || e);
  } finally {
    stopAll();
  }
  console.log(`\n总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})();
