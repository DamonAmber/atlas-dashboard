// ⌘K 快速打开：正文搜索 + 打开后定位到命中位置
//
// 加这个能力的动机：原来 ⌘K 只模糊匹配文件名 / 备注 / 项目名。可 AI 生成的报告
// 文件名往往很泛（一堆 README.md、20260529-xxx.md），你记得的是"某篇里提过转化率"，
// 而不是文件叫什么。侧栏搜索本来就能搜正文，但它同时会过滤整棵目录树，
// 是"收窄视野"而不是"跳过去"。
//
// 设计要点（本 spec 逐条钉住）：
//   ① 名称命中永远在前，正文命中作为第二组追加 —— 不破坏"敲两个字母 Enter 就走"
//   ② 已被名称组收录的文件不在正文组重复出现
//   ③ 摘要保留原始大小写（服务端 snippet 曾经只返回小写），关键词在摘要里被标出
//   ④ 打开正文命中项后：预览里高亮该词、滚到第一处、顶栏出现 n/m 可继续跳
//   ⑤ 全程不写侧栏搜索框 —— 否则会顺带过滤目录树，属于用户没要求的副作用
//   ⑥ 单个 ASCII 字符不触发正文搜索（匹配面太广，服务端也会拒）
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
    prefix: 'atlas-qocontent-',
    files: {
      // 文件名带 widget → 名称组命中；正文里也有 → 不该在正文组重复出现
      'alpha/widget-notes.md': '# Widget notes\n\nThe Widget is documented here.\n',
      // 文件名完全不含关键词，只有正文有 → 正文组唯一来源
      'alpha/quarterly.md': '# 季度回顾\n\n'
        + '前言段落。\n\n'
        + 'Widget 的转化率是本季核心指标。\n\n'
        + '填充段落。\n'.repeat(80)
        + '文档末尾再提一次 Widget，用来验证"多处命中"与 ▼ 跳转。\n',
      'beta/report.html': '<!doctype html><html><body><h1>Beta</h1>'
        + '<p>正文提到 Widget 一次。</p></body></html>',
      // 谁都不该命中
      'beta/unrelated.md': '# 无关\n\n这里没有那些词。\n',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  // ---- 工具 ----
  const openPanel = async () => {
    await page.keyboard.press('Meta+k');
    await page.waitForSelector('#quickopen:not(.hidden)');
    await page.waitForTimeout(120);
  };
  const typeQuery = async (q) => {
    await page.evaluate((v) => {
      const el = document.getElementById('quickopen-input');
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, q);
    // debounce 180ms + 一次服务端往返
    await page.waitForTimeout(900);
  };
  const rows = () => page.evaluate(() =>
    [...document.querySelectorAll('.quickopen-item')].map(e => ({
      name: e.querySelector('.qo-name').textContent,
      isContent: e.classList.contains('is-content'),
      snippet: e.querySelector('.qo-snippet') ? e.querySelector('.qo-snippet').textContent : null,
      marks: [...e.querySelectorAll('.qo-snippet mark')].map(m => m.textContent),
      hits: e.querySelector('.qo-hits') ? e.querySelector('.qo-hits').textContent.trim() : null,
    })));

  // ================================================================
  console.log('\n[分组] 名称命中在前，正文命中追加为第二组');
  await openPanel();
  await typeQuery('widget');
  const r1 = await rows();
  // 快速打开显示的是"去掉扩展名的文件名"（或备注名），不是 md 里的 H1
  check('第一条是文件名命中（widget-notes）', r1[0].name, 'widget-notes');
  check('第一条不是正文命中行', r1[0].isContent, false);
  check('名称组只有它一个（其余三篇文件名都不含 widget）',
    r1.filter(r => !r.isContent).map(r => r.name), ['widget-notes']);
  check('出现了「正文命中」分组标题', await page.evaluate(() =>
    [...document.querySelectorAll('.qo-group')].some(e => /正文命中/.test(e.textContent))), true);
  check('正文组正是那两篇文件名不含 widget、但正文里有的',
    r1.filter(r => r.isContent).map(r => r.name).sort(), ['quarterly', 'report']);
  check('名称已命中的文件不在正文组重复出现',
    r1.filter(r => r.name === 'widget-notes').length, 1);
  check('正文里没这些词的文件不出现',
    r1.some(r => r.name === 'unrelated'), false);

  // ================================================================
  console.log('\n[摘要] 保留原始大小写，关键词被标出');
  const q = r1.find(r => r.name === 'quarterly') || {};
  check('正文组里能找到 quarterly（正文搜索接线正常）', !!q.snippet, true);
  check('正文命中行带摘要', typeof q.snippet, 'string');
  check('摘要保留原始大小写（Widget 不是 widget）', /Widget/.test(q.snippet || ''), true);
  check('摘要里关键词被 mark 标出', (q.marks || []).length >= 1, true);
  check('标出的正是查询词（忽略大小写）',
    (q.marks || []).length > 0 && q.marks.every(m => m.toLowerCase() === 'widget'), true);

  // ================================================================
  console.log('\n[命中处数] 显示这篇正文里有几处');
  check('命中处数是「N 处」格式', /^\d+(\+)? 处$/.test(q.hits || ''), true);

  // ================================================================
  console.log('\n[副作用] 不写侧栏搜索框，目录树不被过滤');
  check('侧栏搜索框仍为空', await page.inputValue('#search'), '');
  check('目录树仍显示全部 4 篇', await page.evaluate(() =>
    document.querySelectorAll('#tree .file').length), 4);

  // ================================================================
  console.log('\n[定位] 打开正文命中项 → 高亮 + 滚到第一处 + 顶栏可跳转');
  // 点「quarterly」那一行（文件名不含 widget，纯正文命中）
  const qIdx = r1.findIndex(r => r.name === 'quarterly');
  check('quarterly 在结果列表里（否则下面的定位断言无从谈起）', qIdx >= 0, true);
  await page.evaluate((i) => {
    const el = document.querySelectorAll('.quickopen-item')[i];
    if (el) el.click();
  }, qIdx);
  await page.waitForTimeout(2500);

  const jump = await page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    const marks = d ? [...d.querySelectorAll('mark[data-atlas-hl]')] : [];
    const cur = d ? d.querySelector('mark[data-atlas-hl].atlas-hl-current') : null;
    const badge = document.getElementById('match-badge');
    return {
      total: marks.length,
      curText: cur ? cur.textContent : null,
      badgeHidden: badge.classList.contains('hidden'),
      badgeText: badge.querySelector('.match-text').textContent,
      badgeTitle: badge.title,
      inView: cur ? (() => {
        const r = cur.getBoundingClientRect();
        return r.top > -10 && r.top < d.defaultView.innerHeight;
      })() : false,
      sidebarSearch: document.getElementById('search').value,
    };
  });
  check('预览里高亮了命中词', jump.total >= 2, true);
  check('当前命中被标为 current', (jump.curText || '').toLowerCase(), 'widget');
  check('当前命中滚进了视口', jump.inView, true);
  check('顶栏命中导航出现', jump.badgeHidden, false);
  check('导航从第 1 处开始', /^1 \/ \d+$/.test(jump.badgeText), true);
  check('导航 title 说明来源', jump.badgeTitle, '正文命中：widget');
  check('打开后侧栏搜索框依旧为空', jump.sidebarSearch, '');

  // 顶栏 ▼ 能跳到下一处
  await page.click('#match-next');
  await page.waitForTimeout(500);
  check('点 ▼ 跳到第 2 处', await page.evaluate(() =>
    document.querySelector('#match-badge .match-text').textContent.startsWith('2 /')), true);

  // ================================================================
  console.log('\n[失效] 之后从目录树打开别的文档，不该还带着高亮');
  await page.click('.file[data-path$="unrelated.md"] .file-name');
  await page.waitForTimeout(2200);
  check('换文档后高亮已清除', await page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    return d ? d.querySelectorAll('mark[data-atlas-hl]').length : -1;
  }), 0);
  check('命中导航也收起了', await page.evaluate(() =>
    document.getElementById('match-badge').classList.contains('hidden')), true);

  // ================================================================
  console.log('\n[门槛] 单个 ASCII 字符不触发正文搜索');
  const searchCalls = [];
  page.on('request', (req) => {
    if (req.url().includes('/api/search')) searchCalls.push(req.url());
  });
  await openPanel();
  await typeQuery('w');
  check('单字符没有发起 /api/search', searchCalls.length, 0);
  check('也没有正文命中分组', await page.evaluate(() =>
    document.querySelectorAll('.qo-group').length), 0);
  // 中文单字仍然该搜（和服务端 termIsSearchable 的规则一致）
  await typeQuery('转');
  check('中文单字会发起 /api/search', searchCalls.length >= 1, true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  // ================================================================
  console.log('\n[名称组不受影响] 空查询与纯名称查询的行为没变');
  await openPanel();
  check('空查询列出全部 4 篇', await page.evaluate(() =>
    document.querySelectorAll('.quickopen-item').length), 4);
  check('空查询不出现正文分组', await page.evaluate(() =>
    document.querySelectorAll('.qo-group').length), 0);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
