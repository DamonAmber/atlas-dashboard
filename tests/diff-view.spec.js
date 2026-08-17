// Diff 视图：和上次已读版本对比
//
// 未读红点只回答了"AI 动过这个文件"，答不了"动了什么"。这个功能补上后半句：
// 用户每次打开文档时 /api/seen 会把当前内容存一份底本（ATLAS_HOME/versions/），
// 之后文件被改动就能逐行对比。
//
// 本 spec 检查：
//   ① 底本生命周期：打开即记录、内容相同不重复存、每文件保留上限、删文件即清理
//   ② /api/diff：无底本时的提示、无改动、有改动的 hunk 与统计、上下文行数
//   ③ /api/diff/accept：把当前内容设为新底本
//   ④ 重命名后底本跟着迁移
//   ⑤ 前端：按钮可用性、面板渲染、切文件自动关闭、编辑态互斥
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

const V1 = ['# 周报', '', '## 进展', '', '- 完成 A', '- 完成 B', '', '## 风险', '', '暂无。'].join('\n');
const V2 = ['# 周报', '', '## 进展', '', '- 完成 A', '- 完成 B', '- 完成 C', '', '## 风险', '', '有一个阻塞项。'].join('\n');

async function waitFor(fn, timeout = 6000, interval = 150) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-diff-',
    files: {
      'proj/report.md': V1,
      'proj/other.md': '# 另一篇\n\n内容。\n',
      'proj/page.html': '<!doctype html><html><body><h1>标题</h1><p>正文</p></body></html>',
    },
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const api = (p, init) => page.evaluate(async ({ p, init }) => {
    const r = await fetch(p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { p, init });

  const reportPath = atlas.filePath('proj/report.md');
  const versionsDir = path.join(atlas.homeDir, 'versions');

  // ---- ① 无底本时的提示 ----
  console.log('\n[还没有底本]');
  let d = await api('/api/diff?path=' + encodeURIComponent(reportPath));
  check('无底本时 hasBaseline=false', d.body.hasBaseline, false);
  check('无底本时给出 reason', d.body.reason, 'no-baseline');
  check('无底本时有解释文案', typeof d.body.message === 'string' && d.body.message.length > 0, true);

  // ---- ② 打开文档 → 记录底本 ----
  console.log('\n[打开即记录底本]');
  await api('/api/seen', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: reportPath }),
  });
  check('versions 目录已创建', fs.existsSync(versionsDir), true);
  const snaps1 = fs.readdirSync(versionsDir);
  check('落下了一份底本', snaps1.length, 1);
  check('底本保留原扩展名', snaps1[0].endsWith('.md'), true);
  check('底本内容 = 打开时的内容',
    fs.readFileSync(path.join(versionsDir, snaps1[0]), 'utf8'), V1);

  let store = atlas.readStore();
  check('store 里登记了 seenVersions', !!store.seenVersions[reportPath], true);

  d = await api('/api/diff?path=' + encodeURIComponent(reportPath));
  check('刚记录完，对比结果是"无改动"', d.body.changed, false);
  check('hasBaseline=true', d.body.hasBaseline, true);
  check('带底本时间', typeof d.body.baselineAt, 'number');

  // 内容没变时重复打开不重复存
  await api('/api/seen', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: reportPath }),
  });
  check('内容相同不重复落底本', fs.readdirSync(versionsDir).length, 1);

  // ---- ③ 文件被改动 → 能看到差异 ----
  console.log('\n[文件被改动后对比]');
  await new Promise(r => setTimeout(r, 1100));
  fs.writeFileSync(reportPath, V2);
  await waitFor(async () => {
    const s = (await api('/api/state')).body;
    return s.files[reportPath] && s.files[reportPath].unread;
  });

  d = await api('/api/diff?path=' + encodeURIComponent(reportPath));
  check('检测到改动', d.body.changed, true);
  check('新增 2 行', d.body.added, 2);
  check('删除 1 行', d.body.removed, 1);
  const allLines = d.body.hunks.flatMap(h => h.lines);
  check('新增内容包含"- 完成 C"',
    allLines.some(l => l.type === 'add' && l.text === '- 完成 C'), true);
  check('新增内容包含新的风险描述',
    allLines.some(l => l.type === 'add' && l.text === '有一个阻塞项。'), true);
  check('删除内容包含旧的"暂无。"',
    allLines.some(l => l.type === 'del' && l.text === '暂无。'), true);
  check('行号信息齐全',
    allLines.every(l => (l.type === 'add' ? l.newLine > 0 : l.type === 'del' ? l.oldLine > 0 : true)), true);

  // 上下文行数生效
  const d0 = await api('/api/diff?path=' + encodeURIComponent(reportPath) + '&context=0');
  const ctx0Lines = d0.body.hunks.flatMap(h => h.lines);
  check('context=0 时只有增删行', ctx0Lines.every(l => l.type !== 'eq'), true);
  const d8 = await api('/api/diff?path=' + encodeURIComponent(reportPath) + '&context=8');
  check('context=8 时带上了未改动的上下文',
    d8.body.hunks.flatMap(h => h.lines).some(l => l.type === 'eq'), true);

  // ---- ④ accept：把当前内容设为新底本 ----
  console.log('\n[标记为已看过]');
  const acc = await api('/api/diff/accept', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: reportPath }),
  });
  check('accept 成功', acc.body.ok, true);
  check('accept 后落了第二份底本', fs.readdirSync(versionsDir).length, 2);
  d = await api('/api/diff?path=' + encodeURIComponent(reportPath));
  check('accept 后对比结果变为"无改动"', d.body.changed, false);

  // ---- ⑤ 每文件底本数量上限 ----
  console.log('\n[底本数量上限]');
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 30));
    fs.writeFileSync(reportPath, V2 + '\n\n补充 ' + i + '\n');
    await api('/api/diff/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: reportPath }),
    });
  }
  const snapsMany = fs.readdirSync(versionsDir);
  check('同一文件的底本不超过 5 份', snapsMany.length <= 5, true);

  // ---- ⑥ 重命名后底本迁移 ----
  console.log('\n[重命名后底本迁移]');
  const renamed = await api('/api/rename', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: reportPath, name: 'weekly.md' }),
  });
  const newPath = renamed.body.path;
  store = atlas.readStore();
  check('seenVersions 挂到了新路径', !!store.seenVersions[newPath], true);
  check('旧路径的登记已清除', !!store.seenVersions[reportPath], false);
  d = await api('/api/diff?path=' + encodeURIComponent(newPath));
  check('重命名后仍能对比', d.body.hasBaseline, true);

  // ---- ⑦ 删除文件后清理底本 ----
  console.log('\n[删除文件后清理]');
  await api('/api/seen', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: atlas.filePath('proj/other.md') }),
  });
  const beforeUnlink = fs.readdirSync(versionsDir).length;
  check('other.md 也有了底本', beforeUnlink > 0, true);
  fs.unlinkSync(atlas.filePath('proj/other.md'));
  const cleaned = await waitFor(() => {
    const st = atlas.readStore();
    return !st.seenVersions[atlas.filePath('proj/other.md')];
  });
  check('删除文件后 seenVersions 登记被清掉', cleaned, true);

  // ---- ⑧ 路径校验 ----
  console.log('\n[路径校验]');
  const bad = await api('/api/diff?path=' + encodeURIComponent('/etc/passwd'));
  check('扫描根外的路径被拒', bad.status, 400);

  // ---- ⑨ 前端交互 ----
  console.log('\n[前端交互]');
  await page.reload();
  await page.waitForSelector('.file');
  // 没选文件时按钮禁用
  check('未选文件时对比按钮禁用',
    await page.evaluate(() => document.getElementById('btn-diff').disabled), true);

  // 打开 page.html（还没有底本）
  await page.click('.file[data-path$="page.html"] .file-name');
  await page.waitForTimeout(900);
  check('打开后按钮可用（openFile 已记录底本）',
    await page.evaluate(() => document.getElementById('btn-diff').disabled), false);

  // 改动它，再看差异面板
  const htmlPath = atlas.filePath('proj/page.html');
  await new Promise(r => setTimeout(r, 1100));
  fs.writeFileSync(htmlPath,
    '<!doctype html><html><body><h1>标题改了</h1><p>正文</p><p>新增段落</p></body></html>');
  await page.waitForTimeout(1400);
  await page.click('#btn-diff');
  await page.waitForSelector('#diff-panel:not(.hidden)');
  await page.waitForFunction(() => {
    const s = document.getElementById('diff-stats').textContent || '';
    return s.includes('+') || s.includes('一致');
  }, { timeout: 6000 });
  check('面板显示出来了', await page.isVisible('#diff-panel'), true);
  const statsText = await page.evaluate(() => document.getElementById('diff-stats').textContent);
  check('统计里有新增计数', /\+\d/.test(statsText), true);
  const rendered = await page.evaluate(() => ({
    addRows: document.querySelectorAll('#diff-body .diff-line.add').length,
    delRows: document.querySelectorAll('#diff-body .diff-line.del').length,
    hasGutter: !!document.querySelector('#diff-body .diff-gutter'),
  }));
  check('渲染出新增行', rendered.addRows > 0, true);
  check('渲染出删除行', rendered.delRows > 0, true);
  check('带行号槽', rendered.hasGutter, true);

  // 「标记为已看过」
  await page.click('#diff-accept');
  await page.waitForFunction(
    () => (document.getElementById('diff-stats').textContent || '').includes('一致')
      || document.querySelector('#diff-body .diff-empty'),
    { timeout: 6000 },
  );
  check('accept 后面板显示"完全一致"',
    await page.evaluate(() => !!document.querySelector('#diff-body .diff-empty')), true);

  // 切到别的文件 → 面板自动关闭
  await page.click('.file[data-path$="weekly.md"] .file-name');
  await page.waitForTimeout(900);
  check('切换文件后对比面板自动关闭', await page.isHidden('#diff-panel'), true);

  // 编辑态互斥
  await page.click('#btn-edit');
  await page.waitForSelector('#md-editor:not(.hidden)');
  check('编辑态下对比按钮禁用',
    await page.evaluate(() => document.getElementById('btn-diff').disabled), true);
  await page.evaluate(() => document.getElementById('btn-edit-cancel').click());
  await page.waitForTimeout(400);
  if (await page.$('.atlas-dialog')) await page.click('.atlas-dialog .dialog-confirm');
  await page.waitForTimeout(500);
  check('退出编辑后对比按钮恢复可用',
    await page.evaluate(() => document.getElementById('btn-diff').disabled), false);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
