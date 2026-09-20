// 超大扫描根护栏（阶段 1 收尾）
//
// 背景：目录树懒渲染把"大部分分组折叠"的常态压住了，但代码再优也扛不住"扫描根 =
// 整块磁盘"。两道护栏承认这个极端并明确降级：
//   ① 索引总文件数硬上限（MAX_INDEX_FILES）——撞上限即停止收录，/api/state 用
//      indexTruncated 明示，前端据此弹一次提示 + 底栏常驻「已达上限」标记。
//   ② /api/estimate-scan——添加扫描根前快速估算目录体量，很大就先让用户确认。
//
// 本 spec 用 ATLAS_MAX_INDEX_FILES 把上限调到很小来验证截断，无需真造几万个文件。
const path = require('path');
const { startAtlas, makeTreeFixtures } = require('./helpers/isolated-atlas');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

const api = async (base, p) => {
  const r = await fetch(base + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};

(async () => {
  // ---- ① 默认上限：不截断，/api/state 带齐护栏字段 ----
  console.log('\n[① 正常规模：不截断]');
  delete process.env.ATLAS_MAX_INDEX_FILES;   // 用默认 50000
  const normal = await startAtlas({
    prefix: 'atlas-guardrail-normal-',
    files: makeTreeFixtures({ projects: 2, filesPerProject: 6 }),   // 12 篇
  });
  const nState = (await api(normal.base, '/api/state')).body;
  check('未截断时 indexTruncated=false', nState.indexTruncated, false);
  check('indexCount 等于收录到的文件数', nState.indexCount, Object.keys(nState.files).length);
  check('maxIndexFiles 是默认 50000', nState.maxIndexFiles, 50000);

  // ---- 估算端点 ----
  console.log('\n[估算端点 /api/estimate-scan]');
  const est = (await api(normal.base, '/api/estimate-scan?path=' + encodeURIComponent(normal.scanDir))).body;
  check('估算数出全部 12 篇文档', est.count, 12);
  check('规模不大时 capped=false', est.capped, false);
  const estMissing = await api(normal.base, '/api/estimate-scan');
  check('缺 path 参数 → 400', estMissing.status, 400);
  const estBad = await api(normal.base, '/api/estimate-scan?path=' + encodeURIComponent(normal.scanDir + '/__nope__'));
  check('路径不存在 → 404', estBad.status, 404);
  const estFile = await api(normal.base, '/api/estimate-scan?path='
    + encodeURIComponent(normal.filePath('proj-01/doc-01.html')));
  check('指向文件而非目录 → 400', estFile.status, 400);
  await normal.stop();

  // ---- ② 小上限：截断并如实上报 ----
  console.log('\n[② 撞上限：停止收录 + 明示]');
  process.env.ATLAS_MAX_INDEX_FILES = '5';    // 人为把上限压到 5
  const capped = await startAtlas({
    prefix: 'atlas-guardrail-capped-',
    files: makeTreeFixtures({ projects: 2, filesPerProject: 6 }),   // 12 篇 > 5
  });
  const cState = (await api(capped.base, '/api/state')).body;
  console.log('  indexCount:', cState.indexCount, ' indexTruncated:', cState.indexTruncated);
  check('撞上限时 indexTruncated=true', cState.indexTruncated, true);
  check('maxIndexFiles 反映被覆盖的上限 5', cState.maxIndexFiles, 5);
  check('收录数不超过上限', cState.indexCount <= 5, true);
  check('确实截断了（收录数 < 磁盘上的 12 篇）', cState.indexCount < 12, true);
  check('返回给前端的 files 也不超过上限', Object.keys(cState.files).length <= 5, true);

  // 估算端点不受索引上限影响，仍报真实体量（它有自己的 CAP=20000）
  const est2 = (await api(capped.base, '/api/estimate-scan?path=' + encodeURIComponent(capped.scanDir))).body;
  check('估算仍报出真实的 12 篇（不被索引上限截断）', est2.count, 12);
  await capped.stop();
  delete process.env.ATLAS_MAX_INDEX_FILES;

  console.log(`\n========================`);
  console.log(`总计 ${failures === 0 ? '全部通过' : failures + ' 项未通过'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
