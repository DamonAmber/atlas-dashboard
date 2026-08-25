//
// 两个新增能力：
//
//   ① 侧栏分组的「在访达中显示」。
//      只有自动生成的分组（带 autoFor，对应扫描根下的一个一级目录）才有磁盘
//      目录可去；用户手工建的虚拟分组没有对应目录，不该给这个按钮。
//      autoFor 最终会拼进 path.join，所以按不可信输入校验（路径穿越 / 分隔符）。
//      这里只测校验与查找失败这两条无副作用的分支——成功分支会真的 spawn
//      `open -R` 弹出文件管理器窗口，不适合放进自动化测试。
//
//   ② Markdown 预览左侧目录栏可拖拽调宽。
//      原来固定 250px，长标题只能靠 ellipsis 截断，而"步骤 1: 更新 PUBLISHI…"
//      这种截断恰好把有用的部分切掉了。宽度记在 localStorage，跨文档保持。
//
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
let total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}`
    + (ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`));
}

const post = async (base, url, body) => {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

// 造一篇标题足够多的 md：少于 3 个标题不会渲染出侧边目录
const longMd = [
  '# 顶层标题',
  '',
  '## 一、一个相当长的二级标题用来验证目录栏截断问题',
  '正文。',
  '## 二、另一个同样长的二级标题继续占满目录栏的宽度',
  '正文。',
  '### 2.1 三级标题也要能看清楚层级关系',
  '正文。',
  '## 三、第三个二级标题',
  '正文。',
].join('\n');

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-reveal-toc-',
    files: {
      'proj-a/doc.md': longMd,
      'proj-a/other.html': '<!doctype html><html><body><h1>other</h1></body></html>',
    },
  });

  // ================================================================
  console.log('\n[① 分组「在访达中显示」的入口与校验]');

  const state = await (await fetch(atlas.base + '/api/state')).json();
  const autoFolder = state.tree.find(n => n.type === 'folder' && n.autoFor);
  check('自动分组带 autoFor（前端据此决定是否显示按钮）', autoFolder && autoFolder.autoFor, 'proj-a');

  const created = await post(atlas.base, '/api/folders/new', { name: '虚拟分组' });
  check('手工建的分组没有 autoFor（因此不显示该按钮）', created.body.autoFor, undefined);

  check('缺 autoFor → 400', (await post(atlas.base, '/api/reveal-folder', {})).status, 400);
  check('路径穿越 → 400',
    (await post(atlas.base, '/api/reveal-folder', { autoFor: '../../etc' })).status, 400);
  check('含路径分隔符 → 400',
    (await post(atlas.base, '/api/reveal-folder', { autoFor: 'a/b' })).status, 400);
  check('磁盘上没有对应目录 → 404',
    (await post(atlas.base, '/api/reveal-folder', { autoFor: '不存在的项目' })).status, 404);

  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(atlas.base);
  await page.waitForSelector('.folder-header');

  const buttons = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('.folder').forEach((f) => {
      const name = f.querySelector('.folder-name').textContent.trim();
      out[name] = !!f.querySelector('[data-act="reveal-folder"]');
    });
    return out;
  });
  check('自动分组渲染出「在访达中显示」按钮', buttons['proj-a'], true);
  check('虚拟分组没有这个按钮', buttons['虚拟分组'], false);

  // ================================================================
  console.log('\n[② 目录栏拖拽调宽]');

  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(1500);

  const frame = page.frameLocator('#preview');
  const rz = frame.locator('#mdTocResizer');
  await rz.waitFor({ timeout: 8000 });
  check('目录栏有拖拽条', await rz.count(), 1);

  const readW = () => page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    return {
      varW: parseInt(getComputedStyle(d.body).getPropertyValue('--toc-w'), 10),
      tocW: Math.round(d.getElementById('mdToc').getBoundingClientRect().width),
      contentML: Math.round(parseFloat(getComputedStyle(d.querySelector('.md-content')).marginLeft)),
      stored: d.defaultView.localStorage.getItem('atlas:mdTocWidth'),
    };
  });

  const initial = await readW();
  check('默认宽度 250', initial.varW, 250);
  check('正文左边距跟着目录栏宽度', initial.contentML, 250);

  const frameEl = await page.$('#preview');
  const fbox = await frameEl.boundingBox();
  // 每次都要重新取拖拽条位置——它跟着宽度一起移动，用旧坐标会按在正文上
  const dragTo = async (innerX) => {
    const box = await rz.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 300);
    await page.mouse.down();
    await page.mouse.move(fbox.x + innerX, box.y + 300, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    return readW();
  };

  const wide = await dragTo(400);
  check('拖宽到 400 生效', wide.varW, 400);
  check('正文左边距同步', wide.contentML, 400);
  check('宽度已持久化', wide.stored, '400');

  const overMax = await dragTo(900);
  check('超出上限被钳到 520', overMax.varW, 520);
  const underMin = await dragTo(20);
  check('低于下限被钳到 180', underMin.varW, 180);

  await rz.dblclick();
  await page.waitForTimeout(250);
  check('双击复位到 250', (await readW()).varW, 250);

  await rz.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  check('方向键每次微调 8px', (await readW()).varW, 266);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  check('左方向键反向微调', (await readW()).varW, 258);
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
  check('Shift 加速到 24px', (await readW()).varW, 282);
  await page.keyboard.press('Home');
  await page.waitForTimeout(200);
  check('Home 复位', (await readW()).varW, 250);

  // 换个宽度，验证跨文档保持
  await dragTo(340);
  await page.click('.crumb-home');
  await page.waitForTimeout(600);
  await page.click('.file[data-doctype="md"] .file-name');
  await page.waitForTimeout(1500);
  await rz.waitFor({ timeout: 8000 });
  const reopened = await readW();
  check('重新打开文档后宽度保持', reopened.varW, 340);
  check('目录栏实际宽度也是它', reopened.tocW, 340);

  // ================================================================
  console.log('\n[③ 收起目录时拖拽条要让位]');
  await frame.locator('#mdTocToggle').click();
  await page.waitForTimeout(400);
  const collapsed = await page.evaluate(() => {
    const d = document.getElementById('preview').contentDocument;
    return {
      hasClass: d.body.classList.contains('toc-collapsed'),
      rzDisplay: getComputedStyle(d.getElementById('mdTocResizer')).display,
      contentML: Math.round(parseFloat(getComputedStyle(d.querySelector('.md-content')).marginLeft)),
    };
  });
  check('目录已收起', collapsed.hasClass, true);
  check('拖拽条隐藏', collapsed.rzDisplay, 'none');
  check('正文占满宽度', collapsed.contentML, 0);

  await browser.close();
  await atlas.stop();
  console.log(`\n总计 ${total} 项，${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
