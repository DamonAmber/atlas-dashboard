// iCloud 云盘：前端（design §11.4，plan FEAT-003）
//
// 不碰真实 iCloud：四个隔离实例全部用临时目录 + 测试专用变量
//   ATLAS_ICLOUD_PLATFORM=darwin   覆盖平台（Linux CI 上也能跑云端分支）
//   ATLAS_ICLOUD_ROOT=<tmp 目录>|off
//   ATLAS_TEST_CLOUD=<ATLAS_HOME>/cloud-hook.json  测试钩子：哪些路径算 dataless、brctl / 读取回退的桩
//
//   A'  iCloud 根另建、不在扫描根里：设置里「添加 iCloud 云盘」→ 路径逐字节写进 config、友好名
//   U'  iCloud 根 = 扫描根，brctl 不支持（只有读取回退）：已添加态、能力分支、主题 / 信任等导航点零请求、
//       驱逐、失败重试、爆发下的重拉上限、SSE 首次连接不重拉
//   S'  iCloud 根 = 扫描根，brctl 支持：灰显与徽标、封面卡、⌘K、Tab 恢复、peek、能力分支、
//       后台 / 打开着的文档下载完成不造成未读与通知、reduced-motion
//   OFF ATLAS_ICLOUD_ROOT=off：入口隐藏
//
// 计数类用例（AC25 前端两条、SSE 首次连接、N3 的 /api/seen）都先调 freshCountWindow（plan M4）：
// 重载并跳过加载那一次 /api/state，再等 800ms 没有 /api/state 才开始计数；窗口超过 50 秒直接报错，
// 避开 app.js 唯一的 60 秒定时器。不用 page.clock（会把 400ms 去抖、SSE 重连一起冻住）。
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');
const { startAtlas, autoAcceptDialogs } = require('./helpers/isolated-atlas');
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
async function waitFor(fn, timeout = 4000, step = 50) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > timeout) return null;
    await sleep(step);
  }
}
const PLIST = (k) => `<?xml version="1.0"?><plist><dict><key>NSURLNameKey</key><string>${k}</string></dict></plist>`;
const ICLOUD_SUB = 'Mobile Documents/com~apple~CloudDocs';

