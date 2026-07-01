// 复现 "iframe 有时无法滚动" 的 bug
// 假设：body.resizing 或 body.sidebar-animating 卡住没移除 → iframe pointer-events: none → 不能滚
const { chromium } = require('playwright');

const BASE = 'http://localhost:4321';
const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // 选一个长 HTML 文件
  await page.locator('.file').first().click();
  await page.waitForTimeout(800);

  // -------- 场景 1A：正常拖 resizer 后用 pointerup 释放 --------
  console.log('\n[场景 1A] 正常拖动 resizer + pointerup');
  await page.evaluate(() => {
    const r = document.querySelector('.resizer');
    const rect = r.getBoundingClientRect();
    r.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: rect.left + 2, clientY: rect.top + 100,
      button: 0, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
    r.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: 600, clientY: 100, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
    r.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, clientX: 600, clientY: 100, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    }));
  });
  await page.waitForTimeout(80);
  let st = await page.evaluate(() => ({
    resizing: document.body.classList.contains('resizing'),
    iframePE: getComputedStyle(document.getElementById('preview')).pointerEvents,
  }));
  check('场景1A：正常释放后 resizing/pointer-events 已恢复',
    !st.resizing && st.iframePE !== 'none',
    `resizing=${st.resizing}, pointerEvents=${st.iframePE}`);

  // -------- 场景 1B：拖 resizer 后窗口失焦（模拟拖到窗口外释放） --------
  console.log('\n[场景 1B] 拖 resizer 时窗口失焦（不发 pointerup，模拟用户在窗口外释放鼠标）');
  await page.evaluate(() => {
    const r = document.querySelector('.resizer');
    const rect = r.getBoundingClientRect();
    r.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: rect.left + 2, clientY: rect.top + 100,
      button: 0, pointerId: 2, pointerType: 'mouse', isPrimary: true,
    }));
    r.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, clientX: 600, clientY: 100, pointerId: 2, pointerType: 'mouse', isPrimary: true,
    }));
    // 故意不发 pointerup —— 模拟拖出浏览器窗口外释放
    // 触发 blur 兜底
    window.dispatchEvent(new Event('blur'));
  });
  await page.waitForTimeout(80);
  st = await page.evaluate(() => ({
    resizing: document.body.classList.contains('resizing'),
    iframePE: getComputedStyle(document.getElementById('preview')).pointerEvents,
  }));
  check('场景1B：blur 兜底已释放 resizing 状态（iframe 可被滚动）',
    !st.resizing && st.iframePE !== 'none',
    `resizing=${st.resizing}, pointerEvents=${st.iframePE}`);

  // -------- 场景 1C：pointercancel 也能释放 --------
  console.log('\n[场景 1C] pointercancel 释放（系统级中断 / 触摸取消）');
  await page.evaluate(() => {
    const r = document.querySelector('.resizer');
    r.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, clientX: 5, clientY: 100, button: 0,
      pointerId: 3, pointerType: 'mouse', isPrimary: true,
    }));
    r.dispatchEvent(new PointerEvent('pointercancel', {
      bubbles: true, pointerId: 3, pointerType: 'mouse', isPrimary: true,
    }));
  });
  await page.waitForTimeout(80);
  st = await page.evaluate(() => ({
    resizing: document.body.classList.contains('resizing'),
    iframePE: getComputedStyle(document.getElementById('preview')).pointerEvents,
  }));
  check('场景1C：pointercancel 已释放 resizing 状态',
    !st.resizing && st.iframePE !== 'none',
    `resizing=${st.resizing}, pointerEvents=${st.iframePE}`);

  // -------- 场景 2：快速重复点击 toggle --------
  console.log('\n[场景 2] 快速连续点 sidebar toggle（动画期间再点）');

  for (let i = 0; i < 6; i++) {
    await page.locator('#btn-toggle-sidebar').click();
    await page.waitForTimeout(40);  // 远短于 230ms 动画
  }
  // 等所有 setTimeout 都跑完
  await page.waitForTimeout(800);

  st = await page.evaluate(() => ({
    animating: document.body.classList.contains('sidebar-animating'),
    iframePE: getComputedStyle(document.getElementById('preview')).pointerEvents,
    iframeInlineW: document.getElementById('preview').style.width,
    iframeInlineFlex: document.getElementById('preview').style.flex,
  }));
  console.log('  状态：', st);
  check('场景2：连续 toggle 后 sidebar-animating 应已被清除',
    !st.animating, `animating=${st.animating}`);
  check('场景2：iframe inline width 应已被释放',
    st.iframeInlineW === '', `inline width="${st.iframeInlineW}"`);
  check('场景2：iframe pointer-events 应正常（不为 none）',
    st.iframePE !== 'none', `pointerEvents=${st.iframePE}`);

  // -------- 场景 3：直接验证滚动 --------
  console.log('\n[场景 3] iframe 内尝试用 wheel 事件滚动');

  // 先确保 sidebar 是打开的（统一基准）
  const collapsed = await page.evaluate(() => document.body.classList.contains('sidebar-collapsed'));
  if (collapsed) {
    await page.locator('#btn-toggle-sidebar').click();
    await page.waitForTimeout(400);
  }

  // 给 iframe 派发 wheel 事件，看 iframe 内 scroll 是否变化
  const scrolled = await page.evaluate(async () => {
    const ifr = document.getElementById('preview');
    const d = ifr.contentDocument;
    if (!d) return { ok: false, reason: 'no contentDocument' };
    const de = d.scrollingElement || d.documentElement;
    const maxScroll = de.scrollHeight - de.clientHeight;
    if (maxScroll <= 1) return { ok: true, noRoom: true };   // 内容不足一屏，无可滚空间
    // 强制 scroll-behavior:auto，避免页面的 smooth 让 scrollTop 赋值变成动画（读到中间值 0）
    const prev = de.style.scrollBehavior;
    de.style.scrollBehavior = 'auto';
    const before = de.scrollTop;
    de.scrollTop = 200;
    const after = de.scrollTop;
    de.style.scrollBehavior = prev || '';
    return { ok: after > before, before, after };
  });
  console.log('  scroll：', scrolled);
  check('场景3：iframe 内可滚动（scrollTop 能被设置）',
    scrolled.ok, JSON.stringify(scrolled));

  // -------- 场景 4：用 wheel 事件触发 iframe 滚动（鼠标滚轮模拟） --------
  console.log('\n[场景 4] 用 wheel 事件模拟鼠标滚轮');

  const wheelOk = await page.evaluate(async () => {
    const ifr = document.getElementById('preview');
    if (!ifr.contentDocument) return { ok: false, reason: 'no contentDoc' };
    ifr.contentDocument.documentElement.scrollTop = 0;
    const before = ifr.contentDocument.documentElement.scrollTop;
    // 在 iframe 上派发 wheel——这取决于 iframe 是否能接收 pointer 事件
    const ev = new WheelEvent('wheel', {
      bubbles: true, deltaY: 200, deltaMode: 0, cancelable: true,
    });
    ifr.dispatchEvent(ev);
    await new Promise(r => requestAnimationFrame(r));
    const after = ifr.contentDocument.documentElement.scrollTop;
    // 判断的不是滚没滚（dispatchEvent 不一定能驱动浏览器原生滚），而是 pointer-events 没被屏蔽
    const pe = getComputedStyle(ifr).pointerEvents;
    return { peBlocked: pe === 'none', before, after };
  });
  console.log('  wheel：', wheelOk);
  check('场景4：iframe pointer-events 不被任何 class 屏蔽',
    !wheelOk.peBlocked, `peBlocked=${wheelOk.peBlocked}`);

  // -------- 总结 --------
  await browser.close();
  const failed = checks.filter(c => !c.ok);
  console.log(`\n========================`);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length > 0) {
    failed.forEach(f => console.log('  ✗ ' + f.name + (f.detail ? ' — ' + f.detail : '')));
    process.exit(1);
  }
})();
