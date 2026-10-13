// 动效基建：reduced-motion、「AI 刚改过」轻闪、View Transitions 降级、SSE self 字段
//
// 覆盖：
//   1. 系统 reduced-motion（emulateMedia）下，经 fixture 写文件触发一次 SSE change 后，
//      document.getAnimations() 里没有 running 的无限循环动画；.just-changed 行仍在，
//      点是满亮度静态（信息保留、只去掉运动）
//   2. localStorage atlas:motion=reduce + 正常媒体偏好：防闪脚本写 html[data-motion]，同样静止
//   3. 对照：正常偏好下 .just-changed 的点确实在做 atlas-twinkle（3 次，非无限）
//   4. window.__atlasForceVT=true 时切 Tab：过渡期间 html[data-vt] 出现、结束后移除、DOM 变更最终生效；
//      webdriver 默认（不强制）下 data-vt 从不出现，切换同步完成
//   5. SSE fs 负载带 self / selfReason：外部改动 self=false；/api/save-md 保存 self=true；
//      /api/rename 的新路径 selfReason='rename'，且自写不会挂上 .just-changed
//   6. 星图：reduce 下进入星图并触发一次 SSE 后，AtlasStarmap.debug.frames 2 秒内不增长
//      （动画层循环不跑、主画布静止时 0 帧）；对照：正常偏好下刚变更的星在轻闪，帧数增长
const fs = require('fs');
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');

let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}

const OLD = Date.now() - 3 * 86_400_000;   // 预置文档 mtime 拉到 3 天前，全部"已读的旧文档"
function files() {
  return {
    'proj/alpha.md': '# Alpha\n\n第一篇\n',
    'proj/bravo.md': '# Bravo\n\n第二篇\n',
    'proj/charlie.md': '# Charlie\n\n第三篇\n',
    'proj/delta.md': '# Delta\n\n第四篇\n',
    'proj/echo.html': '<!doctype html><html><body><h1>Echo</h1></body></html>',
  };
}

// 页面里：无限循环且仍在跑的动画（持续动画必须在 reduce 下停止）
function infiniteRunning() {
  return document.getAnimations()
    .filter(a => a.playState === 'running' && a.effect && a.effect.getTiming().iterations === Infinity)
    .map(a => (a.animationName || a.id || 'anon') + ' @ ' + ((a.effect.target && a.effect.target.className) || ''));
}
// 页面里：某路径侧栏行的未读点状态
function dotState(p) {
  const row = document.querySelector(`#tree .file[data-path="${CSS.escape(p)}"]`);
  if (!row) return null;
  const dot = row.querySelector('.unread-dot');
  const cs = getComputedStyle(dot);
  const anims = dot.getAnimations().map(a => ({
    name: a.animationName, state: a.playState, iterations: a.effect.getTiming().iterations,
  }));
  return {
    justChanged: row.classList.contains('just-changed'),
    unread: row.classList.contains('unread'),
    opacity: cs.opacity,
    visibility: cs.visibility,
    animationName: cs.animationName,
    anims,
  };
}

async function touch(atlas, rel, text) {
  fs.writeFileSync(atlas.filePath(rel), text);
}

async function waitJustChanged(page, p, timeout = 10000) {
  await page.waitForFunction((pp) => {
    const row = document.querySelector(`#tree .file[data-path="${CSS.escape(pp)}"]`);
    // 等到整树按新数据重建（新鲜未读：unread 且不再是 stale），首页也随之重渲染
    return !!(row && row.classList.contains('just-changed') && row.classList.contains('unread')
      && !row.classList.contains('stale'));
  }, p, { timeout });
}

