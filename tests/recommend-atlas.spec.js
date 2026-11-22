// 推荐 Atlas：公开官网分发、作者入口、失败兜底及真实可见的布局/交互。
// 剪贴板用桩，不改用户系统剪贴板；外站导航拦截，不依赖网络，不触碰真实配置。
'use strict';
const assert = require('assert');
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');
let total = 0;
function check(name, value, expected = true) { assert.deepStrictEqual(value, expected, name); total++; console.log(`✓ ${name}`); }
function fakeBridge() {
  window.atlasDesktop = {
    isDesktop: true, platform: 'darwin', titlebarInset: 90,
    onMenuCommand: () => () => {}, onWindowState: () => () => {}, onOpenPath: () => () => {},
    takePendingOpen: async () => null, setTheme: () => {}, setChromeState: () => {},
    appVersion: async () => '0.33.0',
  };
}
function mockClipboard() {
  window.__copied = [];
  window.__clipboardMode = 'ok';
  window.__mockClipboard = {
    writeText: async text => {
      if (__clipboardMode === 'reject') throw new Error('测试：复制被禁止');
      if (__clipboardMode === 'pending') await new Promise(resolve => { window.__releaseCopy = resolve; });
      __copied.push(text);
    },
  };
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: __mockClipboard });
}
(async () => {
  const atlas = await startAtlas({ prefix: 'atlas-recommend-', config: { trustAllHtml: true }, files: {
    'private/report.html': '<h1>绝不能进入推荐文案的私人报告</h1>',
    'private/note.md': '# 私人笔记\n\n正文。',
  } });
  const browser = await chromium.launch();
  try {
    for (const config of [
      { name: '浏览器浅色', width: 1440, theme: 'light' },
      { name: '浏览器深色', width: 1440, theme: 'dark' },
      { name: '窄窗口', width: 780, theme: 'light' },
      { name: '手机宽度', width: 375, theme: 'dark' },
      { name: '桌面外壳', width: 1440, theme: 'light', desktop: true },
    ]) {
      const context = await browser.newContext({ viewport: { width: config.width, height: 950 }, reducedMotion: 'no-preference' });
      await context.addInitScript(mockClipboard);
      if (config.desktop) await context.addInitScript(fakeBridge);
      // 点外链仍验证真实 popup 导航，但内容本地拦截，不连接官网。
      await context.route('https://**', route => route.fulfill({ contentType: 'text/html', body: '<title>外链测试</title>' }));
      const page = await context.newPage();
      const errors = [], sharePosts = [], externalRequests = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('request', r => {
        if (r.method() === 'POST' && new URL(r.url()).pathname.startsWith('/api/share')) sharePosts.push(r.url());
        if (!r.url().startsWith(atlas.base)) externalRequests.push(r.url());
      });
      try {
        await page.goto(atlas.base); await page.waitForSelector('#tree .file');
        await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), config.theme);
        await page.waitForTimeout(450);
        if (config.width <= 780) await page.evaluate(() => toggleSidebar(true));
        check(`${config.name}：不自动弹推荐面板`, await page.locator('#recommend-modal').isVisible(), false);
        const homeBtn = page.locator('.home-promo [data-open-recommend]');
        await homeBtn.scrollIntoViewIfNeeded();
        check(`${config.name}：首页卡片在最近打开后、快捷键前`, await page.evaluate(() => {
          const card = document.querySelector('.home-promo');
          return card.previousElementSibling.classList.contains('home-rails') && card.nextElementSibling.classList.contains('home-tips');
        }));
        check(`${config.name}：两个官网入口指向正确公共域名`, await page.locator('.home-promo [data-atlas-site]').evaluateAll(links => links.map(a => [a.href, a.target, a.rel])), [
          ['https://atlas.unmadebox.com/', '_blank', 'noopener noreferrer'], ['https://unmadebox.com/', '_blank', 'noopener noreferrer'],
        ]);
        await page.evaluate(() => {
          window.__OriginalQR = QRCode;
          window.QRCode = function(container, options) { window.__recommendQROptions = options; window.__recommendQRCode = new __OriginalQR(container, options); return __recommendQRCode; };
          QRCode.CorrectLevel = __OriginalQR.CorrectLevel;
        });
        await homeBtn.click(); await page.waitForSelector('#recommend-modal:not(.hidden)');
        await page.waitForFunction(() => document.activeElement?.dataset.recommendCopy === 'link');
        check(`${config.name}：正常打开不显示失败备用文本框`, await page.locator('#recommend-manual').isVisible(), false);
        check(`${config.name}：聚焦复制链接且有弹窗语义`, await page.locator('#recommend-modal .modal-panel').evaluate(panel => panel.getAttribute('role') === 'dialog' && panel.getAttribute('aria-modal') === 'true'));
        check(`${config.name}：二维码真实生成且只编码官网`, await page.evaluate(() => __recommendQROptions.text === 'https://atlas.unmadebox.com/' && document.querySelector('#recommend-qr canvas').width === 144));
        check(`${config.name}：二维码有至少四个码元的白色静区`, await page.evaluate(() => parseFloat(getComputedStyle(document.getElementById('recommend-qr')).paddingLeft) >= 4 * 144 / __recommendQRCode._oQRCode.getModuleCount()));
        check(`${config.name}：原文档分享没有被启动`, sharePosts, []);
        check(`${config.name}：打开面板没有外网后台请求`, externalRequests, []);
        check(`${config.name}：面板/控件可见可点击且不溢出`, await page.evaluate(() => {
          const panel = document.querySelector('.recommend-panel'), r = panel.getBoundingClientRect();
          return r.x >= 15 && r.right <= innerWidth - 15 && panel.scrollWidth <= panel.clientWidth + 1 &&
            [...panel.querySelectorAll('button, a, #recommend-url')].every(el => {
              const b = el.getBoundingClientRect(), hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
              return b.width > 0 && b.height > 0 && hit && el.contains(hit);
            });
        }));
        if (config.name !== '窄窗口') await page.screenshot({ path: `/tmp/atlas-recommend-${config.desktop ? 'desktop' : config.width + '-' + config.theme}.png` });
        const linkBtn = page.locator('[data-recommend-copy="link"]'), textBtn = page.locator('[data-recommend-copy="text"]');
        const before = await linkBtn.boundingBox();
        await linkBtn.click(); await page.waitForSelector('[data-recommend-copy="link"][data-copied="true"]');
        const after = await linkBtn.boundingBox();
        check(`${config.name}：复制成功按钮不横跳`, after, before);
        check(`${config.name}：复制链接是官网而非本机地址`, await page.evaluate(() => __copied[0]), 'https://atlas.unmadebox.com/');
        await textBtn.click(); await page.waitForSelector('[data-recommend-copy="text"][data-copied="true"]');
        const text = await page.evaluate(() => __copied[1]);
        check(`${config.name}：推荐文案包含产品与作者网站、不带私人路径`, text.includes('https://atlas.unmadebox.com/') && text.includes('https://unmadebox.com/') && !text.includes(atlas.scanDir) && !text.includes('localhost') && !text.includes('私人报告'));
        await linkBtn.click(); await page.waitForTimeout(1750);
        check(`${config.name}：连续复制后按钮正确复位`, await linkBtn.locator('[data-copy-label]').textContent(), '复制链接');
        await page.evaluate(() => { __clipboardMode = 'reject'; });
        await textBtn.click(); await page.waitForSelector('#recommend-manual:not(.hidden)');
        check(`${config.name}：失败不假报成功且提供可选中文案`, await page.evaluate(() => document.getElementById('recommend-feedback').dataset.error === 'true' && document.activeElement.id === 'recommend-manual-text' && document.activeElement.value.includes('https://unmadebox.com/') && !document.querySelector('[data-copied="true"]')));
        // 焦点陷阱：最后一个链接 Tab 回关闭按钮，Shift+Tab 又回最后一个。
        await page.locator('.recommend-creator a').focus(); await page.keyboard.press('Tab');
        check(`${config.name}：Tab 不跑到弹窗后方`, await page.evaluate(() => document.activeElement.matches('#recommend-modal .modal-close')));
        await page.keyboard.press('Shift+Tab');
        check(`${config.name}：Shift+Tab 能反向循环`, await page.evaluate(() => document.activeElement.matches('.recommend-creator a')));
        await page.keyboard.press('Escape');
        check(`${config.name}：Esc 关闭且焦点归还入口`, await homeBtn.evaluate(btn => document.activeElement === btn));
        await homeBtn.click();
        await page.waitForFunction(() => document.activeElement?.dataset.recommendCopy === 'link');
        check(`${config.name}：重开清除失败和手动文本状态`, await page.evaluate(() => document.getElementById('recommend-feedback').textContent === '' && document.getElementById('recommend-manual').offsetParent === null));
        await page.evaluate(() => { __clipboardMode = 'pending'; });
        await linkBtn.click(); await page.waitForFunction(() => !!window.__releaseCopy);
        await page.locator('#recommend-modal .modal-close svg').click(); await homeBtn.click();
        await page.evaluate(() => __releaseCopy()); await page.waitForTimeout(60);
        check(`${config.name}：关闭重开不受旧复制请求污染`, await page.evaluate(() => !document.querySelector('[data-copied="true"]') && !document.querySelector('[data-recommend-copy]:disabled') && document.getElementById('recommend-feedback').textContent === ''));
        await page.locator('#recommend-modal .modal-backdrop').click({ position: { x: 5, y: 5 } });
        check(`${config.name}：点击遮罩可关闭`, await page.locator('#recommend-modal').isVisible(), false);
        if (config.width > 780) {
          const sidebarBtn = page.locator('.sidebar-discover [data-open-recommend]');
          await sidebarBtn.click(); await page.waitForSelector('#recommend-modal:not(.hidden)');
          check(`${config.name}：读文档前侧栏常驻入口可打开`, await page.locator('#recommend-title').textContent(), '推荐 Atlas');
          await page.keyboard.press('Escape');
          // 用实际链接点击验证新窗口 URL，不依赖静态 href 断言。
          const popupPromise = page.waitForEvent('popup');
          await page.locator('.sidebar-discover a').click();
          const popup = await popupPromise; await popup.waitForLoadState();
          check(`${config.name}：作者链接在独立窗口打开，不替换看板`, popup.url(), 'https://unmadebox.com/');
          await popup.close();
          check(`${config.name}：看板 URL 保持本地`, page.url().startsWith(atlas.base));
        }
        if (config.name === '浏览器浅色') {
          await page.evaluate(() => {
            __clipboardMode = 'ok'; window.QRCode = undefined; delete document.getElementById('recommend-qr').dataset.ready;
          });
          await homeBtn.click();
          check('二维码库缺失仍能打开与复制', await page.locator('#recommend-qr').textContent(), '二维码暂不可用，请复制官网链接。');
          await linkBtn.click(); await page.waitForSelector('[data-copied="true"]'); await page.keyboard.press('Escape');
          await page.evaluate(() => { window.QRCode = __OriginalQR; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }); });
          await homeBtn.click(); await linkBtn.click(); await page.waitForSelector('#recommend-manual:not(.hidden)');
          check('剪贴板 API 缺失时有可手动复制的官网', await page.locator('#recommend-manual-text').inputValue(), 'https://atlas.unmadebox.com/');
          await page.keyboard.press('Escape');
          await page.locator('#tree .file[data-path$="report.html"] .file-name').click();
          await page.waitForFunction(() => !!state.activeTabId);
          await page.locator('.sidebar-discover [data-open-recommend]').click();
          check('正文打开后仍能推荐，且不切换文档', await page.locator('#recommend-modal').isVisible());
          await page.keyboard.press('Escape');
          await page.locator('#btn-share').click(); await page.waitForSelector('#share-modal:not(.hidden)');
          check('原局域网文档分享功能保持独立', await page.locator('#share-modal h2').textContent(), '分享到局域网');
          check('推荐面板没有替换文档分享', await page.locator('#recommend-modal').isVisible(), false);
          await page.keyboard.press('Escape');
        }
        check(`${config.name}：无未捕获异常`, errors, []);
      } finally { await context.close(); }
    }
    console.log(`\n通过 ${total} 项，失败 0 项。`);
  } finally { await browser.close(); await atlas.stop(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
