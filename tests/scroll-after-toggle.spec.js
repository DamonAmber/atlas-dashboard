// 复现：HTML 滚到中间 → 关闭 sidebar → 无法滚动
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // 找一个长 HTML
  const candidates = await page.evaluate(async () => {
    const r = await fetch('/api/state');
    const d = await r.json();
    return Object.values(d.files).map(f => ({ path: f.path, name: f.name, url: f.url }));
  });
  console.log('候选文件:');
  candidates.slice(0, 10).forEach(c => console.log('  -', c.name));

  // 找最长的（按文件大小近似），优先 dashboard_data_report.html
  const candPath = candidates.find(c => /dashboard_data_report\.html$/i.test(c.name))
    || candidates.find(c => /dashboard.*\.html$/i.test(c.name))
    || candidates[0];
  console.log('选择文件:', candPath.name);
  await page.evaluate((p) => {
    const el = [...document.querySelectorAll('.file')].find(f => f.dataset.path === p);
    if (el) el.click();
  }, candPath.path);
  // 等 iframe load 事件
  // 等 iframe load 事件 + HTML body 渲染稳定
  await page.evaluate(() => new Promise((res) => {
    const ifr = document.getElementById('preview');
    let lastH = 0, sameCount = 0;
    const onLoad = () => {
      // 等 body 高度稳定（可能有图片/字体异步加载）
      const tick = () => {
        const h = ifr.contentDocument && ifr.contentDocument.body
          ? ifr.contentDocument.body.scrollHeight : 0;
        if (h === lastH) sameCount++; else { sameCount = 0; lastH = h; }
        if (sameCount >= 3 && h > 100) return res();
        setTimeout(tick, 200);
      };
      setTimeout(tick, 200);
    };
    if (ifr.contentDocument && ifr.contentDocument.readyState === 'complete') onLoad();
    else ifr.addEventListener('load', onLoad, { once: true });
    setTimeout(res, 8000);
  }));
  // 调试
  const dbg = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    return {
      src: ifr.src,
      hasCD: !!ifr.contentDocument,
      ready: ifr.contentDocument && ifr.contentDocument.readyState,
    };
  });
  console.log('iframe dbg:', dbg);

  // 0. 初始：分清各种 height
  const initial = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    if (!ifr.contentDocument) return { error: 'cross-origin' };
    const doc = ifr.contentDocument.documentElement;
    const body = ifr.contentDocument.body;
    return {
      iframeBoxH: ifr.getBoundingClientRect().height,
      docViewH: doc.clientHeight,           // iframe 视口
      docTotalH: doc.scrollHeight,          // 内容总高
      bodyH: body ? body.clientHeight : 0,
      maxScroll: doc.scrollHeight - doc.clientHeight,
      htmlOverflow: getComputedStyle(doc).overflow,
      bodyOverflow: body ? getComputedStyle(body).overflow : '',
    };
  });
  console.log('\n[0] 初始 iframe:', initial);

  if (initial.error) { console.error('iframe 不可访问，停止'); process.exit(1); }
  if (initial.maxScroll < 100) {
    console.log('!! HTML 不够长，没法测试');
    await browser.close();
    process.exit(0);
  }

  // 1. 滚到中间
  const midScroll = Math.floor(initial.maxScroll / 2);
  await page.evaluate((y) => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    doc.documentElement.scrollTop = y;
    if (doc.body) doc.body.scrollTop = y;
  }, midScroll);
  await page.waitForTimeout(100);

  const beforeToggle = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    return {
      scrollTop: Math.max(doc.documentElement.scrollTop, doc.body.scrollTop),
      scrollHeight: doc.documentElement.scrollHeight,
      clientHeight: doc.documentElement.clientHeight,
      iframeW: ifr.getBoundingClientRect().width,
      iframeInlineW: ifr.style.width,
    };
  });
  console.log('[1] 滚到中间(', midScroll, '):', beforeToggle);

  // 2. 关闭 sidebar，立刻读状态（动画进行中）
  await page.locator('#btn-toggle-sidebar').click();
  await page.waitForTimeout(80);
  const duringAnim = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    return {
      scrollTop: Math.max(doc.documentElement.scrollTop, doc.body.scrollTop),
      scrollHeight: doc.documentElement.scrollHeight,
      iframeW: ifr.getBoundingClientRect().width,
      iframeInlineW: ifr.style.width,
      pe: getComputedStyle(ifr).pointerEvents,
      bodyClasses: [...document.body.classList],
    };
  });
  console.log('[2] 关闭 80ms（动画中）:', duringAnim);

  // 3. 等动画结束
  await page.waitForTimeout(400);
  const afterAnim = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    return {
      scrollTop: Math.max(doc.documentElement.scrollTop, doc.body.scrollTop),
      scrollHeight: doc.documentElement.scrollHeight,
      clientHeight: doc.documentElement.clientHeight,
      iframeW: ifr.getBoundingClientRect().width,
      iframeInlineW: ifr.style.width,
      pe: getComputedStyle(ifr).pointerEvents,
      bodyClasses: [...document.body.classList],
    };
  });
  console.log('[3] 关闭后(400ms):', afterAnim);

  // 4. 尝试再滚动
  const tryScroll = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    const before = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
    doc.documentElement.scrollTop = before + 200;
    doc.body.scrollTop = before + 200;
    const after = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
    return { before, requested: before + 200, after, delta: after - before };
  });
  console.log('[4] 尝试再向下滚 200:', tryScroll);

  // 5. wheel 事件能否传到 iframe
  await page.locator('.preview').hover();
  const wheelDelta = await page.evaluate(async () => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    const before = Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
    // 通过 page.mouse.wheel 触发滚动
    return { before };
  });

  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(150);
  const afterWheel = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const doc = ifr.contentDocument;
    return Math.max(doc.documentElement.scrollTop, doc.body.scrollTop);
  });
  console.log('[5] page.mouse.wheel(300) 后 scrollTop:', afterWheel, '(之前:', wheelDelta.before, ')');

  // 6. 检查所有可能阻止滚动的因素
  const diag = await page.evaluate(() => {
    const ifr = document.getElementById('preview');
    const ifrCS = getComputedStyle(ifr);
    const previewBox = ifr.parentElement;
    const previewCS = getComputedStyle(previewBox);
    const main = previewBox.parentElement;
    const mainCS = getComputedStyle(main);
    return {
      iframe: {
        width: ifrCS.width,
        height: ifrCS.height,
        pointerEvents: ifrCS.pointerEvents,
        position: ifrCS.position,
        transform: ifrCS.transform,
        overflow: ifrCS.overflow,
        inlineWidth: ifr.style.width,
        inlineMinWidth: ifr.style.minWidth,
      },
      preview: {
        width: previewCS.width,
        overflow: previewCS.overflow,
        position: previewCS.position,
      },
      main: {
        marginLeft: mainCS.marginLeft,
        width: mainCS.width,
        overflow: mainCS.overflow,
      },
    };
  });
  console.log('[6] 完整诊断:', JSON.stringify(diag, null, 2));

  await browser.close();
})();