(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-motion-spec-', files: files() });
  for (const rel of Object.keys(files())) {
    const p = atlas.filePath(rel);
    fs.utimesSync(p, OLD / 1000, OLD / 1000);
  }
  // utimes 本身也会让 watcher 报一次 change（并清掉已读）：等它们落定后再全部标成已读，
  // 未读点只在被改动的那篇上出现，断言才干净
  await new Promise(r => setTimeout(r, 1500));
  const seenRes = await fetch(atlas.base + '/api/seen/all', { method: 'POST' }).then(r => r.status).catch(() => 0);
  check('预置：全部标为已读', seenRes, 200);
  const browser = await chromium.launch();

  // ---------- 1. 系统 reduced-motion ----------
  {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    const p = atlas.filePath('proj/alpha.md');
    await page.waitForTimeout(300);
    await touch(atlas, 'proj/alpha.md', '# Alpha\n\n改动 1\n');
    await waitJustChanged(page, p);
    await page.waitForTimeout(500);   // 等首页重渲染完、封面墙出现
    check('系统 reduce：prefersReducedMotion() 为真',
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    check('系统 reduce：时长令牌 --dur-med 归零',
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-med').trim()), '0ms');
    check('系统 reduce：--stagger 归零',
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--stagger').trim()), '0ms');
    check('系统 reduce：没有 running 的无限循环动画', await page.evaluate(infiniteRunning), []);
    const d = await page.evaluate(dotState, p);
    check('系统 reduce：.just-changed 行仍存在', d && d.justChanged, true);
    check('系统 reduce：刚变更的点满亮度', d && d.opacity, '1');
    check('系统 reduce：刚变更的点可见', d && d.visibility, 'visible');
    check('系统 reduce：刚变更的点没有动画', d && d.animationName, 'none');
    const cover = await page.evaluate((pp) => {
      const c = document.querySelector(`.cover-card[data-path="${CSS.escape(pp)}"]`);
      if (!c) return null;
      const dot = c.querySelector('.cover-fresh');
      return { jc: c.classList.contains('just-changed'), dot: !!dot, anim: dot ? getComputedStyle(dot).animationName : null };
    }, p);
    check('系统 reduce：首页封面同源带 .just-changed', cover && cover.jc, true);
    check('系统 reduce：封面上的新鲜点静止', cover && cover.anim, 'none');
    await ctx.close();
  }

  // ---------- 2. 应用内开关 atlas:motion=reduce + 正常媒体偏好 ----------
  {
    const ctx = await browser.newContext({ reducedMotion: 'no-preference' });
    await ctx.addInitScript(() => { try { localStorage.setItem('atlas:motion', 'reduce'); } catch {} });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    check('应用内 reduce：防闪脚本写了 html[data-motion="reduce"]',
      await page.evaluate(() => document.documentElement.getAttribute('data-motion')), 'reduce');
    check('应用内 reduce：系统偏好确实是 no-preference',
      await page.evaluate(() => matchMedia('(prefers-reduced-motion: no-preference)').matches), true);
    check('应用内 reduce：设置里「减少」被选中',
      await page.evaluate(() => document.querySelector('[data-motion-pick="reduce"]').getAttribute('aria-checked')), 'true');
    check('应用内 reduce：--dur-twinkle 归零',
      await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--dur-twinkle').trim()), '0ms');
    const p = atlas.filePath('proj/bravo.md');
    await page.waitForTimeout(300);
    await touch(atlas, 'proj/bravo.md', '# Bravo\n\n改动 1\n');
    await waitJustChanged(page, p);
    await page.waitForTimeout(500);
    check('应用内 reduce：没有 running 的无限循环动画', await page.evaluate(infiniteRunning), []);
    const d = await page.evaluate(dotState, p);
    check('应用内 reduce：.just-changed 行仍存在', d && d.justChanged, true);
    check('应用内 reduce：刚变更的点满亮度', d && d.opacity, '1');
    check('应用内 reduce：刚变更的点没有动画', d && d.animationName, 'none');

    // 切回「跟随系统」：属性与存储都撤掉
    await page.evaluate(() => document.querySelector('[data-motion-pick="system"]').click());
    check('切回跟随系统：data-motion 移除',
      await page.evaluate(() => document.documentElement.hasAttribute('data-motion')), false);
    check('切回跟随系统：localStorage atlas:motion 移除',
      await page.evaluate(() => localStorage.getItem('atlas:motion')), null);
    await ctx.close();
  }

  // ---------- 3. 对照：正常偏好下点在轻闪 ----------
  {
    const ctx = await browser.newContext({ reducedMotion: 'no-preference' });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    const p = atlas.filePath('proj/charlie.md');
    await page.waitForTimeout(300);
    await touch(atlas, 'proj/charlie.md', '# Charlie\n\n改动 1\n');
    await waitJustChanged(page, p);
    const d = await page.evaluate(dotState, p);
    const tw = (d && d.anims || []).find(a => a.name === 'atlas-twinkle');
    check('正常偏好：刚变更的点在做 atlas-twinkle', !!tw, true);
    check('正常偏好：轻闪重复 3 次（不是无限循环）', tw && tw.iterations, 3);
    await ctx.close();
  }

  // ---------- 4. View Transitions ----------
  async function tabSwitchRun(force) {
    const ctx = await browser.newContext({ reducedMotion: 'no-preference' });
    if (force) await ctx.addInitScript(() => { window.__atlasForceVT = true; });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    const a = atlas.filePath('proj/alpha.md'), b = atlas.filePath('proj/delta.md');
    await page.click(`#tree .file[data-path="${a}"]`);
    await page.waitForTimeout(500);
    await page.click(`#tree .file[data-path="${b}"]`);
    await page.waitForSelector('#tab-bar .tab:nth-child(2).active');
    await page.waitForTimeout(800);   // 让上一次过渡彻底结束，且远离 150ms 防抖窗口
    // 记录 html[data-vt] / [data-vt-dir] 的每次取值
    await page.evaluate(() => {
      window.__vtSeen = [];
      new MutationObserver(() => {
        const r = document.documentElement;
        window.__vtSeen.push((r.getAttribute('data-vt') || '') + '|' + (r.getAttribute('data-vt-dir') || ''));
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-vt', 'data-vt-dir'] });
    });
    // 点第一个标签（在当前标签左边 → 方向 back）
    const syncResult = await page.evaluate(() => {
      document.querySelector('#tab-bar .tab:nth-child(1)').click();
      return {
        vtNow: document.documentElement.getAttribute('data-vt'),
        activeName: (document.querySelector('#tab-bar .tab.active .tab-name') || {}).textContent || null,
      };
    });
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({
      seen: window.__vtSeen,
      vt: document.documentElement.getAttribute('data-vt'),
      vtDir: document.documentElement.getAttribute('data-vt-dir'),
      activeName: (document.querySelector('#tab-bar .tab.active .tab-name') || {}).textContent || null,
      previewSrc: (document.getElementById('preview') || {}).getAttribute ? document.getElementById('preview').getAttribute('src') : null,
      visibleFrames: [...document.querySelectorAll('.preview-frame')].filter(f => !f.classList.contains('hidden')).length,
    }));
    await ctx.close();
    return { syncResult, after };
  }
  {
    const webdriver = await (async () => {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const w = await page.evaluate(() => navigator.webdriver);
      await ctx.close();
      return w;
    })();
    check('前提：Playwright 的 Chromium 里 navigator.webdriver === true', webdriver, true);

    const forced = await tabSwitchRun(true);
    check('__atlasForceVT：切 Tab 时 html[data-vt="tab"] 出现过',
      forced.after.seen.some(s => s.startsWith('tab|')), true);
    check('__atlasForceVT：方向为 back（新标签在左边）',
      forced.after.seen.some(s => s === 'tab|back'), true);
    check('__atlasForceVT：过渡结束后 data-vt 被移除', forced.after.vt, null);
    check('__atlasForceVT：过渡结束后 data-vt-dir 被移除', forced.after.vtDir, null);
    check('__atlasForceVT：DOM 变更最终生效（活动标签是 alpha）', /alpha/i.test(forced.after.activeName || ''), true);
    check('__atlasForceVT：最终只有一个可见的预览帧', forced.after.visibleFrames, 1);
    check('__atlasForceVT：#preview 指向 alpha', /alpha/.test(forced.after.previewSrc || ''), true);

    const plain = await tabSwitchRun(false);
    check('webdriver 默认：data-vt 从不出现', plain.after.seen, []);
    check('webdriver 默认：切换同步完成（click 返回时活动标签已是 alpha）',
      /alpha/i.test(plain.syncResult.activeName || ''), true);
  }

  // ---------- 5. SSE self / selfReason ----------
  {
    const ctx = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    await page.evaluate(() => {
      window.__fsEvents = [];
      const es = new EventSource('/api/events');
      es.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.channel === 'fs') window.__fsEvents.push(d); } catch {} };
      window.__es = es;
    });
    await page.waitForTimeout(500);
    const waitEvent = (pred, timeout = 8000) => page.waitForFunction(pred, null, { timeout }).catch(() => null);

    // 外部改动
    const ext = atlas.filePath('proj/echo.html');
    await touch(atlas, 'proj/echo.html', '<!doctype html><html><body><h1>Echo 2</h1></body></html>');
    await waitEvent(`window.__fsEvents.some(e => e.path === ${JSON.stringify(ext)} && e.kind !== 'unlink')`);
    const extEv = await page.evaluate((pp) => window.__fsEvents.filter(e => e.path === pp && e.kind !== 'unlink').pop() || null, ext);
    check('外部改动：负载带 self 字段且为 false', extEv && extEv.self, false);
    check('外部改动：selfReason 为 null', extEv ? extEv.selfReason : 'missing', null);

    // Atlas 自己保存
    const saved = atlas.filePath('proj/delta.md');
    const saveRes = await page.evaluate(async (pp) => {
      const r = await fetch('/api/save-md', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: pp, content: '# Delta\n\n在 Atlas 里保存\n' }),
      });
      return r.status;
    }, saved);
    check('/api/save-md 保存成功', saveRes, 200);
    await waitEvent(`window.__fsEvents.some(e => e.path === ${JSON.stringify(saved)} && e.kind !== 'unlink')`);
    const saveEv = await page.evaluate((pp) => window.__fsEvents.filter(e => e.path === pp && e.kind !== 'unlink').pop() || null, saved);
    check('/api/save-md：事件 self === true', saveEv && saveEv.self, true);
    check('/api/save-md：selfReason === "save"', saveEv && saveEv.selfReason, 'save');
    await page.waitForTimeout(700);
    check('/api/save-md：自写不挂 .just-changed',
      await page.evaluate((pp) => !!document.querySelector(`.file.just-changed[data-path="${CSS.escape(pp)}"]`), saved), false);

    // 重命名
    const from = atlas.filePath('proj/bravo.md');
    const to = atlas.filePath('proj/bravo-renamed.md');
    const renRes = await page.evaluate(async (pp) => {
      const r = await fetch('/api/rename', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: pp, name: 'bravo-renamed.md' }),
      });
      return r.status;
    }, from);
    check('/api/rename 成功', renRes, 200);
    await waitEvent(`window.__fsEvents.some(e => e.path === ${JSON.stringify(to)} && e.kind !== 'unlink')`);
    const renEv = await page.evaluate((pp) => window.__fsEvents.filter(e => e.path === pp && e.kind !== 'unlink').pop() || null, to);
    check('/api/rename：新路径事件 self === true', renEv && renEv.self, true);
    check('/api/rename：新路径事件 selfReason === "rename"', renEv && renEv.selfReason, 'rename');
    await page.waitForTimeout(700);
    check('/api/rename：新路径不挂 .just-changed',
      await page.evaluate((pp) => !!document.querySelector(`.file.just-changed[data-path="${CSS.escape(pp)}"]`), to), false);
    await page.evaluate(() => window.__es && window.__es.close());
    await ctx.close();
  }

  // ---------- 6. 星图 rAF 帧计数 ----------
  const starmapRun = async (reducedMotion, rel, text) => {
    const ctx = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(atlas.base, { waitUntil: 'load' });
    await page.waitForSelector('#tree .file');
    await page.evaluate(() => selectView('map'));
    await page.waitForTimeout(500);
    const p = atlas.filePath(rel);
    await touch(atlas, rel, text);
    await waitJustChanged(page, p);
    await page.waitForTimeout(600);   // fetchState 落定、星图拿到 justChanged
    const f0 = await page.evaluate(() => AtlasStarmap.debug.frames);
    await page.waitForTimeout(2000);
    const f1 = await page.evaluate(() => AtlasStarmap.debug.frames);
    const twinkling = await page.evaluate(() => AtlasStarmap.debug.twinkling);
    const visible = await page.evaluate(() => starmapVisible());
    await ctx.close();
    return { f0, f1, twinkling, visible };
  };
  {
    const r = await starmapRun('reduce', 'proj/charlie.md', '# Charlie\n\n改动 1\n');
    check('星图 reduce：星图可见', r.visible, true);
    check('星图 reduce：SSE 之后 2 秒内 debug.frames 不增长', r.f1 - r.f0, 0);
    const c = await starmapRun('no-preference', 'proj/alpha.md', '# Alpha\n\n改动 3\n');
    check('星图对照（正常偏好）：刚变更的星在轻闪，帧数增长', c.f1 > c.f0, true);
  }

  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
