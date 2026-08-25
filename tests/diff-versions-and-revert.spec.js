//
// 两件同源的事：
//
//   ① 「和上次已读版本对比」会误报：文档被重新写过之后顶栏提示有改动，点开却说
//      "和你上次看到的内容完全一致"。根因是两条判据从来没对过账 —— 未读/有改动
//      看的是 mtime，差异看的是内容。AI 用相同内容重新生成一遍文档（或 touch、
//      网盘同步）会让 mtime 前进但内容没变，于是提示亮起、diff 为空。
//      现在服务端补了一次内容核对（baselineSame），顶栏提示以它为准。
//
//   ② 底本只留一份带来的设计缺陷：打开文档时会刷新底本，可"打开文档"恰恰是用户
//      想去看变更的那个动作 —— 基准被这个动作自己刷掉，之后点对比永远是空的。
//      现在保留最近几份，并且默认自动挑「第一个内容不同于当前的版本」来比，
//      面板里还能挑具体版本、回退到那一版。
//
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
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

const get = async (base, url) => (await fetch(base + url)).json();
const post = async (base, url, body) => {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
// 动过磁盘之后等 chokidar 的 awaitWriteFinish（300ms 稳定期）把变化收进索引
const settle = (ms = 900) => new Promise(r => setTimeout(r, ms));

const V1 = '# 报告\n\n第一版内容。\n';
const V2 = '# 报告\n\n第二版内容，改了这一行。\n';
const V3 = '# 报告\n\n第三版内容。\n\n还多了一段。\n';

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-diff-ver-',
    files: { 'proj/report.md': V1 },
  });
  const target = atlas.filePath('proj/report.md');
  const fileState = async () => (await get(atlas.base, '/api/state')).files[target];

  // ================================================================
  console.log('\n[① 同内容重写不该报"有改动"]');

  await post(atlas.base, '/api/seen', { path: target });   // 打开一次 → 记下底本
  let f = await fileState();
  check('已有底本', f.hasBaseline, true);

  // 用完全相同的内容重写：mtime 前进，内容没变
  await settle(300);
  fs.writeFileSync(target, V1);
  await settle();
  f = await fileState();
  check('mtime 确实前进了（未读判定仍按 mtime）', f.mtime > f.baselineAt, true);
  check('但内容核对判定为"和底本相同"', f.baselineSame, true);

  // 顶栏那个提示的判据：mtime 更新 且 内容真的不同
  const wouldWarn = (x) => !!(x.hasBaseline && x.baselineAt && x.mtime > x.baselineAt && !x.baselineSame);
  check('所以顶栏不会亮"有改动"（假警报消失）', wouldWarn(f), false);

  let diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('对比结果确实是无变更', diff.changed, false);

  // ================================================================
  console.log('\n[② 内容真的变了才报"有改动"]');
  fs.writeFileSync(target, V2);
  await settle();
  f = await fileState();
  check('内容核对判定为"和底本不同"', f.baselineSame, false);
  check('顶栏会亮"有改动"', wouldWarn(f), true);

  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('对比有变更', diff.changed, true);
  check('能看出增删行数', [diff.added > 0, diff.removed > 0], [true, true]);

  // ================================================================
  console.log('\n[③ 打开文档不再吃掉想看的那次差异]');
  // 这是原来最伤的一条：openFile 会 POST /api/seen 刷新底本，而底本只有一份，
  // 于是"打开文档去看变更"这个动作把基准刷成了改后的内容，再点对比就是空的。
  await post(atlas.base, '/api/seen', { path: target });   // 相当于用户打开了它
  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('打开之后仍然能看到那次变更', diff.changed, true);
  check('留存了两份版本', diff.versions.length, 2);
  check('自动选的底本不是"与当前相同"的那份',
    diff.versions.find(v => v.file === diff.version).isCurrent, false);

  // ================================================================
  console.log('\n[④ 版本历史：内容变化才追加，重复打开不追加]');
  const before = (await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target))).versions.length;
  await post(atlas.base, '/api/seen', { path: target });
  await post(atlas.base, '/api/seen', { path: target });
  const after = (await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target))).versions.length;
  check('反复打开不产生新版本', after, before);

  fs.writeFileSync(target, V3);
  await settle();
  await post(atlas.base, '/api/seen', { path: target });
  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('内容变化后版本数增加', diff.versions.length, 3);
  check('版本按时间倒序（最近的在最前）',
    diff.versions.every((v, i, arr) => i === 0 || v.at <= arr[i - 1].at), true);

  // ================================================================
  console.log('\n[⑤ 指定版本对比]');
  const versions = diff.versions;
  const oldest = versions[versions.length - 1];
  const byOldest = await get(atlas.base,
    '/api/diff?path=' + encodeURIComponent(target) + '&version=' + encodeURIComponent(oldest.file));
  check('和最早那一版比也能出差异', byOldest.changed, true);
  check('返回的 version 就是指定的那个', byOldest.version, oldest.file);
  const bogus = await fetch(atlas.base
    + '/api/diff?path=' + encodeURIComponent(target) + '&version=不存在的快照.md');
  check('指定不存在的版本 → 404', bogus.status, 404);

  // ================================================================
  console.log('\n[⑥ 回退]');
  check('回退缺 version → 400', (await post(atlas.base, '/api/revert', { path: target })).status, 400);
  check('回退路径非法 → 400',
    (await post(atlas.base, '/api/revert', { path: '/etc/passwd', version: oldest.file })).status, 400);
  check('回退到不存在的版本 → 404',
    (await post(atlas.base, '/api/revert', { path: target, version: '没有这个.md' })).status, 404);

  const rv = await post(atlas.base, '/api/revert', { path: target, version: oldest.file });
  check('回退成功', rv.status, 200);
  check('磁盘内容已变回第一版', fs.readFileSync(target, 'utf8'), V1);
  check('回退前的内容有备份', typeof rv.body.backup === 'string' && rv.body.backup.length > 0, true);
  const backupContent = fs.readFileSync(rv.body.backup, 'utf8');
  check('备份里是回退前的内容', backupContent, V3);

  await settle();
  f = await fileState();
  check('回退后不是未读（自我写入不该标红点）', f.unread, false);
  check('回退后顶栏不报"有改动"（内容与最新底本一致）', wouldWarn(f), false);
  check('内容核对确认与最新底本相同', f.baselineSame, true);
  // 回退是用户主动做的改动，底本记为 ack —— 之后点对比应该是干净的，
  // 不该把用户自己刚撤销的那些内容当成"别人的变更"摆给他看
  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('回退后默认对比即无变更', diff.changed, false);
  check('仍然能显式挑更早的版本来比',
    (await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target)
      + '&version=' + encodeURIComponent(versions[1].file))).changed, true);

  // ================================================================
  console.log('\n[⑦ 站内编辑保存后，不该把自己的改动算成"变更"]');
  // save-md 原来只刷 seen 不刷底本，于是用户保存完再点对比，看到的是自己刚写的
  // 那些行被当成"别人动的"
  const edited = '# 报告\n\n我自己在 Atlas 里改的内容。\n';
  const saveRes = await post(atlas.base, '/api/save-md', {
    path: target, content: edited, baseHash: null,
  });
  if (saveRes.status !== 200) {
    // 该接口可能要求内容哈希做冲突检测，拿一次当前哈希重试
    const cur = await get(atlas.base, '/api/read-md?path=' + encodeURIComponent(target)).catch(() => null);
    if (cur && cur.hash) {
      await post(atlas.base, '/api/save-md', { path: target, content: edited, baseHash: cur.hash });
    }
  }
  await settle();
  const savedOk = fs.readFileSync(target, 'utf8') === edited;
  check('内容已保存', savedOk, true);
  if (savedOk) {
    f = await fileState();
    check('保存后顶栏不报"有改动"', wouldWarn(f), false);
    check('内容核对确认与最新底本相同', f.baselineSame, true);
    // 同回退：站内保存也是用户主动的改动，底本记为 ack，对比面板保持干净
    diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
    check('保存后默认对比即无变更', diff.changed, false);
  }

  // ================================================================
  console.log('\n[⑧ ack 的分界：自动记的底本 vs 用户确认过的底本]');
  // 这是整个选版逻辑的核心区分，两个方向都要成立
  fs.writeFileSync(target, '# 报告\n\nAI 又改了一版。\n');
  await settle();
  await post(atlas.base, '/api/seen', { path: target });    // 打开文档：自动记，非 ack
  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('打开文档后仍能看到 AI 的改动（自动记的底本不当基准）', diff.changed, true);

  await post(atlas.base, '/api/diff/accept', { path: target });   // 明确标记看过
  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('点了「标记为已看过」之后就干净了', diff.changed, false);

  fs.writeFileSync(target, '# 报告\n\nAI 第三次改动。\n');
  await settle();
  await post(atlas.base, '/api/seen', { path: target });
  diff = await get(atlas.base, '/api/diff?path=' + encodeURIComponent(target));
  check('之后的新改动又能看到了', diff.changed, true);

  await atlas.stop();
  console.log(`\n总计 ${total} 项，${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
