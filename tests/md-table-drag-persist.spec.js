// Markdown 编辑：拖行重排后「保存到磁盘」的持久化回归。
//
// 背景（0.29.1 修的 bug）：拖行只在 <table> 上标 data-md-dirty，但表格若嵌在
// 引用块 / 列表项里，携带 data-md-raw 的顶层块（blockquote / ul）没被标脏，
// serializeBlock 便原样吐回旧源码——右侧行序变了、左侧源码不同步，保存即回退。
//
// 钉住的行为：
//   ① 顶层表格：拖行 → 保存 → 磁盘是新顺序（此前只验证过 #md-source，没验证落盘）
//   ② 引用块内表格：拖行 → 保存 → 磁盘新顺序，且每行仍带 `>`（结构保真）
//   ③ 列表项内表格：拖行 → 保存 → 磁盘新顺序，且表格仍缩进在列表项下（结构保真）
const fs = require('fs');
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

const FIXTURES = {
  '顶层表格': [
    '# 文档', '',
    '| 名称 | 值 |', '|------|----|',
    '| 甲 | 1 |', '| 乙 | 2 |', '| 丙 | 3 |', '',
    '结尾。', '',
  ].join('\n'),
  '引用块内表格': [
    '# 文档', '',
    '> | 名称 | 值 |', '> |------|----|',
    '> | 甲 | 1 |', '> | 乙 | 2 |', '> | 丙 | 3 |', '',
    '结尾。', '',
  ].join('\n'),
  '列表项内表格': [
    '# 文档', '',
    '- 步骤一', '',
    '  | 名称 | 值 |', '  |------|----|',
    '  | 甲 | 1 |', '  | 乙 | 2 |', '  | 丙 | 3 |', '',
    '结尾。', '',
  ].join('\n'),
};

// 抓第 n 行的抓手，拖到第 1 行上方
async function dragRowToTop(page, n) {
  const gN = await page.locator(`#md-preview tbody tr:nth-child(${n}) .md-row-grip`).boundingBox();
  const g1 = await page.locator('#md-preview tbody tr:nth-child(1) .md-row-grip').boundingBox();
  await page.mouse.move(gN.x + gN.width / 2, gN.y + gN.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(80);
  await page.mouse.move(g1.x + g1.width / 2, g1.y - 4, { steps: 20 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

async function runScenario(label, md, pageErrors) {
  const atlas = await startAtlas({ prefix: 'atlas-tbldrag-', files: { 'proj/t.md': md } });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  page.on('pageerror', e => pageErrors.push(`[${label}] ${e}`));
  try {
    await page.goto(atlas.base);
    await page.waitForSelector('.file');
    await page.click('.file[data-doctype="md"] .file-name');
    await page.waitForTimeout(1000);
    await page.click('#btn-edit');
    await page.waitForSelector('#md-editor:not(.hidden)');
    await page.waitForTimeout(300);

    // 把最后一行（丙）拖到最前
    await dragRowToTop(page, 3);

    // 拖完源码应立即同步（引用块 / 列表嵌套此前就败在这一步）
    const src = await page.inputValue('#md-source');
    const srcBing = src.indexOf('丙') > 0 && src.indexOf('丙') < src.indexOf('甲');
    check(`${label}：拖行后源码同步（丙在甲前）`, srcBing, true);

    // 保存 → 读磁盘
    await page.click('#btn-edit-save');
    await page.waitForTimeout(900);
    const disk = fs.readFileSync(atlas.filePath('proj/t.md'), 'utf8');
    const diskBing = disk.indexOf('丙') > 0 && disk.indexOf('丙') < disk.indexOf('甲');
    check(`${label}：保存后磁盘是新顺序（丙在甲前）`, diskBing, true);

    // 结构保真：数据行仍在原来的容器里
    const tblLines = disk.split('\n').filter(l => /丙|甲|乙/.test(l));
    if (label.includes('引用')) {
      check(`${label}：引用块结构保真（每行仍带 >）`, tblLines.every(l => /^\s*>/.test(l)), true);
    } else if (label.includes('列表')) {
      check(`${label}：列表结构保真（表格行仍缩进）`, tblLines.every(l => /^\s{2,}\|/.test(l)), true);
    }

    // 保存后能重新渲染出表格（不白屏、结构没被序列化毁掉）
    const rerender = await page.evaluate((raw) => {
      const html = window.AtlasMarkdown.renderBody(raw, { annotateRaw: true });
      return { hasTable: /<table/.test(html), rows: (html.match(/<tbody>[\s\S]*?<\/tbody>/) || [''])[0] };
    }, disk);
    check(`${label}：磁盘内容能重新渲染成表格`, rerender.hasTable, true);
    const order = ['丙', '甲', '乙'].map(x => rerender.rows.indexOf(x));
    check(`${label}：重渲染后行序为 丙→甲→乙`, order[0] > 0 && order[0] < order[1] && order[1] < order[2], true);
  } finally {
    await browser.close();
    await atlas.stop();
  }
}

(async () => {
  const pageErrors = [];
  for (const [label, md] of Object.entries(FIXTURES)) {
    console.log(`\n[${label}]`);
    await runScenario(label, md, pageErrors);
  }
  console.log('\n[全局]');
  check('全程无 JS 报错', pageErrors, []);

  console.log('\n========================');
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
