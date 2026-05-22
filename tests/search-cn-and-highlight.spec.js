// 验证：① 中文单字搜索 ② 打开文件后 iframe 内高亮匹配 + 上下跳转
const { chromium } = require('playwright');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', e => console.error('[pageerror]', e.message));
  await page.goto('http://localhost:4321', { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // ===== ① 中文单字搜索 =====
  console.log('\n[1] 中文单字搜索');

  // 直接调 API
  const cnSingle = await page.evaluate(async () => {
    const r = await fetch('/api/search?q=' + encodeURIComponent('灯'));
    return await r.json();
  });
  check('后端：q=灯 返回结果', cnSingle.matches && cnSingle.matches.length > 0,
    `count=${cnSingle.matches?.length}`);

  // ASCII 单字符仍被拦
  const enSingle = await page.evaluate(async () => {
    const r = await fetch('/api/search?q=a');
    return await r.json();
  });
  check('后端：q=a (ASCII 单字符) 返回 0', enSingle.matches && enSingle.matches.length === 0);

  // 前端：输入 1 个中文字符触发搜索
  await page.fill('#search', '灯');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#tree .file')].filter(el => !el.closest('.folder.collapsed')).length > 0,
    { timeout: 3000 }
  ).catch(() => {});
  const visibleAfterCn = await page.evaluate(() =>
    [...document.querySelectorAll('#tree .file')].filter(el => !el.closest('.folder.collapsed')).length
  );
  check('前端：输入"灯"过滤后还有可见 file', visibleAfterCn > 0, `count=${visibleAfterCn}`);

  // ===== ② iframe 内高亮 =====
  console.log('\n[2] iframe 高亮');

  // 找到一个能匹配"灯"的文件并打开
  const targetPath = await page.evaluate(async () => {
    const r = await fetch('/api/search?q=' + encodeURIComponent('灯'));
    const d = await r.json();
    return d.matches[0]?.path;
  });
  if (!targetPath) {
    console.log('  跳过：没找到含"灯"的文件');
  } else {
    console.log('  打开:', targetPath.split('/').pop());
    // 用 Playwright 真实点击（触发 pointerdown + pointerup）
    await page.locator(`.file[data-path="${targetPath.replace(/(["\\])/g, '\\$1')}"]`).first().click();
    // 等 iframe 加载完成
    await page.waitForFunction(() => {
      const ifr = document.getElementById('preview');
      return ifr && ifr.src && ifr.contentDocument && ifr.contentDocument.readyState === 'complete'
        && ifr.contentDocument.body && ifr.contentDocument.body.children.length > 0;
    }, { timeout: 10000 });
    await page.waitForTimeout(800);  // 等高亮注入

    const hl = await page.evaluate(() => {
      const ifr = document.getElementById('preview');
      const doc = ifr.contentDocument;
      if (!doc) return { error: 'no doc' };
      const marks = [...doc.querySelectorAll('mark[data-atlas-hl]')];
      const currentMark = doc.querySelector('mark[data-atlas-hl].atlas-hl-current');
      const styleInjected = !!doc.querySelector('style[data-atlas-hl-style]');
      return {
        marksCount: marks.length,
        firstMarkText: marks[0]?.textContent,
        currentMarkText: currentMark?.textContent,
        styleInjected,
      };
    });
    console.log('  iframe 高亮状态:', hl);
    check('iframe 内注入了高亮 style', hl.styleInjected);
    check('iframe 内有 mark 元素（命中文字被包起来）', hl.marksCount > 0);
    check('每个 mark 文本是搜索词"灯"', hl.firstMarkText === '灯');
    check('第一个 mark 标记为 current', hl.currentMarkText === '灯');

    // 测试上下跳转
    const matchBadgeBefore = await page.evaluate(() => ({
      visible: !document.getElementById('match-badge').classList.contains('hidden'),
      text: document.querySelector('.match-text')?.textContent,
    }));
    console.log('  match-badge:', matchBadgeBefore);
    check('match-badge 显示', matchBadgeBefore.visible);
    check('match-badge 显示 X / Y 格式', /^\d+\s*\/\s*\d+$/.test(matchBadgeBefore.text || ''));

    // 点 next 跳转
    await page.locator('#match-next').click();
    await page.waitForTimeout(200);
    const afterNext = await page.evaluate(() => {
      const ifr = document.getElementById('preview');
      const doc = ifr.contentDocument;
      const all = [...doc.querySelectorAll('mark[data-atlas-hl]')];
      const cur = doc.querySelector('mark[data-atlas-hl].atlas-hl-current');
      return { idx: all.indexOf(cur) };
    });
    check('点 ▼ 后 current 移到第 2 个', afterNext.idx === 1);

    // 点 prev 回去
    await page.locator('#match-prev').click();
    await page.waitForTimeout(200);
    const afterPrev = await page.evaluate(() => {
      const ifr = document.getElementById('preview');
      const doc = ifr.contentDocument;
      const all = [...doc.querySelectorAll('mark[data-atlas-hl]')];
      const cur = doc.querySelector('mark[data-atlas-hl].atlas-hl-current');
      return { idx: all.indexOf(cur) };
    });
    check('点 ▲ 后 current 回到第 1 个', afterPrev.idx === 0);

    // 清除搜索 → 高亮应消失
    await page.fill('#search', '');
    await page.waitForTimeout(400);
    const cleared = await page.evaluate(() => {
      const ifr = document.getElementById('preview');
      const doc = ifr.contentDocument;
      return {
        marksCount: doc.querySelectorAll('mark[data-atlas-hl]').length,
        badgeHidden: document.getElementById('match-badge').classList.contains('hidden'),
      };
    });
    check('清空搜索：iframe 内 mark 清除', cleared.marksCount === 0);
    check('清空搜索：match-badge 隐藏', cleared.badgeHidden);
  }

  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log(' ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
