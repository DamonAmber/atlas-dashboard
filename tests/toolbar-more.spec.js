// 顶栏更多菜单：必须真实可见、能命中，不能仅断言 aria-expanded 或 display。
// 浏览器与桌面 CSS 两种外壳共用隔离实例，不接触用户看板。
'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');
let total = 0;
function check(name, actual, expected = true) {
  assert.deepStrictEqual(actual, expected, name); total++; console.log(`✓ ${name}`);
}
function fakeBridge() {
  window.atlasDesktop = {
    isDesktop: true, platform: 'darwin', titlebarInset: 90,
    exportPdf: async () => ({ ok: false, error: 'test' }),
    onMenuCommand: () => () => {}, onWindowState: () => () => {},
    onOpenPath: () => () => {}, takePendingOpen: async () => null,
    appVersion: async () => null, setTheme: () => {}, setChromeState: () => {},
    updates: { getState: async () => ({ state: 'idle' }), onStatus: () => () => {} },
  };
}
async function menuIsHittable(page) {
  return page.evaluate(() => [...document.querySelectorAll('#tb-more-menu button')].every(item => {
    const r = item.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return r.width > 0 && r.height > 0 && hit && item.contains(hit);
  }));
}
(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-toolbar-more-', files: {
    'proj/readme.md': '# 菜单测试\n\nMarkdown 正文。',
    'proj/report.html': '<!doctype html><html><body><h1>HTML 菜单测试</h1></body></html>',
  } });
  const browser = await chromium.launch();
  try {
    for (const mode of ['browser', 'desktop']) {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
      if (mode === 'desktop') await context.addInitScript(fakeBridge);
      const page = await context.newPage();
      const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
      await page.goto(atlas.base); await page.waitForSelector('#tree .file');
      // 隔离实例在前一模式记录过 recent，明确回首页检查入口状态。
      await page.locator('#btn-home').click();
      check(`${mode} 首页不显示更多入口`, await page.locator('#btn-more').isVisible(), false);
      for (const file of ['readme.md', 'report.html']) {
        await page.locator(`#tree .file[data-path$="${file}"] .file-name`).click();
        await page.waitForSelector('#btn-more:not(:disabled)');
        await page.waitForFunction(() => !document.querySelector('#preview')?.classList.contains('loading'));
        for (const theme of ['light', 'dark']) {
          await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
          await page.locator('#btn-more').click();
          check(`${mode} ${file} ${theme} 点击展开`, await page.locator('#btn-more').getAttribute('aria-expanded'), 'true');
          check(`${mode} ${file} ${theme} 四个菜单项位于最上层且可点`, await menuIsHittable(page));
          await page.locator('#btn-more').click();
          check(`${mode} ${file} ${theme} 再点收起`, await page.locator('#btn-more').getAttribute('aria-expanded'), 'false');
        }
        await page.locator('#btn-more').focus(); await page.keyboard.press('Enter');
        check(`${mode} ${file} 键盘可展开且命中`, await menuIsHittable(page));
        const tabs = await page.locator('#tab-bar .tab').count();
        await page.keyboard.press('Escape');
        check(`${mode} ${file} Esc 只关菜单`, await page.locator('#btn-more').getAttribute('aria-expanded'), 'false');
        check(`${mode} ${file} Esc 不关闭文档`, await page.locator('#tab-bar .tab').count(), tabs);
        await page.locator('#btn-more').click();
        await page.locator('#tab-bar .tab.active').click();
        check(`${mode} ${file} 点击菜单外收起`, await page.locator('#btn-more').getAttribute('aria-expanded'), 'false');
        await page.locator('#btn-more').click();
        // 真正的坐标点击执行菜单项，验证不是只改变样式。
        await page.locator('#btn-focus-menu').click({ timeout: 3000 });
        check(`${mode} ${file} 菜单项可进入专注阅读`, await page.evaluate(() => document.documentElement.classList.contains('focus-mode')));
        check(`${mode} ${file} 执行动作后菜单收起`, await page.locator('#btn-more').getAttribute('aria-expanded'), 'false');
        await page.locator('#focus-exit').click();
      }
      check(`${mode} 多 Tab 菜单仍正常`, await page.locator('#tab-bar .tab').count(), 2);
      await page.locator('#btn-more').click();
      check(`${mode} 多 Tab 菜单命中正确`, await menuIsHittable(page));
      await page.locator('#btn-home').click();
      check(`${mode} 回首页关闭菜单`, await page.locator('#btn-more').getAttribute('aria-expanded'), 'false');
      check(`${mode} 无脚本异常`, pageErrors, []);
      await context.close();
    }
    console.log(`\n通过 ${total} 项，失败 0 项。`);
  } finally { await browser.close(); await atlas.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
