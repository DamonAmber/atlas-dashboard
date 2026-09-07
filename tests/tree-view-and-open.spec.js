// 目录视图 + 「用 Atlas 打开外部文件」（0.25.0 新增）
//
// 覆盖两条用户反馈的优化：
//   ① 侧栏「分组 / 目录」视图切换：目录视图按磁盘真实多级层级展示（深层子目录都展开），
//      分组视图里深层文件补中间目录提示，解决"多个同名 README 平铺分不清"。
//   ② /api/resolve-open：桌面 App 从 Finder「打开方式」/ 双击拿到路径后，判断该文件
//      在不在扫描范围内、缺什么（ready / need-doctype / need-root / not-doc / not-found）。
//
// 用隔离实例，扫描根下造一棵"扫描根 = work 的父目录"的嵌套树：
//   work/bind_domain/README.md
//   work/bind_domain/domain-overview.md
//   work/bind_domain/sub/note.md
//   work/os_fusion_domain/README.md
// 于是分组视图里两个 README 与深层文件全平铺在 work 分组下（正是用户截图的场景），
// 目录视图里则按 work > bind_domain / os_fusion_domain > … 逐级展开。

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');

let pass = 0, fail = 0;
function ok(cond, label, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`); }
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-treeview-spec-',
    files: {
      'work/bind_domain/README.md': '# bind_domain\n\n绑定域说明。\n',
      'work/bind_domain/domain-overview.md': '# overview\n',
      'work/bind_domain/sub/note.md': '# 深层笔记\n',
      'work/os_fusion_domain/README.md': '# os_fusion_domain\n\n融合域说明。\n',
      'work/os_fusion_domain/taxonomy.md': '# taxonomy\n',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // ---------- 分组视图（默认） ----------
  const groupsView = await page.evaluate(() => {
    const btnGroups = document.querySelector('.seg-btn[data-view="groups"]');
    const btnTree = document.querySelector('.seg-btn[data-view="tree"]');
    const files = [...document.querySelectorAll('#tree .file')];
    const hints = [...document.querySelectorAll('#tree .file-dir-hint')].map(h => h.textContent);
    return {
      hasToggle: !!(btnGroups && btnTree),
      groupsChecked: btnGroups && btnGroups.getAttribute('aria-checked') === 'true',
      fileCount: files.length,
      // 顶层直接就是一个 work 分组（第一级目录），深层结构被压平
      topFolders: [...document.querySelectorAll('#tree > .folder > .folder-header .folder-name')].map(n => n.textContent),
      hints,
    };
  });
  ok(groupsView.hasToggle, '侧栏出现「分组 / 目录」视图切换');
  ok(groupsView.groupsChecked, '默认是分组视图');
  ok(groupsView.fileCount === 5, '分组视图列出全部 5 个文件（平铺）', `实际 ${groupsView.fileCount}`);
  ok(groupsView.topFolders.length === 1 && groupsView.topFolders[0] === 'work',
    '顶层只有一个 work 分组（深层被压平）', JSON.stringify(groupsView.topFolders));
  // 深层文件（relPath 段数 > 2）补中间目录提示；work 直属文件不加
  ok(groupsView.hints.includes('bind_domain') && groupsView.hints.includes('bind_domain/sub')
     && groupsView.hints.includes('os_fusion_domain'),
    '深层文件带中间目录提示（bind_domain / bind_domain/sub / os_fusion_domain）', JSON.stringify(groupsView.hints));

  // ---------- 切到目录视图 ----------
  await page.click('.seg-btn[data-view="tree"]');
  await page.waitForTimeout(150);
  const treeView = await page.evaluate(() => {
    const folderNames = [...document.querySelectorAll('#tree .folder .folder-name')].map(n => n.textContent);
    // 目录视图里 dir 节点带 .dir-node，且只有 reveal-dir，没有 rename/delete/new-sub
    const dirNode = document.querySelector('#tree .folder.dir-node');
    const hasReveal = !!(dirNode && dirNode.querySelector('[data-act="reveal-dir"]'));
    const hasRename = !!(dirNode && dirNode.querySelector('[data-act="rename"]'));
    const hasDelete = !!(dirNode && dirNode.querySelector('[data-act="delete"]'));
    // 两个 README 现在分处不同目录、各自可见
    const readmeFiles = [...document.querySelectorAll('#tree .file .file-name')]
      .filter(n => n.textContent === 'README').length;
    const hintCount = document.querySelectorAll('#tree .file-dir-hint').length;
    return { folderNames, hasReveal, hasRename, hasDelete, readmeFiles, hintCount };
  });
  ok(treeView.folderNames.includes('bind_domain') && treeView.folderNames.includes('os_fusion_domain')
     && treeView.folderNames.includes('sub'),
    '目录视图展开真实多级目录（bind_domain / os_fusion_domain / sub）', JSON.stringify(treeView.folderNames));
  ok(treeView.hasReveal, '目录节点有「在访达中显示」按钮');
  ok(!treeView.hasRename && !treeView.hasDelete, '目录节点没有重命名 / 删除按钮（只读镜像）');
  ok(treeView.readmeFiles === 2, '两个同名 README 分处各自目录、都能看到', `实际 ${treeView.readmeFiles}`);
  ok(treeView.hintCount === 0, '目录视图不再重复显示中间目录提示', `实际 ${treeView.hintCount}`);

  // 视图选择持久化：刷新后仍是目录视图
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.file');
  const persisted = await page.evaluate(() =>
    document.querySelector('.seg-btn[data-view="tree"]').getAttribute('aria-checked') === 'true');
  ok(persisted, '视图选择持久化（刷新后仍是目录视图）');

  // ---------- /api/resolve-open ----------
  // 额外造几个文件：扫描根内的 csv（类型默认关闭）、根外的 md、非文档
  const outsideDir = atlas.makeDir('outside');
  fs.writeFileSync(path.join(outsideDir, 'external.md'), '# 外部\n');
  fs.writeFileSync(path.join(atlas.scanDir, 'data.csv'), 'a,b\n1,2\n');
  fs.writeFileSync(path.join(atlas.scanDir, 'weird.xyz'), 'x');

  const resolve = async (p) => page.evaluate(async (abs) => {
    const r = await fetch('/api/resolve-open', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: abs }),
    });
    return r.json();
  }, p);

  const rReady = await resolve(atlas.filePath('work/bind_domain/README.md'));
  ok(rReady.status === 'ready', 'resolve-open：扫描根内且类型已启用 → ready', rReady.status);

  const rDir = await resolve(atlas.filePath('work/bind_domain'));
  ok(rDir.status === 'ready' && rDir.kind === 'dir', 'resolve-open：扫描根内的目录 → ready(dir)', JSON.stringify(rDir));

  const rDoctype = await resolve(atlas.filePath('data.csv'));
  ok(rDoctype.status === 'need-doctype' && rDoctype.docType === 'csv',
    'resolve-open：扫描根内但类型未启用 → need-doctype(csv)', JSON.stringify(rDoctype));

  const rRoot = await resolve(path.join(outsideDir, 'external.md'));
  ok(rRoot.status === 'need-root' && rRoot.dir === outsideDir,
    'resolve-open：不在扫描根内 → need-root（建议加所在目录）', JSON.stringify(rRoot));

  const rNotDoc = await resolve(path.join(atlas.scanDir, 'weird.xyz'));
  ok(rNotDoc.status === 'not-doc', 'resolve-open：非文档类型 → not-doc', rNotDoc.status);

  const rNotFound = await resolve(path.join(atlas.scanDir, 'does-not-exist.md'));
  ok(rNotFound.status === 'not-found', 'resolve-open：路径不存在 → not-found', rNotFound.status);

  console.log('========================');
  console.log(`总计 ${pass + fail} 项，失败 ${fail} 项`);
  await browser.close();
  await atlas.stop();
  if (fail > 0) process.exit(1);
})();
