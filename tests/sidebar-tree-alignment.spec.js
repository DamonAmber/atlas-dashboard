// 侧栏目录树：层级对齐与行内元素（design §10.5b、§11.B2、§12.1、§12.2）
//
// 覆盖：
//   ① 对齐 —— 目录视图三层嵌套（atlas-core → 报告 → 基准数据）下，同一层的文件夹名与
//      文件名起点相同（±0.5px），逐层递增；未读 / 已读行一样对齐（状态点列始终占位）
//   ② 行内元素 —— 文件行没有可见的类型图标；已收藏行名字后有 .fav-mark；
//      星标 .fav-btn 在悬停操作组里，悬停前可见宽度为 0，悬停后露出来
//   ③ 文件夹图标 —— 计算颜色等于 --text-dim、不填充；展开 / 收起只换形状
//   ④ 字号与行高 —— 文件夹 12.5px / 28px，文件 12px / 26px
const { chromium } = require('playwright');
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

const md = (t) => `# ${t}\n\n正文。\n`;
const html = (t) => `<!doctype html><html><body><h1>${t}</h1></body></html>`;

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-tree-align-',
    files: {
      'readme.md': md('根目录说明'),
      'atlas-core/api.md': md('activity-log 接口草案'),
      'atlas-core/focus.html': html('专注模式交互稿'),
      'atlas-core/报告/perf.md': md('星图渲染性能报告'),
      'atlas-core/报告/thumb.md': md('缩略图队列设计'),
      'atlas-core/报告/基准数据/canvas.html': html('Canvas LOD 基准'),
      'atlas-core/报告/基准数据/labels.md': md('标签避让压测'),
      'infra/oncall.md': md('Oncall 值班手册'),
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(atlas.base);
  await page.waitForSelector('.tree .file');

  // 收藏一篇、把两篇标成已读：对齐不能因为"有没有未读点 / 收藏星"而错位
  await page.evaluate(async (p) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    await post('/api/favorite', { path: p.fav, favorite: true });
    for (const s of p.seen) await post('/api/seen', { path: s });
    // 每层各一篇带 3 个标签的文件：⑤ 断言行上最多 1 个 chip、两层以下不显示
    for (const t of p.tagged) await post('/api/tags', { path: t, tags: ['性能', '设计稿', '评审'] });
  }, {
    tagged: [
      atlas.filePath('readme.md'),
      atlas.filePath('atlas-core/focus.html'),
      atlas.filePath('atlas-core/报告/thumb.md'),
      atlas.filePath('atlas-core/报告/基准数据/canvas.html'),
    ],
    fav: atlas.filePath('atlas-core/api.md'),
    seen: [atlas.filePath('atlas-core/报告/perf.md'), atlas.filePath('atlas-core/报告/基准数据/labels.md')],
  });
  // 目录视图：按磁盘真实层级展示，默认全展开
  await page.click('.seg-btn[data-view="tree"]');
  await page.evaluate(() => fetchState());
  await page.waitForFunction(() => document.querySelectorAll('.tree .file').length === 8);
  await page.waitForTimeout(300);

  console.log('\n[① 同层文件夹名与文件名对齐]');
  const levels = await page.evaluate(() => {
    // 从 #tree 往下逐层走：每层取直接子级里的文件夹名与文件名的 left
    const out = [];
    let containers = [document.getElementById('tree')];
    while (containers.length) {
      const folderLefts = [];
      const fileLefts = [];
      const next = [];
      for (const c of containers) {
        for (const child of c.children) {
          if (child.classList.contains('folder')) {
            folderLefts.push(child.querySelector(':scope > .folder-header .folder-name').getBoundingClientRect().left);
            next.push(child.querySelector(':scope > .folder-children'));
          } else if (child.classList.contains('file')) {
            fileLefts.push(child.querySelector('.file-name').getBoundingClientRect().left);
          }
        }
      }
      if (folderLefts.length || fileLefts.length) out.push({ folderLefts, fileLefts });
      containers = next.filter(Boolean);
    }
    return out;
  });
  check('一共 4 层（根 / atlas-core / 报告 / 基准数据）', levels.length, 4);
  const firstOf = (l) => (l.folderLefts.length ? l.folderLefts[0] : l.fileLefts[0]);
  levels.forEach((l, i) => {
    const all = [...l.folderLefts, ...l.fileLefts];
    const spread = Math.max(...all) - Math.min(...all);
    check(`第 ${i + 1} 层：${l.folderLefts.length} 个文件夹名 + ${l.fileLefts.length} 个文件名起点一致（±0.5px）`,
      spread <= 0.5, true);
  });
  check('前三层每层都同时有文件夹和文件（对齐断言确实比较了两类行）',
    levels.slice(0, 3).every(l => l.folderLefts.length > 0 && l.fileLefts.length > 0), true);
  for (let i = 1; i < levels.length; i++) {
    const step = firstOf(levels[i]) - firstOf(levels[i - 1]);
    check(`第 ${i + 1} 层比第 ${i} 层缩进（${step.toFixed(1)}px）`, step > 10, true);
  }
  const steps = levels.slice(1).map((l, i) => Math.round((firstOf(l) - firstOf(levels[i])) * 2) / 2);
  check('每层缩进相同', new Set(steps).size, 1);

  // 状态点放在 40px 前缀列里、对准同级文件夹图标中心
  const dotAlign = await page.evaluate(() => {
    const dot = document.querySelector('.tree .file[data-path$="api.md"] .unread-dot');
    const icon = document.querySelector('.tree .folder-children > .folder > .folder-header .folder-icon');
    const c = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    return Math.abs(c(dot) - c(icon));
  });
  check('状态点中心对准同级文件夹图标中心（±1px）', dotAlign <= 1, true);

  console.log('\n[② 文件行内元素]');
  const typeIcons = await page.evaluate(() =>
    [...document.querySelectorAll('.tree .file .file-type-icon')].map(e => ({
      inDom: true,
      display: getComputedStyle(e).display,
      w: e.getBoundingClientRect().width,
    })));
  check('类型图标 DOM 保留（每行一个）', typeIcons.length, 8);
  check('文件行内没有可见的 .file-type-icon',
    typeIcons.every(t => t.display === 'none' && t.w === 0), true);

  const favRow = '.tree .file[data-path$="atlas-core/api.md"]';
  check('已收藏文件有 .fav-mark', await page.locator(`${favRow} .fav-mark`).count(), 1);
  check('.fav-mark 跟在文件名后面',
    await page.evaluate((sel) => {
      const row = document.querySelector(sel);
      return row.querySelector('.file-name').nextElementSibling.classList.contains('fav-mark');
    }, favRow), true);
  check('未收藏文件没有 .fav-mark',
    await page.locator('.tree .file[data-path$="focus.html"] .fav-mark').count(), 0);
  check('星标是悬停操作组的第一个按钮',
    await page.evaluate((sel) => document.querySelector(`${sel} .file-actions`).firstElementChild.classList.contains('fav-btn'), favRow),
    true);
  check('操作组按钮顺序：收藏 / 分享 / 标签 / 重命名文件 / 备注名 / 在访达中显示',
    await page.evaluate((sel) => [...document.querySelectorAll(`${sel} .file-actions > button`)]
      .map(b => b.classList.contains('fav-btn') ? 'fav' : b.dataset.act), favRow),
    ['fav', 'share', 'tags', 'rename-file', 'alias', 'reveal']);
  // 星标的"可见宽度" = 它与操作组容器（overflow:hidden）的水平交集
  const visibleStarW = () => page.evaluate((sel) => {
    const btn = document.querySelector(`${sel} .fav-btn`);
    const box = btn.parentElement.getBoundingClientRect();
    const r = btn.getBoundingClientRect();
    return Math.max(0, Math.min(r.right, box.right) - Math.max(r.left, box.left));
  }, favRow);
  await page.mouse.move(900, 600);   // 指针停在侧栏外
  await page.waitForTimeout(200);
  check('悬停前 .fav-btn 可见宽度为 0', await visibleStarW(), 0);
  await page.hover(favRow);
  await page.waitForTimeout(300);
  check('悬停后 .fav-btn 露出来（≥ 16px）', (await visibleStarW()) >= 16, true);
  check('已收藏行的星标 aria-pressed=true', await page.getAttribute(`${favRow} .fav-btn`, 'aria-pressed'), 'true');
  await page.mouse.move(900, 600);

  console.log('\n[③ 文件夹图标]');
  const iconColor = await page.evaluate(() => {
    const icon = document.querySelector('.tree .folder-header .folder-icon');
    const probe = document.createElement('span');
    probe.style.color = 'var(--text-dim)';
    icon.parentElement.appendChild(probe);
    const want = getComputedStyle(probe).color;
    probe.remove();
    const svg = [...icon.querySelectorAll('svg')].find(s => getComputedStyle(s).display !== 'none');
    return { got: getComputedStyle(icon).color, want, fill: getComputedStyle(svg).fill };
  });
  check('文件夹图标计算颜色等于 --text-dim', iconColor.got, iconColor.want);
  check('文件夹图标不填充', iconColor.fill, 'none');
  const shapeOf = (sel) => page.evaluate((s) => {
    const icon = document.querySelector(s);
    const shown = [...icon.querySelectorAll('svg')].filter(v => getComputedStyle(v).display !== 'none');
    return shown.map(v => v.querySelector('use').getAttribute('href'));
  }, sel);
  const coreIcon = '.tree > .folder > .folder-header .folder-icon';
  check('展开的文件夹显示 folder-open 形状', await shapeOf(coreIcon), ['#i-folder-open']);
  await page.click('.tree > .folder > .folder-header .folder-name >> nth=0');
  await page.waitForFunction(() => document.querySelector('.tree > .folder').classList.contains('collapsed'));
  await page.waitForTimeout(300);
  check('收起后换成 folder 形状', await shapeOf(coreIcon), ['#i-folder']);
  const colorAfter = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).color, coreIcon);
  check('收起后颜色不变', colorAfter, iconColor.want);
  await page.click('.tree > .folder > .folder-header .folder-name >> nth=0');
  await page.waitForFunction(() => !document.querySelector('.tree > .folder').classList.contains('collapsed'));
  await page.waitForTimeout(300);

  console.log('\n[④ 字号与行高]');
  const metrics = await page.evaluate(() => {
    const fh = document.querySelector('.tree .folder-header');
    const nested = document.querySelector('.tree .folder .folder .folder-name');
    const file = document.querySelector('.tree .file');
    return {
      folderSize: getComputedStyle(fh.querySelector('.folder-name')).fontSize,
      folderWeight: getComputedStyle(fh.querySelector('.folder-name')).fontWeight,
      nestedWeight: getComputedStyle(nested).fontWeight,
      folderH: Math.round(fh.getBoundingClientRect().height),
      fileSize: getComputedStyle(file.querySelector('.file-name')).fontSize,
      fileH: Math.round(file.getBoundingClientRect().height),
    };
  });
  check('文件夹名 12.5px', metrics.folderSize, '12.5px');
  check('顶层文件夹名 600', metrics.folderWeight, '600');
  check('嵌套子分组名 560', metrics.nestedWeight, '560');
  check('文件夹行高 28px', metrics.folderH, 28);
  check('文件名 12px', metrics.fileSize, '12px');
  check('文件行高 26px', metrics.fileH, 26);

  console.log('\n[⑤ 行内标签 chip：最多 1 个，两层以下不显示（§10.5）]');
  await page.mouse.move(900, 600);
  await page.waitForTimeout(200);
  const chips = await page.evaluate(() => {
    const at = (suffix) => {
      const row = document.querySelector(`.tree .file[data-path$="${suffix}"]`);
      const tags = [...row.querySelectorAll('.file-tag')];
      return {
        dom: tags.map(t => t.textContent.trim()),
        visible: tags.filter(t => t.getBoundingClientRect().width > 0).length,
        title: /标签：性能 · 设计稿 · 评审/.test(row.title),
      };
    };
    return {
      l1: at('/readme.md'),
      l2: at('atlas-core/focus.html'),
      l3: at('报告/thumb.md'),
      l4: at('基准数据/canvas.html'),
    };
  });
  check('根层文件：只渲染第一个标签、没有 +N', chips.l1.dom, ['性能']);
  check('根层文件：chip 可见', chips.l1.visible, 1);
  check('第 2 层文件：chip 可见 1 个', [chips.l2.dom, chips.l2.visible], [['性能'], 1]);
  check('第 3 层文件（两层文件夹内）：chip 可见 1 个', [chips.l3.dom, chips.l3.visible], [['性能'], 1]);
  check('第 4 层文件（三层文件夹内）：不显示 chip', chips.l4.visible, 0);
  check('完整标签仍在每行 title 里',
    [chips.l1.title, chips.l2.title, chips.l3.title, chips.l4.title], [true, true, true, true]);

  console.log('\n[无 JS 报错]');
  check('页面没有抛出未捕获异常', pageErrors, []);

  await browser.close();
  await atlas.stop();
  console.log('\n========================');
  console.log(`总计 ${total} 项，失败 ${failures} 项`);
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('spec 自身出错:', e);
  process.exit(1);
});
