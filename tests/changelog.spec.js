// 应用内更新日志 + 新功能引导（0.28.0 新增）
//
// 钉住的行为：
//   ① 升级后首次打开：最新版本有新功能(feature) → 主动弹一次「Atlas 更新了」引导，
//      带使用说明；看过后记 localStorage，重开不再弹
//   ② 纯 bug 修复版本：不主动弹（这是用户明确要求——修复不打扰）
//   ③ 设置里手动入口「更新日志」→ 列出全部历史版本，feature/fix 分类标注
//   ④ 引导弹窗底部「查看完整更新日志」→ 就地切到完整列表
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-changelog-',
    files: { 'proj/a.md': '# A\n\n正文。\n' },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  // 全新安装（无 seen 记录）不该被弹窗打扰——只记版本、不弹
  console.log('\n[全新安装不打扰]');
  await page.waitForTimeout(1200);   // 超过 maybeShowWhatsNew 的 800ms 延迟
  const fresh = await page.evaluate(() => ({
    open: !document.getElementById('changelog-modal').classList.contains('hidden'),
    seen: localStorage.getItem('atlas:changelogSeen'),
    latest: window.ATLAS_CHANGELOG[0].version,
  }));
  check('全新安装不自动弹引导', fresh.open, false);
  check('全新安装静默记下当前版本', fresh.seen, fresh.latest);

  // ① 从旧版升级：seen 是更早版本 + 最新版有 feature → 自动弹引导
  console.log('\n[升级后 · 新功能引导]');
  await page.evaluate(() => localStorage.setItem('atlas:changelogSeen', '0.20.0'));
  await page.reload();
  await page.waitForSelector('.file');
  await page.waitForSelector('#changelog-modal:not(.hidden)', { timeout: 4000 }).catch(() => {});
  const wn = await page.evaluate(() => {
    const m = document.getElementById('changelog-modal');
    return {
      open: m && !m.classList.contains('hidden'),
      title: (document.getElementById('changelog-title') || {}).textContent || '',
      body: (document.getElementById('changelog-body') || {}).innerText || '',
      footVisible: !document.getElementById('changelog-foot').classList.contains('hidden'),
      seen: localStorage.getItem('atlas:changelogSeen'),
      latest: window.ATLAS_CHANGELOG[0].version,
      featTitle: (window.ATLAS_CHANGELOG[0].entries.find(e => e.type === 'feature') || {}).title || '',
    };
  });
  check('自动弹出「更新了」引导', wn.open, true);
  check('标题是引导语气而非「更新日志」', /更新了/.test(wn.title), true);
  check('引导带本版新功能标题', !!wn.featTitle && wn.body.includes(wn.featTitle), true);
  check('引导带「怎么用」使用说明', wn.body.includes('怎么用'), true);
  check('引导底部有「查看完整更新日志」入口', wn.footVisible, true);
  check('已把当前版本记为已看过', wn.seen, wn.latest);

  // ④ 引导底部「查看完整更新日志」→ 就地切到完整列表
  console.log('\n[切到完整日志]');
  await page.click('#changelog-all-btn');
  await page.waitForTimeout(200);
  const full = await page.evaluate(() => ({
    title: (document.getElementById('changelog-title') || {}).textContent || '',
    body: (document.getElementById('changelog-body') || {}).innerText || '',
    footHidden: getComputedStyle(document.getElementById('changelog-foot')).display === 'none',
  }));
  check('标题切回「更新日志」', full.title, '更新日志');
  check('完整日志列出多个版本（含 0.27.0）', full.body.includes('0.27.0'), true);
  check('完整日志同时有「新功能」与「修复」分类标签', /新功能/.test(full.body) && /修复/.test(full.body), true);
  check('完整日志模式隐藏底部入口', full.footHidden, true);
  // 关闭
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc 关闭更新日志', await page.evaluate(() => document.getElementById('changelog-modal').classList.contains('hidden')), true);

  // ① 续：看过后重开不再弹
  console.log('\n[看过后不再弹]');
  await page.reload();
  await page.waitForSelector('.file');
  await page.waitForTimeout(1200);   // 超过 maybeShowWhatsNew 的 800ms 延迟
  check('已看过的版本重开不再自动弹', await page.evaluate(() => document.getElementById('changelog-modal').classList.contains('hidden')), true);

  // ③ 设置里的手动入口（放在注入假数据之前测，读的是真实 changelog）
  console.log('\n[设置里手动打开更新日志]');
  await page.click('#btn-settings');
  await page.waitForSelector('#settings-modal:not(.hidden)');
  await page.waitForTimeout(200);
  await page.click('#settings-changelog-btn');
  await page.waitForSelector('#changelog-modal:not(.hidden)', { timeout: 3000 });
  const manual = await page.evaluate(() => ({
    title: (document.getElementById('changelog-title') || {}).textContent || '',
    body: (document.getElementById('changelog-body') || {}).innerText || '',
  }));
  check('手动入口打开的是完整日志', manual.title, '更新日志');
  check('手动日志含最新版本', manual.body.includes(wn.latest), true);
  await page.keyboard.press('Escape');   // 关掉，避免影响下一个用例的弹窗检测
  await page.waitForTimeout(200);

  // ② 纯 bug 修复版本不主动弹（注入一个全 fix 的假版本验证；放最后，改了 window.ATLAS_CHANGELOG 不污染其它用例）
  console.log('\n[纯修复版本不打扰]');
  const fixOnly = await page.evaluate(() => {
    localStorage.removeItem('atlas:changelogSeen');
    window.ATLAS_CHANGELOG = [{ version: '9.9.9', date: '2099-01-01', entries: [
      { type: 'fix', title: '仅修复一个问题', desc: '不该主动弹。' },
    ] }];
    maybeShowWhatsNew();
    const m = document.getElementById('changelog-modal');
    return { open: m && !m.classList.contains('hidden'), seen: localStorage.getItem('atlas:changelogSeen') };
  });
  check('纯 fix 版本不主动弹引导', fixOnly.open, false);
  check('纯 fix 版本仍推进 seen（不累积到以后补弹）', fixOnly.seen, '9.9.9');

  check('全程无 JS 报错', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
