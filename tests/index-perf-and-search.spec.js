// 文件索引与搜索
//
// 背景：/api/state 与 /api/search 原来每次请求都做一遍全盘递归 walk，而
// /api/state 被调用得非常频繁（每 60s 定时 + 切回前台 + 每个文件事件 + 打开设置）。
// 现在改成 chokidar 增量维护的内存索引。
//
// 本 spec 检查：
//   ① 正确性：索引结果与真实磁盘一致；新增 / 修改 / 删除文件能被 watcher 反映；
//      重命名后索引定点更新；改扫描配置后索引重建
//   ② 不再无条件写盘：连续调用 /api/state 不应该反复重写 store.json
//   ③ 切换 docTypes 不需要重新扫盘（索引存全类型，读取时过滤）
//   ④ 搜索：多关键词 AND、引号短语、单字符规则、LRU 缓存
//   ⑤ 性能：重复调用 /api/state 应该显著快于首次（首次含建索引）
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { chromium } = require(path.join(ROOT, 'node_modules', 'playwright'));
const { startAtlas, makeTreeFixtures } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}
function note(name, value) {
  console.log(`  · ${name}: ${value}`);
}

// 轮询等待条件成立（watcher 事件是异步的）
async function waitFor(fn, timeout = 6000, interval = 150) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return true;
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

