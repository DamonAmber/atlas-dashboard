// 预览 iframe 内的 app 级快捷键
//
// 修的问题：预览是一份独立文档，键盘事件不会跨 iframe 边界冒泡到外壳，
// 所以外壳那个 keydown 总处理器收不到。表现出来就是——点进文档正文读一会儿，
// 再按 ⌘K 想跳下一篇，没反应；必须先点侧栏把焦点拿回来。
// 而"读完跳下一篇"恰好是这个工具最常见的动线。
//
// 修法是往同源预览文档里注入一个 keydown 桥，把带修饰键的 app 级和弦
// preventDefault 之后重新派发给外壳。本 spec 钉住两件事：
//   ① 该转发的转发：焦点在 iframe 内时 ⌘K / ⌘B 生效，编辑态下 ⌘S 生效
//   ② 该让位的让位：文档内正在打字时不抢 ⌘K / ⌘B；非编辑态不抢 ⌘S；
//      单键 `/` 一律不转发（不少 HTML 报告自己就用 `/` 做站内搜索）
//
// 注意这个桥只在**同源**预览下成立：往文档里挂监听需要能拿到 contentDocument，
// 而未信任的 HTML 默认在沙箱里预览（opaque origin）。所以本 spec 用
// trustAllHtml 起实例。沙箱下桥不可用这件事由 rich-and-sandbox.spec 明确钉住。
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
    prefix: 'atlas-keybridge-',
    files: {
      // 正文够长，点击落点一定落在文档里而不是空白外
      'proj/page.html': '<!doctype html><html><body><h1>报告标题</h1>'
        + '<p>段落文字，用来承载点击落点。</p>'.repeat(30)
        + '<input id="docInput" placeholder="文档自带的输入框" />'
        + '</body></html>',
      'proj/other.html': '<!doctype html><html><body><h1>另一篇</h1></body></html>',
      'proj/note.md': '# 笔记\n\n正文。\n',
    },
    config: { trustAllHtml: true },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  // ---- 工具 ----
  // 多 Tab 后 .preview 里可能同时挂着多个 iframe（每个 Tab 一个，非活动的隐藏）。
  // 当前活动帧独占 id="preview"，所以按 #preview 取帧，才拿得到"正在看的那篇"。
  const previewFrame = async () => {
    const h = await page.$('#preview');
    const f = h && await h.contentFrame();
    if (!f) throw new Error('找不到预览 iframe');
    return f;
  };
  const quickOpenVisible = () =>
    page.evaluate(() => !document.getElementById('quickopen').classList.contains('hidden'));
  const sidebarCollapsed = () =>
    page.evaluate(() => document.body.classList.contains('sidebar-collapsed'));
  const activeShellEl = () =>
    page.evaluate(() => document.activeElement.tagName + (document.activeElement.id ? '#' + document.activeElement.id : ''));
  // 把焦点放进预览文档正文（模拟"读文档时"的状态）
  const focusInsideDoc = async () => {
    await (await previewFrame()).click('h1');
    await page.waitForTimeout(150);
  };

  const openFile = async (nameSuffix) => {
    await page.click(`.file[data-path$="${nameSuffix}"] .file-name`);
    await page.waitForTimeout(1200);
  };

  await openFile('page.html');

  // ================================================================
  console.log('\n[前置] 快捷键桥已注入同源预览文档');
  check('iframe 内挂上了桥', await page.evaluate(() => {
    try { return !!document.getElementById('preview').contentDocument.__atlasKeyBridge; }
    catch { return ' contentDocument 不可读 '; }
  }), true);
  await focusInsideDoc();
  check('焦点确实落在 iframe 上', await activeShellEl(), 'IFRAME#preview');

  // ================================================================
  console.log('\n[⌘K] 焦点在文档正文里也能开快速打开');
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(300);
  check('⌘K 打开了快速打开面板', await quickOpenVisible(), true);
  // 而且真能用来切文件（这才是这个 bug 的实际代价）
  await page.keyboard.type('other');
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  check('从面板里 Enter 切到了另一篇文档',
    await page.evaluate(() => {
      const el = document.querySelector('#crumbs .crumb-name, #crumbs .crumb-alias');
      return el ? el.textContent.trim() : '';
    }), 'other.html');
  check('切完后面板已关闭', await quickOpenVisible(), false);

  // ================================================================
  console.log('\n[⌘B] 焦点在文档正文里也能收侧栏');
  await openFile('page.html');
  await focusInsideDoc();
  const bBefore = await sidebarCollapsed();
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(400);
  const bAfter = await sidebarCollapsed();
  check('⌘B 切换了侧栏', bBefore !== bAfter, true);
  // 复位，避免影响后续用例的点击坐标
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(400);
  check('再按一次复位', await sidebarCollapsed(), bBefore);

  // ================================================================
  console.log('\n[让位] 文档内正在打字时不抢 ⌘K / ⌘B');
  await (await previewFrame()).click('#docInput');
  await page.waitForTimeout(150);
  check('焦点在文档自带的 input 上', await (await previewFrame()).evaluate(
    () => document.activeElement.id), 'docInput');
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(300);
  check('⌘K 没有打开快速打开（交回输入上下文）', await quickOpenVisible(), false);
  const typingBefore = await sidebarCollapsed();
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(300);
  check('⌘B 没有切换侧栏', await sidebarCollapsed(), typingBefore);

  // ================================================================
  console.log('\n[让位] 单键 / 不转发（文档可能自己在用）');
  await focusInsideDoc();
  await page.keyboard.press('/');
  await page.waitForTimeout(250);
  check('/ 没有把焦点抢到搜索框', await activeShellEl(), 'IFRAME#preview');

  // ================================================================
  console.log('\n[⌘S] 只在编辑态下归 Atlas');
  // 非编辑态：桥不应该拦 ⌘S（拦了会吃掉浏览器的「存储网页」）
  await focusInsideDoc();
  const sHandledIdle = await (await previewFrame()).evaluate(() => {
    // 自己造一个 ⌘S 派发到文档上，看桥有没有 preventDefault
    const ev = new KeyboardEvent('keydown', {
      key: 's', code: 'KeyS', metaKey: true, bubbles: true, cancelable: true,
    });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('非编辑态：⌘S 未被拦下（让给浏览器）', sHandledIdle, false);

  // 编辑态：⌘S 必须被拦下并触发保存
  await page.click('#btn-edit');
  await page.waitForSelector('#btn-edit-save:not(.hidden)');
  await page.waitForTimeout(800);
  const sHandledEditing = await (await previewFrame()).evaluate(() => {
    const ev = new KeyboardEvent('keydown', {
      key: 's', code: 'KeyS', metaKey: true, bubbles: true, cancelable: true,
    });
    document.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('编辑态：⌘S 被拦下（不再弹浏览器的「存储网页」）', sHandledEditing, true);
  // 不止是拦下 —— 它得真的走到保存流程。这次没改任何内容，
  // saveEdit() 的分支是「没有改动」toast + 退出编辑态，正好可以断言。
  await page.waitForTimeout(1200);
  check('⌘S 真的触发了保存流程（编辑态已退出）',
    await page.evaluate(() => document.body.classList.contains('editing-mode')), false);
  check('并且给了「没有改动」的反馈',
    await page.evaluate(() => [...document.querySelectorAll('.toast')]
      .some(t => /没有改动/.test(t.textContent))), true);

  // ================================================================
  console.log('\n[导航后重新架桥] iframe 换文档后桥要还在');
  await openFile('note.md');
  await page.waitForTimeout(600);
  check('换到 md 预览后桥仍然存在', await page.evaluate(() => {
    try { return !!document.getElementById('preview').contentDocument.__atlasKeyBridge; }
    catch { return false; }
  }), true);
  await focusInsideDoc();
  await page.keyboard.press('Meta+k');
  await page.waitForTimeout(300);
  check('md 预览里 ⌘K 同样可用', await quickOpenVisible(), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ================================================================
  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