// ---------- 接口工具（spec 侧直接调服务端，不经页面） ----------
function request(base, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, method, path: urlPath,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout ' + urlPath)));
    if (data) req.write(data);
    req.end();
  });
}
const apiGet = (a, p) => request(a.base, 'GET', p);
const apiPost = (a, p, body) => request(a.base, 'POST', p, body === undefined ? {} : body);
const hookFile = (a) => path.join(a.homeDir, 'cloud-hook.json');
// 读-改-写钩子文件。N6：先写 .tmp 再 rename，服务端 100ms 轮询不会读到半截 JSON
async function writeHook(a, patch, wait = 150) {
  const file = hookFile(a);
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  const next = typeof patch === 'function' ? (patch(cur) || cur) : { ...cur, ...patch };
  fs.writeFileSync(file + '.tmp', JSON.stringify(next, null, 2));
  fs.renameSync(file + '.tmp', file);
  if (wait) await sleep(wait);
}
// 等 buildIndex 之后的 3 秒竞态窗口过去（design §6.2），状态切换类用例之前调用
async function waitIndexQuiet(a) {
  await apiGet(a, '/api/state');
  return !!(await waitFor(async () => {
    const r = await apiGet(a, '/api/icloud');
    const ms = r.json && r.json._debug && r.json._debug.msSinceIndexBuilt;
    return Number.isFinite(ms) && ms >= 3500;
  }, 8000, 200));
}
// 起一个带钩子的实例：files 写进扫描根，hook(dirs) 返回钩子 JSON，extra(dirs) 造额外的目录 / mtime
async function startCloud({ prefix, icloudRoot, scanDirNames, files, hook, extra }) {
  return startAtlas({
    prefix,
    files,
    scanDirNames,
    beforeSpawn: async ({ tmp, home, scanDirs }) => {
      const dirs = { tmp, home, root: scanDirs[0], scanDirs, abs: (rel) => path.join(scanDirs[0], rel) };
      if (extra) await extra(dirs);
      const env = { ATLAS_ICLOUD_PLATFORM: 'darwin' };
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

// ---------- 页面工具 ----------
// 每个页面在 goto 之前：打开通知开关并把 Notification 换成计数 stub（notify() 的两个前置条件都满足，
// 「0 次」断言才有意义，N9）；默认关掉悬停预览，免得浮窗盖住要点的按钮（peek 用例里再打开）
async function newPage(browser, a) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('atlas:notify', '1');
      localStorage.setItem('atlas:peek', 'off');
    } catch {}
    window.__notifyCount = 0;
    class FakeNotification {
      constructor() { window.__notifyCount++; }
      close() {}
    }
    FakeNotification.permission = 'granted';
    FakeNotification.requestPermission = async () => 'granted';
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
  });
  const page = await ctx.newPage();
  await autoAcceptDialogs(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const reqs = [];   // 全部请求（url, method, at），用来断言「没有对某文件的内容请求」
  page.on('request', (r) => reqs.push({ url: r.url(), method: r.method(), at: Date.now() }));
  await page.goto(a.base, { waitUntil: 'load' });
  await page.waitForSelector('#tree .file[data-path]');
  await waitSseOpen(page);
  // /api/icloud 首次拿到之后才有下载按钮
  await page.waitForFunction(() => state.icloud !== null, null, { timeout: 8000 });
  return { ctx, page, errors, reqs };
}
async function waitSseOpen(page) {
  await page.waitForFunction(() => typeof evtSrc !== 'undefined' && evtSrc && evtSrc.readyState === 1, null, { timeout: 8000 });
}
const rowSel = (abs) => `#tree .file[data-path="${abs.replace(/"/g, '\\"')}"]`;
// 某个文件的内容请求（/raw、render-md、render-doc、edit-doc、md-source）：URL 里带它的路径
function contentReqsFor(reqs, abs, rootIdx = 0, rootDir = null, since = 0) {
  const enc = encodeURIComponent(abs);
  const rel = rootDir ? path.relative(rootDir, abs) : null;
  const rawPath = rel ? `/raw/${rootIdx}/` + rel.split(path.sep).map(encodeURIComponent).join('/') : null;
  return reqs.filter((r) => r.at >= since && (
    (/\/api\/(render-md|render-doc|edit-doc|md-source|thumb)\b/.test(r.url) && r.url.includes(enc))
    || (rawPath && new URL(r.url).pathname === rawPath)
  )).map((r) => r.url);
}
async function openRow(page, abs) {
  await page.click(`${rowSel(abs)} .file-name`);
  await page.waitForFunction((p) => state.activeFilePath === p, abs, { timeout: 5000 });
}
async function panelVisible(page) {
  return page.evaluate(() => {
    const el = document.getElementById('cloud-panel');
    return !!el && !el.classList.contains('hidden') && el.getBoundingClientRect().height > 0;
  });
}
async function toastTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
}
// 等 part 匹配的请求静默 quietMs，返回静默期间看到的请求数
async function waitNoRequest(page, part, quietMs, maxMs = 10000) {
  let last = Date.now();
  let n = 0;
  const on = (r) => { if (r.url().includes(part)) { last = Date.now(); n++; } };
  page.on('request', on);
  const t0 = Date.now();
  while (Date.now() - last < quietMs && Date.now() - t0 < maxMs) await sleep(50);
  page.off('request', on);
  return n;
}
// plan M4：重载 → 跳过加载那一次 /api/state → 800ms 内没有 /api/state 才开始计数。
// done() 时距 t0 超过 50 秒就报错（再往后就可能撞上 60 秒定时器那一拍）
async function freshCountWindow(page) {
  const t0 = Date.now();
  await Promise.all([page.waitForResponse((r) => r.url().includes('/api/state')), page.reload()]);
  const settle = await waitNoRequest(page, '/api/state', 800);
  await waitSseOpen(page);
  const reqs = [];
  const on = (r) => { if (r.url().includes('/api/state')) reqs.push(Date.now()); };
  page.on('request', on);
  return {
    t0, settle, reqs,
    done() {
      page.off('request', on);
      if (Date.now() - t0 > 50_000) throw new Error('计数窗口超出 60s 定时器的安全区');
      return reqs.length;
    },
  };
}
async function rowInfo(page, abs) {
  return page.evaluate((p) => {
    const row = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`);
    if (!row) return null;
    const badge = row.querySelector('.cloud-badge');
    const dl = row.querySelector('[data-act="cloud-download"]');
    return {
      cloud: row.classList.contains('is-cloud'),
      downloading: row.classList.contains('is-downloading'),
      unread: row.classList.contains('unread'),
      just: row.classList.contains('just-changed'),
      height: +row.getBoundingClientRect().height.toFixed(2),
      badge: badge ? badge.getAttribute('aria-label') : null,
      dl: dl ? { disabled: dl.disabled, busy: dl.getAttribute('aria-busy'), title: dl.title } : null,
      shareDisabled: !!(row.querySelector('[data-act="share"]') || {}).disabled,
      renameDisabled: !!(row.querySelector('[data-act="rename-file"]') || {}).disabled,
    };
  }, abs);
}
async function clickRowDownload(page, abs) {
  await page.hover(`${rowSel(abs)} .file-name`);
  await sleep(200);
  const respP = page.waitForResponse((r) => r.url().includes('/api/icloud/download') && r.request().method() === 'POST', { timeout: 8000 });
  await page.click(`${rowSel(abs)} [data-act="cloud-download"]`);
  return respP;
}

(async () => {
  const instances = [];
  const browser = await chromium.launch();
  const stopAll = () => { for (const a of instances) { try { a.stopSync(); } catch {} } };
  try {
    // =====================================================================
    console.log("\n[A'：iCloud 根不在扫描根里 → 设置里点击添加（AC1、AC3、AC5，M7）]");
    let icloudDirA = null;
    const A = await startCloud({
      prefix: 'atlas-icloud-ui-a-',
      scanDirNames: ['scan'],
      files: { 'proj/a.md': '# a\n' },
      icloudRoot: ({ tmp }) => path.join(tmp, ICLOUD_SUB),
      extra: ({ tmp }) => {
        icloudDirA = path.join(tmp, ICLOUD_SUB);
        fs.mkdirSync(icloudDirA, { recursive: true });
        fs.writeFileSync(path.join(icloudDirA, 'x.md'), '# 云盘里的 x\n');
      },
      hook: () => ({ brctl: 'unsupported' }),
    });
    instances.push(A);
    {
      const { ctx, page, errors } = await newPage(browser, A);
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-modal:not(.hidden)');
      await page.waitForSelector('#root-icloud', { state: 'visible', timeout: 5000 }).catch(() => {});
      check("A' 设置里 #root-icloud 可见", await page.isVisible('#root-icloud'), true);
      const btn0 = await page.evaluate(() => {
        const b = document.getElementById('root-icloud-btn');
        return b && { disabled: b.disabled, text: b.textContent.trim() };
      });
      check("A' 按钮可点、文字是「添加 iCloud 云盘」", btn0, { disabled: false, text: '添加 iCloud 云盘' });
      await page.click('#root-icloud-btn');
      await page.waitForFunction(() => [...document.querySelectorAll('#toast-container .toast')].some((t) => t.textContent.includes('已添加 iCloud 云盘')), null, { timeout: 8000 }).catch(() => {});
      ok("A' 出现 toast「已添加 iCloud 云盘」", (await toastTexts(page)).some((t) => t.includes('已添加 iCloud 云盘')), await toastTexts(page));
      const saved = A.readConfig().scanRoots;
      ok("A' config.json 的 scanRoots[1] 与 iCloud 根逐字节相同（含空格和 ~）",
        saved.length === 2 && Buffer.compare(Buffer.from(saved[1]), Buffer.from(icloudDirA)) === 0, saved);
      await page.waitForFunction(() => document.querySelectorAll('#root-list li').length === 2, null, { timeout: 5000 }).catch(() => {});
      const li = await page.evaluate(() => {
        const items = [...document.querySelectorAll('#root-list li')];
        const it = items[1];
        if (!it) return null;
        const lab = it.querySelector('.root-label');
        const rp = it.querySelector('.root-path');
        return { n: items.length, label: lab && lab.textContent, path: rp && rp.textContent, title: rp && rp.getAttribute('title') };
      });
      check("A' 根列表新增一项：.root-label 是「iCloud 云盘」，.root-path 与 title 是完整路径",
        li, { n: 2, label: 'iCloud 云盘', path: icloudDirA, title: icloudDirA });
      await page.waitForFunction(() => document.getElementById('root-icloud-btn').disabled, null, { timeout: 5000 }).catch(() => {});
      const btn1 = await page.evaluate(() => {
        const b = document.getElementById('root-icloud-btn');
        return { disabled: b.disabled, text: b.textContent.trim() };
      });
      check("A' 按钮变成「已添加 iCloud 云盘」并 disabled", btn1, { disabled: true, text: '已添加 iCloud 云盘' });
      const toastsBefore = (await toastTexts(page)).filter((t) => t.includes('iCloud 云盘')).length;
      await page.click('#root-icloud-btn', { force: true });
      await sleep(600);
      const toastsAfter = (await toastTexts(page)).filter((t) => t.includes('iCloud 云盘')).length;
      check("A' 再点一次（force）没有新 toast、scanRoots 仍是 2 个", [toastsAfter <= toastsBefore, A.readConfig().scanRoots.length], [true, 2]);
      await page.evaluate(() => closeSettings());
      const xPath = path.join(icloudDirA, 'x.md');
      await page.waitForSelector(rowSel(xPath), { timeout: 8000 }).catch(() => {});
      const groupName = await page.evaluate((p) => {
        const row = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`);
        const folder = row && row.closest('.folder');
        const n = folder && folder.querySelector(':scope > .folder-header .folder-name');
        return n ? n.textContent.trim() : null;
      }, xPath);
      check("A' 关掉设置后，侧栏里 x.md 所在分组显示「iCloud 云盘」", groupName, 'iCloud 云盘');
      const store = A.readStore() || {};
      const folder = (store.tree || []).find((nd) => nd.type === 'folder' && nd.autoFor === 'com~apple~CloudDocs');
      check("A' store 里分组名仍是原名（友好名只在显示层）", folder && folder.name, 'com~apple~CloudDocs');
      check("A' 没有 pageerror", errors, []);
      await ctx.close();
    }
    A.stopSync();

    // =====================================================================
    console.log('\n[OFF：ATLAS_ICLOUD_ROOT=off → 入口隐藏（AC2）]');
    const OFF = await startCloud({
      prefix: 'atlas-icloud-ui-off-',
      files: { 'a.md': '# a\n' },
      icloudRoot: 'off',
      hook: () => ({ brctl: 'unsupported' }),
    });
    instances.push(OFF);
    {
      const { ctx, page, errors } = await newPage(browser, OFF);
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-modal:not(.hidden)');
      await sleep(300);
      check('OFF #root-icloud 隐藏', await page.isHidden('#root-icloud'), true);
      check('OFF 没有 pageerror', errors, []);
      await ctx.close();
    }
    OFF.stopSync();

    // =====================================================================
    console.log("\n[S'：灰显、封面卡、⌘K、Tab 恢复、peek、能力、下载完成不造成未读 / 通知（AC13–17）]");
    const sFiles = {
      'other.md': '# other\n\n本地对照\n',
      'cloud-c.md': '# 云端 C\n\n正文\n',
      '.云端.md.icloud': PLIST('云端.md'),
      'dl-ui-bg.md': '# 后台下载\n',
      'dl-ui-open.md': '# 打开着下载\n',
    };
    const S = await startCloud({
      prefix: 'atlas-icloud-ui-s-',
      scanDirNames: [ICLOUD_SUB],
      files: sFiles,
      hook: ({ abs }) => ({
        brctl: 'supported',
        brctlBehavior: 'materialize',
        settleMs: 2000,
        dataless: ['cloud-c.md', 'dl-ui-bg.md', 'dl-ui-open.md'].map(abs),
      }),
    });
    instances.push(S);
    const s = (rel) => S.filePath(rel);
    {
      const { ctx, page, errors, reqs } = await newPage(browser, S);
      const cc = s('cloud-c.md');
      const ph = s('云端.md');

      // ---- 灰显与徽标（AC13） ----
      const r1 = await rowInfo(page, cc);
      check("S' dataless 行 is-cloud、徽标 aria-label 含「在 iCloud 中」、行高 26px",
        r1 && [r1.cloud, /在 iCloud 中/.test(r1.badge || ''), r1.height], [true, true, 26]);
      check("S' 云端行的分享、重命名文件按钮禁用", r1 && [r1.shareDisabled, r1.renameDisabled], [true, true]);
      const r2 = await rowInfo(page, ph);
      check("S' 占位行 is-cloud、带徽标、行高 26px", r2 && [r2.cloud, !!r2.badge, r2.height], [true, true, 26]);
      const rl = await rowInfo(page, s('other.md'));
      check("S' 本地行没有 is-cloud / 徽标 / 下载按钮", rl && [rl.cloud, rl.badge, rl.dl], [false, null, null]);
      // ---- 能力（AC16）：brctl 支持 → dataless 与占位都有下载按钮 ----
      check("S' 能力：dataless 行与占位行都有下载按钮", [!!(r1 && r1.dl), !!(r2 && r2.dl)], [true, true]);

      // ---- 封面卡（N7，FR-4.1） ----
      const card = await page.evaluate((p) => {
        const c = document.querySelector(`#home-grid .cover-card[data-path="${CSS.escape(p)}"]`);
        if (!c) return null;
        const cl = c.querySelector('.cover-cloud');
        return { cloud: c.classList.contains('is-cloud'), text: cl && cl.textContent.trim(), visible: !!(cl && cl.getBoundingClientRect().height > 0), img: !!c.querySelector('img') };
      }, cc);
      check("S' 首页封面卡：is-cloud、.cover-cloud 可见且含「在 iCloud 中」、没有缩略图 <img>",
        card && [card.cloud, card.visible, /在 iCloud 中/.test(card.text || ''), card.img], [true, true, true, false]);
      ok("S' 页面加载后没有请求云端文件的缩略图", !reqs.some((r) => r.url.includes('/api/thumb') && r.url.includes(encodeURIComponent(cc))));

      // ---- ⌘K（FR-4.1）：结果有 is-cloud 和徽标；从 ⌘K 打开 → 占位面板、没有 render 请求 ----
      const tQo = Date.now();
      await page.keyboard.press('Meta+k');
      await page.waitForSelector('#quickopen:not(.hidden)');
      await page.fill('#quickopen-input', 'cloud-c');
      await page.waitForSelector(`#quickopen-list .quickopen-item[data-path="${cc}"]`, { timeout: 5000 }).catch(() => {});
      const qo = await page.evaluate((p) => {
        const it = document.querySelector(`#quickopen-list .quickopen-item[data-path="${CSS.escape(p)}"]`);
        if (!it) return null;
        const b = it.querySelector('.cloud-badge');
        return { cloud: it.classList.contains('is-cloud'), badge: b && b.getAttribute('aria-label') };
      }, cc);
      check("S' ⌘K 结果项 is-cloud、徽标文字含「在 iCloud 中」", qo && [qo.cloud, /在 iCloud 中/.test(qo.badge || '')], [true, true]);
      await page.click(`#quickopen-list .quickopen-item[data-path="${cc}"]`);
      await page.waitForFunction((p) => state.activeFilePath === p, cc, { timeout: 5000 });
      await sleep(400);
      check("S' 从 ⌘K 打开云端文件 → #cloud-panel 可见", await panelVisible(page), true);
      check("S' 从 ⌘K 打开后没有对 cloud-c.md 的 /raw、render 请求", contentReqsFor(reqs, cc, 0, S.scanDir, tQo), []);
      const panel = await page.evaluate(() => ({
        title: document.getElementById('cloud-panel-title').textContent,
        dl: !document.getElementById('cloud-download-btn').hidden,
        hint: !document.getElementById('cloud-panel-hint').hidden,
      }));
      check("S' 占位面板：标题、下载按钮可见、不支持提示隐藏", panel, { title: 'cloud-c', dl: true, hint: false });
      // AC14：编辑、导出、分享、对比、刷新、在浏览器打开被禁用
      const btns = await page.evaluate(() => ['btn-edit', 'btn-export-pdf', 'btn-share', 'btn-diff', 'btn-reload-preview', 'btn-open-external']
        .map((id) => { const b = document.getElementById(id); return b ? b.disabled : 'missing'; }));
      check("S' 云端文档：编辑 / 导出 / 分享 / 对比 / 刷新 / 在浏览器打开都禁用", btns, [true, true, true, true, true, true]);
      check("S' 云端文档：在访达中显示、复制路径仍可用", await page.evaluate(() => [document.getElementById('btn-reveal').disabled, document.getElementById('btn-copy-path').disabled]), [false, false]);
      check("S' 云端文档的 title 写明原因", await page.evaluate(() => document.getElementById('btn-edit').title), '文件在 iCloud 中，下载后可用');
      // 打开云端文件不在本地清未读（Q7）
      check("S' 打开云端文件后本地 unread 仍为 true", await page.evaluate((p) => state.files[p].unread, cc), true);

      // ---- Tab 恢复（N7，FR-4.2） ----
      const tReload = Date.now();
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction((p) => state.activeFilePath === p, cc, { timeout: 8000 }).catch(() => {});
      await sleep(800);
      check("S' 重载后恢复出来的活动 Tab 显示 #cloud-panel", await panelVisible(page), true);
      check("S' 重载之后没有对 cloud-c.md 的 /raw、render 请求", contentReqsFor(reqs, cc, 0, S.scanDir, tReload), []);
      await waitSseOpen(page);

      // ---- peek（AC15、N6）：悬停云端行 → 不建帧（或 about:blank），显示占位文案 ----
      await page.evaluate(() => applyPeekSetting('on'));
      const tPeek = Date.now();
      await page.mouse.move(900, 12);
      await page.hover(`${rowSel(ph)} .file-name`);
      await page.waitForFunction(() => !document.getElementById('peek').classList.contains('hidden'), null, { timeout: 3000 }).catch(() => {});
      await sleep(300);
      const pk = await page.evaluate(() => {
        const f = document.querySelector('#peek .peek-frame');
        const em = document.getElementById('peek-empty');
        return {
          open: !document.getElementById('peek').classList.contains('hidden'),
          frameOk: !f || !f.getAttribute('src') || f.getAttribute('src') === 'about:blank',
          empty: em && !em.classList.contains('hidden') ? em.textContent : null,
        };
      });
      check("S' peek：浮窗打开、.peek-frame 不存在或 about:blank、显示占位文案",
        [pk.open, pk.frameOk, /iCloud/.test(pk.empty || '')], [true, true, true]);
      check("S' peek 期间没有对占位文件的内容请求", contentReqsFor(reqs, ph, 0, S.scanDir, tPeek), []);
      await page.mouse.move(900, 12);
      await sleep(300);
      await page.evaluate(() => applyPeekSetting('off'));

      // ---- reduced-motion：下载中的徽标不动 ----
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate((p) => applyCloudUpdates([{ path: p, busy: true }]), ph);
      const animReduce = await page.evaluate((p) => {
        const b = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"].is-downloading .cloud-badge`);
        return b ? getComputedStyle(b).animationName : null;
      }, ph);
      check("S' reduced-motion 下 .is-downloading .cloud-badge 的 animation-name 是 none", animReduce, 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const animNormal = await page.evaluate((p) => {
        const b = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"].is-downloading .cloud-badge`);
        return b ? getComputedStyle(b).animationName : null;
      }, ph);
      check("S' 对照：正常偏好下下载中的徽标在呼吸（atlas-cloud-pulse）", animNormal, 'atlas-cloud-pulse');
      const busyRow = await rowInfo(page, ph);
      check("S' 下载中：行带 is-downloading，下载按钮 disabled + aria-busy + 「下载中…」",
        busyRow && [busyRow.downloading, busyRow.dl && busyRow.dl.disabled, busyRow.dl && busyRow.dl.busy, busyRow.dl && busyRow.dl.title],
        [true, true, 'true', '下载中…']);
      await page.evaluate((p) => applyCloudUpdates([{ path: p, busy: false }]), ph);

      // ---- 下载 · 后台文档（AC17-i，首轮 M9） ----
      const seenAll = await apiPost(S, '/api/seen/all');
      check("S' 预置 seen（POST /api/seen/all）", seenAll.status, 200);
      ok("S' 索引重建窗口已过（waitIndexQuiet）", await waitIndexQuiet(S));
      await page.evaluate(() => goHome({ confirmDirty: false }));
      await page.reload({ waitUntil: 'load' });
      await page.waitForSelector(rowSel(s('other.md')));
      await waitSseOpen(page);
      await page.waitForFunction(() => state.icloud !== null, null, { timeout: 8000 });
      await openRow(page, s('other.md'));
      const bg = s('dl-ui-bg.md');
      const seenBefore = (S.readStore() || {}).seen || {};
      const before = await rowInfo(page, bg);
      check("S' 后台文档下载前：is-cloud、没有未读", before && [before.cloud, before.unread], [true, false]);
      const resp = await clickRowDownload(page, bg);
      check("S' 后台文档：下载接口 202", resp.status(), 202);
      const busy = await rowInfo(page, bg);
      ok("S' 后台文档：按钮变成「下载中…」、disabled、aria-busy=true（或已经完成）",
        !busy.cloud || (busy.dl && busy.dl.disabled && busy.dl.busy === 'true' && busy.dl.title === '下载中…'), busy);
      await page.waitForFunction((p) => { const r = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`); return r && !r.classList.contains('is-cloud'); }, bg, { timeout: 8000 }).catch(() => {});
      await sleep(400);
      const after = await rowInfo(page, bg);
      check("S' 后台文档完成后：is-cloud 消失、没有 .unread、没有 .just-changed",
        after && [after.cloud, after.unread, after.just], [false, false, false]);
      check("S' 后台文档完成后：__notifyCount 为 0", await page.evaluate(() => window.__notifyCount), 0);
      check("S' 后台文档完成后：store.seen 与下载前相同", ((S.readStore() || {}).seen || {})[bg], seenBefore[bg]);
      ok("S' 后台文档完成后：toast「已下载」", (await toastTexts(page)).some((t) => t.includes('已下载')), await toastTexts(page));
      check("S' 后台文档完成后：活动 Tab 仍是 other.md、没有占位面板", [await page.evaluate(() => state.activeFilePath), await panelVisible(page)], [s('other.md'), false]);

      // ---- 下载 · 打开着的文档（AC17-ii，首轮 M9 + N3） ----
      const op = s('dl-ui-open.md');
      await openRow(page, op);
      await sleep(300);
      check("S' 打开 dl-ui-open.md → 占位面板", await panelVisible(page), true);
      const win = await freshCountWindow(page);   // 重载：活动 Tab 恢复后仍是占位面板
      await page.waitForFunction((p) => state.activeFilePath === p, op, { timeout: 8000 }).catch(() => {});
      await page.waitForFunction(() => state.icloud !== null, null, { timeout: 8000 });
      await sleep(200);
      check("S' 重载后 dl-ui-open.md 仍显示占位面板", await panelVisible(page), true);
      const seenPosts = [];
      const onSeen = (r) => { if (r.url().endsWith('/api/seen') && r.method() === 'POST') seenPosts.push(r.postData()); };
      const tClick = Date.now();
      const respP = page.waitForResponse((r) => r.url().includes('/api/icloud/download'), { timeout: 8000 });
      page.on('request', onSeen);
      await page.click('#cloud-download-btn');
      const resp2 = await respP;
      check("S' 打开着的文档：下载接口 202", resp2.status(), 202);
      await page.waitForFunction(() => document.getElementById('cloud-panel').classList.contains('hidden'), null, { timeout: 8000 }).catch(() => {});
      check("S' 打开着的文档完成后：#cloud-panel 隐藏", await panelVisible(page), false);
      const encOp = encodeURIComponent(op);
      await page.waitForFunction((enc) => { const f = document.getElementById('preview'); return f && (f.getAttribute('src') || '').includes('render-md?path=' + enc); }, encOp, { timeout: 5000 }).catch(() => {});
      const opSrc = await page.evaluate(() => { const f = document.getElementById('preview'); return f ? f.getAttribute('src') || '' : ''; });
      ok("S' 打开着的文档完成后：预览帧 src 指向 render-md?path=…dl-ui-open.md", opSrc.includes('render-md?path=' + encOp), opSrc);
      await sleep(1000);
      page.off('request', onSeen);
      check("S' N3：点击下载之后恰好发出 1 次 POST /api/seen（下载后第一次真正打开补已读）", seenPosts.length, 1);
      const opRow = await rowInfo(page, op);
      check("S' 打开着的文档完成后：没有 .unread、__notifyCount 为 0", [opRow && opRow.unread, await page.evaluate(() => window.__notifyCount)], [false, 0]);
      check("S' 打开着的文档完成后：编辑 / 导出按钮恢复可用", await page.evaluate(() => [document.getElementById('btn-edit').disabled, document.getElementById('btn-export-pdf').disabled]), [false, false]);
      check("S' 打开着的文档：点下载之前没有对这篇的 /raw、render 请求",
        contentReqsFor(reqs.filter((r) => r.at < tClick), op, 0, S.scanDir, 0), []);
      win.done();

      // ---- 通知正向对照：改写本地文件 → 有通知（证明 stub 与开关都生效） ----
      fs.writeFileSync(s('other.md'), '# other\n\n改过了 ' + Date.now() + '\n');
      await page.waitForFunction(() => window.__notifyCount >= 1, null, { timeout: 8000 }).catch(() => {});
      check("S' 正向对照：改写 other.md 后 __notifyCount 变成 1", await page.evaluate(() => window.__notifyCount), 1);
      check("S' 没有 pageerror", errors, []);
      await ctx.close();
    }
    S.stopSync();

    // =====================================================================
    console.log("\n[U'：已添加态、能力分支、导航点零请求、驱逐、失败重试、爆发上限、SSE 首连（AC1、AC14、AC16、AC18、AC25）]");
    const OLD = Date.now() - 3 * 86_400_000;
    const uFiles = {
      'other.md': '# other\n\n本地\n',
      'cloud-c.md': '# 云端 C\n',
      '.云端.md.icloud': PLIST('云端.md'),
      'cloud-nav.md': '# 导航点\n',
      'cloud-nav.html': '<!doctype html><h1>导航点</h1>',
      'ev.md': '# 将被驱逐\n',
      'dl-ui-fail.md': '# 失败重试\n',
    };
    for (let i = 1; i <= 200; i++) uFiles[`hb/h${String(i).padStart(3, '0')}.md`] = `# h${i}\n`;
    const U = await startCloud({
      prefix: 'atlas-icloud-ui-u-',
      scanDirNames: [ICLOUD_SUB],
      files: uFiles,
      extra: ({ root }) => {
        fs.mkdirSync(path.join(root, 'rw'), { recursive: true });
        // hb/ 拉到 3 天前：首页封面墙与「最近」不被 200 篇淹没
        for (let i = 1; i <= 200; i++) {
          const f = path.join(root, 'hb', `h${String(i).padStart(3, '0')}.md`);
          fs.utimesSync(f, OLD / 1000, OLD / 1000);
        }
      },
      hook: ({ abs }) => ({
        brctl: 'unsupported',
        settleMs: 2000,
        dataless: ['cloud-c.md', 'cloud-nav.md', 'cloud-nav.html', 'dl-ui-fail.md'].map(abs),
        readBehavior: { [abs('dl-ui-fail.md')]: 'fail:EIO' },
      }),
    });
    instances.push(U);
    const u = (rel) => U.filePath(rel);
    {
      const { ctx, page, errors, reqs } = await newPage(browser, U);

      // ---- 设置 · 已添加（AC1） ----
      await page.click('#btn-settings');
      await page.waitForSelector('#settings-modal:not(.hidden)');
      await page.waitForSelector('#root-icloud', { state: 'visible', timeout: 5000 }).catch(() => {});
      const ub = await page.evaluate(() => {
        const b = document.getElementById('root-icloud-btn');
        return { visible: !document.getElementById('root-icloud').hidden, disabled: b.disabled, text: b.textContent.trim() };
      });
      check("U' 打开设置时按钮一开始就 disabled、文字「已添加 iCloud 云盘」", ub, { visible: true, disabled: true, text: '已添加 iCloud 云盘' });
      check("U' 根列表里 iCloud 根带友好名", await page.evaluate(() => { const l = document.querySelector('#root-list li .root-label'); return l && l.textContent; }), 'iCloud 云盘');
      await page.evaluate(() => closeSettings());
      check("U' 根下直属文件的分组显示「iCloud 云盘」", await page.evaluate((p) => {
        const row = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`);
        const n = row && row.closest('.folder') && row.closest('.folder').querySelector(':scope > .folder-header .folder-name');
        return n && n.textContent.trim();
      }, u('other.md')), 'iCloud 云盘');

      // ---- 能力（AC16）：只有读取回退 → dataless 有下载按钮、占位没有 ----
      const d1 = await rowInfo(page, u('cloud-c.md'));
      const p1 = await rowInfo(page, u('云端.md'));
      check("U' 能力：dataless 行有下载按钮、占位行没有", [!!(d1 && d1.dl), !!(p1 && p1.dl), !!(p1 && p1.cloud)], [true, false, true]);
      await openRow(page, u('云端.md'));
      await sleep(300);
      const phPanel = await page.evaluate(() => ({
        dl: !document.getElementById('cloud-download-btn').hidden,
        hint: !document.getElementById('cloud-panel-hint').hidden,
      }));
      check("U' 打开占位文件：占位面板不给下载按钮、显示「在访达中下载」提示", [await panelVisible(page), phPanel.dl, phPanel.hint], [true, false, true]);

      // ---- 其他导航点（首轮 M4）：主题、全局信任开关、清空信任、单篇信任 ----
      const nm = u('cloud-nav.md');
      const nh = u('cloud-nav.html');
      const tNav = Date.now();
      await openRow(page, nm);
      await sleep(300);
      check("U' cloud-nav.md 打开 → 占位面板", await panelVisible(page), true);
      await page.evaluate(() => switchTheme('dark'));
      await sleep(600);
      check("U' 切换主题（themeHeavyRefresh）后占位面板仍在", await panelVisible(page), true);
      await openRow(page, nh);
      await sleep(300);
      await page.evaluate(() => document.getElementById('trust-all-toggle').click());   // 打开全局信任（确认框自动点确定）
      await page.waitForFunction(() => state.trustAllHtml === true, null, { timeout: 5000 }).catch(() => {});
      await sleep(300);
      await page.evaluate(() => document.getElementById('trust-all-toggle').click());   // 关回去
      await page.waitForFunction(() => state.trustAllHtml === false, null, { timeout: 5000 }).catch(() => {});
      await sleep(300);
      await page.evaluate(() => document.getElementById('trust-clear-btn').click());    // 清空信任
      await sleep(600);
      await page.evaluate(() => toggleTrust(true));
      await sleep(400);
      check("U' 全局信任开关 / 清空信任 / 单篇信任之后占位面板仍在", await panelVisible(page), true);
      check("U' 整个过程没有对 cloud-nav.md / cloud-nav.html 的 /raw、render 请求",
        [...contentReqsFor(reqs, nm, 0, U.scanDir, tNav), ...contentReqsFor(reqs, nh, 0, U.scanDir, tNav)], []);
      await page.evaluate(() => switchTheme('system'));
      await sleep(300);

      // ---- 驱逐（reloadTab / ensureFrameLoaded 的闸门） ----
      const ev = u('ev.md');
      const encEv = encodeURIComponent(ev);
      await openRow(page, ev);
      await page.waitForFunction((enc) => { const f = document.getElementById('preview'); return f && (f.getAttribute('src') || '').includes('render-md?path=' + enc); }, encEv, { timeout: 5000 }).catch(() => {});
      ok("U' 本地 ev.md 预览正常加载（render-md 请求发出）", reqs.some((r) => r.url.includes('render-md?path=' + encEv)));
      check("U' 本地 ev.md 没有占位面板", await panelVisible(page), false);
      ok("U' 索引重建窗口已过（waitIndexQuiet）", await waitIndexQuiet(U));
      const tEv = Date.now();
      await writeHook(U, (h) => { h.dataless = [...h.dataless, ev]; });
      await page.waitForFunction(() => !document.getElementById('cloud-panel').classList.contains('hidden'), null, { timeout: 5000 }).catch(() => {});
      check("U' 钩子把 ev.md 加进 dataless → 收到 state 后显示占位面板", await panelVisible(page), true);
      check("U' 驱逐后帧回 about:blank", await page.evaluate(() => { const f = document.getElementById('preview'); return f ? f.getAttribute('src') : null; }), 'about:blank');
      check("U' 驱逐不造成通知", await page.evaluate(() => window.__notifyCount), 0);
      await page.click(`#tab-bar .tab[data-path="${u('other.md')}"]`).catch(() => openRow(page, u('other.md')));
      await sleep(400);
      await page.click(`#tab-bar .tab[data-path="${ev}"]`);
      await sleep(600);
      check("U' 切到别的 Tab 再切回 ev.md：仍是占位面板", await panelVisible(page), true);
      check("U' 驱逐之后没有新的 render-md?path=…ev.md 请求", reqs.filter((r) => r.at >= tEv && r.url.includes('render-md?path=' + encEv)).length, 0);

      // ---- 失败与重试（AC18） ----
      const fl = u('dl-ui-fail.md');
      const rf = await clickRowDownload(page, fl);
      check("U' dl-ui-fail.md：下载接口 202", rf.status(), 202);
      await page.waitForFunction(() => [...document.querySelectorAll('#toast-container .toast')].some((t) => t.textContent.includes('读取失败')), null, { timeout: 8000 }).catch(() => {});
      ok("U' 失败：toast 里有「读取失败」原因", (await toastTexts(page)).some((t) => t.includes('读取失败')), await toastTexts(page));
      const failRow = await rowInfo(page, fl);
      check("U' 失败：行回到云端态、下载按钮恢复可点", failRow && [failRow.cloud, failRow.downloading, failRow.dl && failRow.dl.disabled], [true, false, false]);
      await writeHook(U, (h) => { h.readBehavior = { ...(h.readBehavior || {}), [fl]: 'delay:300' }; });
      const posts0 = reqs.filter((r) => r.url.includes('/api/icloud/download')).length;
      const rf2 = await clickRowDownload(page, fl);
      check("U' 重试：发出新的 POST、收到 202", [reqs.filter((r) => r.url.includes('/api/icloud/download')).length > posts0, rf2.status()], [true, 202]);
      await page.waitForFunction((p) => { const r = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`); return r && !r.classList.contains('is-cloud'); }, fl, { timeout: 8000 }).catch(() => {});
      check("U' 重试后最终 is-cloud 消失", (await rowInfo(page, fl) || {}).cloud, false);

      // ---- SSE 首次连接不发 /api/state（N3） ----
      ok("U' 索引重建窗口已过（waitIndexQuiet）", await waitIndexQuiet(U));
      const w0 = await freshCountWindow(page);
      check("U' 加载后的余波里没有第二次 /api/state（SSE 首次连接不重拉）", w0.settle, 0);
      await sleep(1500);
      check("U' SSE 首次连接后 1.5 秒内没有 /api/state", w0.done(), 0);
      // 正向对照：重连（sseEverOpened 已为 true）会补拉一次
      const w0b = await freshCountWindow(page);
      await page.evaluate(() => connectSSE());
      await waitSseOpen(page);
      await sleep(1200);
      check("U' 对照：SSE 重连后补拉 1 次 /api/state", w0b.done(), 1);

      // ---- 爆发 · 真实写入（AC25 前端）：5 批 × 40 个文件、间隔 200ms，4 秒内 /api/state ≤ 2 次 ----
      const w1 = await freshCountWindow(page);
      const tw = Date.now();
      for (let b = 0; b < 5; b++) {
        for (let i = 0; i < 40; i++) {
          const n = String(b * 40 + i + 1).padStart(3, '0');
          fs.writeFileSync(path.join(U.scanDir, 'rw', `r${n}.md`), `# r${n}\n`);
        }
        if (b < 4) await sleep(200);
      }
      await sleep(Math.max(0, 4000 - (Date.now() - tw)));
      const inWindow = w1.reqs.filter((t) => t - tw <= 4000).length;
      w1.done();
      ok(`U' 真实写入爆发：4 秒内 /api/state ≤ 2 次（实际 ${inWindow}）`, inWindow >= 1 && inWindow <= 2, w1.reqs.map((t) => t - tw));
      const rwSeen = await waitFor(() => page.evaluate(() => Object.keys(state.files).filter((p) => p.includes('/rw/')).length >= 200), 5000);
      ok("U' 真实写入爆发：200 个新文件最终都进了页面状态", !!rwSeen);

      // ---- 爆发 · 钩子（AC25 前端）：5 次 × 40 个 hb/* 变成 dataless，4 秒内 /api/state 为 0 ----
      ok("U' 索引重建窗口已过（waitIndexQuiet）", await waitIndexQuiet(U));
      const w2 = await freshCountWindow(page);
      const th = Date.now();
      for (let b = 0; b < 5; b++) {
        const add = [];
        for (let i = 0; i < 40; i++) add.push(path.join(U.scanDir, 'hb', `h${String(b * 40 + i + 1).padStart(3, '0')}.md`));
        await writeHook(U, (h) => { h.dataless = [...h.dataless, ...add]; }, 0);
        if (b < 4) await sleep(200);
      }
      await sleep(Math.max(0, 4000 - (Date.now() - th)));
      const hbCount = w2.done();
      check("U' 钩子爆发：4 秒内 /api/state 为 0（cloud 通道不落进 fs 兜底）", hbCount, 0);
      const hbCloud = await waitFor(() => page.evaluate(() => Object.values(state.files).filter((f) => f.path.includes('/hb/') && f.cloud === 'dataless').length === 200), 4000);
      ok("U' 钩子爆发：200 个路径都经 SSE cloud 就地标成云端", !!hbCloud,
        await page.evaluate(() => Object.values(state.files).filter((f) => f.path.includes('/hb/') && f.cloud).length));
      check("U' 钩子爆发：没有通知", await page.evaluate(() => window.__notifyCount), 0);
      check("U' 没有 pageerror", errors, []);
      await ctx.close();
    }
    U.stopSync();
  } catch (e) {
    failures++;
    console.error('✗ 用例异常：', e && e.stack || e);
  } finally {
    try { await browser.close(); } catch {}
    stopAll();
  }
  console.log(`\n总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})();