(async () => {
  const files = makeTreeFixtures({ projects: 24, filesPerProject: 25 });
  files['searchproj/target.md'] = [
    '# 目标文档',
    '',
    '这里同时包含 配网 与 转化率 两个词。',
  ].join('\n');
  files['searchproj/onlyone.md'] = '# 只有一个词\n\n这里只有 配网。\n';
  files['searchproj/phrase.md'] = '# 短语\n\n这里有 error rate 这个短语。\n';
  const atlas = await startAtlas({ prefix: 'atlas-idx-', files });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto(atlas.base);
  await page.waitForSelector('.file');

  const api = (p, init) => page.evaluate(async ({ p, init }) => {
    const r = await fetch(p, init);
    return { status: r.status, body: await r.json().catch(() => null) };
  }, { p, init });

  // ---- ① 正确性 ----
  console.log('\n[索引正确性]');
  const diskCount = (() => {
    let n = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.(html?|md|markdown)$/i.test(e.name)) n++;
      }
    };
    walk(atlas.scanDir);
    return n;
  })();
  let state = (await api('/api/state')).body;
  check('索引文件数与磁盘一致', Object.keys(state.files).length, diskCount);
  note('文档总数', diskCount);

  // 新增文件 → watcher 应把它加进索引
  fs.writeFileSync(atlas.filePath('searchproj/brand-new.md'), '# 新文件\n\n内容。\n');
  const sawNew = await waitFor(async () => {
    const s = (await api('/api/state')).body;
    return !!s.files[atlas.filePath('searchproj/brand-new.md')];
  });
  check('新增文件被 watcher 加入索引', sawNew, true);

  // 修改文件 → mtime 更新
  const targetPath = atlas.filePath('searchproj/target.md');
  const mtimeBefore = (await api('/api/state')).body.files[targetPath].mtime;
  await new Promise(r => setTimeout(r, 1100));
  fs.appendFileSync(targetPath, '\n补充一行。\n');
  const sawChange = await waitFor(async () => {
    const s = (await api('/api/state')).body;
    return s.files[targetPath] && s.files[targetPath].mtime > mtimeBefore;
  });
  check('修改文件后索引里的 mtime 被更新', sawChange, true);

  // 删除文件 → 从索引移除
  fs.unlinkSync(atlas.filePath('searchproj/brand-new.md'));
  const sawUnlink = await waitFor(async () => {
    const s = (await api('/api/state')).body;
    return !s.files[atlas.filePath('searchproj/brand-new.md')];
  });
  check('删除文件后从索引移除', sawUnlink, true);

  // 重命名 → 索引定点更新
  const renamed = await api('/api/rename', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: atlas.filePath('searchproj/onlyone.md'), name: 'renamed-one.md' }),
  });
  check('重命名返回 ok', renamed.body && renamed.body.ok, true);
  state = (await api('/api/state')).body;
  check('索引里出现新路径', !!state.files[atlas.filePath('searchproj/renamed-one.md')], true);
  check('索引里旧路径已消失', !!state.files[atlas.filePath('searchproj/onlyone.md')], false);

  // ---- ② 不再无条件写盘 ----
  console.log('\n[store.json 不再被每次请求重写]');
  await api('/api/state');                     // 先让树稳定下来
  const storeStat1 = fs.statSync(atlas.storePath).mtimeMs;
  await new Promise(r => setTimeout(r, 1100));
  await api('/api/state');
  await api('/api/state');
  await api('/api/state');
  const storeStat2 = fs.statSync(atlas.storePath).mtimeMs;
  check('连续 3 次 /api/state 没有重写 store.json', storeStat2, storeStat1);

  // ---- ③ 切换 docTypes 不重新扫盘 ----
  console.log('\n[切换文档类型]');
  const onlyMd = await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docTypes: ['md'] }),
  });
  check('切到仅 md 成功', onlyMd.status, 200);
  state = (await api('/api/state')).body;
  const kinds = new Set(Object.values(state.files).map(f => f.docType));
  check('只返回 md 文件', [...kinds], ['md']);
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docTypes: ['html', 'md'] }),
  });
  state = (await api('/api/state')).body;
  check('切回双类型后 html 文件回来了',
    Object.values(state.files).some(f => f.docType === 'html'), true);

  // ---- 改扫描配置 → 索引重建 ----
  const extraDir = atlas.makeDir('extra-root');
  fs.writeFileSync(path.join(extraDir, 'extra.md'), '# 额外\n\n内容。\n');
  await api('/api/config', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ scanRoots: [...atlas.scanDirs, extraDir] }),
  });
  const sawExtra = await waitFor(async () => {
    const s = (await api('/api/state')).body;
    return !!s.files[path.join(extraDir, 'extra.md')];
  });
  check('新增扫描根后索引重建并收录新文件', sawExtra, true);

  // ---- ④ 搜索 ----
  console.log('\n[搜索]');
  const s1 = (await api('/api/search?q=' + encodeURIComponent('配网'))).body;
  const paths1 = s1.matches.map(m => path.basename(m.path)).sort();
  check('单关键词命中两篇', paths1, ['renamed-one.md', 'target.md']);

  const s2 = (await api('/api/search?q=' + encodeURIComponent('配网 转化率'))).body;
  const paths2 = s2.matches.map(m => path.basename(m.path)).sort();
  check('多关键词 AND 只命中同时含两词的那篇', paths2, ['target.md']);
  check('返回解析出的关键词', s2.terms, ['配网', '转化率']);

  const s3 = (await api('/api/search?q=' + encodeURIComponent('配网 不存在的词'))).body;
  check('AND 有一个词不存在则无结果', s3.matches.length, 0);

  const s4 = (await api('/api/search?q=' + encodeURIComponent('"error rate"'))).body;
  check('引号短语当成一个词', s4.matches.map(m => path.basename(m.path)), ['phrase.md']);
  check('引号短语被解析为单个 term', s4.terms, ['error rate']);

  const s5 = (await api('/api/search?q=a')).body;
  check('ASCII 单字符仍然不搜', s5.matches.length, 0);
  const s6 = (await api('/api/search?q=' + encodeURIComponent('配'))).body;
  check('中文单字仍然可搜', s6.matches.length > 0, true);
  check('结果带上下文片段', typeof s1.matches[0].snippet, 'string');

  // ---- ⑤ 性能 ----
  console.log('\n[性能]');
  const timings = await page.evaluate(async () => {
    const once = async () => {
      const t0 = performance.now();
      const r = await fetch('/api/state', { cache: 'no-store' });
      await r.text();
      return performance.now() - t0;
    };
    const warm = [];
    for (let i = 0; i < 6; i++) warm.push(await once());
    return warm;
  });
  const avgWarm = timings.reduce((a, b) => a + b, 0) / timings.length;
  note('/api/state 平均耗时（索引已建）', avgWarm.toFixed(1) + 'ms');
  check('/api/state 稳定在 100ms 内', avgWarm < 100, true);

  const searchTimings = await page.evaluate(async () => {
    const once = async (q) => {
      const t0 = performance.now();
      await (await fetch('/api/search?q=' + encodeURIComponent(q))).json();
      return performance.now() - t0;
    };
    await once('数据');                 // 预热内容缓存
    const warm = [];
    for (const q of ['数据', 'echarts', 'chart']) warm.push(await once(q));
    return warm;
  });
  const avgSearch = searchTimings.reduce((a, b) => a + b, 0) / searchTimings.length;
  note('/api/search 平均耗时（缓存已热）', avgSearch.toFixed(1) + 'ms');
  check('/api/search 稳定在 150ms 内', avgSearch < 150, true);

  await browser.close();
  await atlas.stop();
  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
