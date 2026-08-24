// 回归测试：SSE 连接泄漏 + fetchState 无限挂起
//
// 背景（真实故障）：
//   connectSSE 的 onerror 每次都排一个 3s 后的 connectSSE，多个 timer 各建一条
//   EventSource，而 connectSSE 只 close 得到 evtSrc 这一个引用，其余实例丢引用却
//   仍占着连接。浏览器对同源 HTTP/1.1 只给 6 个连接，泄漏满 6 条后整页所有请求
//   （预览 iframe、/api/state）永久排队 —— 表现为"点文档打不开 + 刷新按钮一直转"。
//
//   同时 fetchState 的 fetch 没有超时，连接池满时它永久 pending，finally 不执行，
//   刷新按钮永远停在 scanning 状态，且页面再也不会自己恢复。
//
// 自起隔离 Atlas 实例（独立 ATLAS_HOME + 临时扫描根 + 随机端口），
// 不依赖用户本机跑着的服务，也不读写用户真实 config/store。

const { chromium } = require('playwright');
const { startAtlas } = require('./helpers/isolated-atlas');

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

// EventSource.CLOSED === 2；非 CLOSED（CONNECTING=0 / OPEN=1）即仍占用连接
const activeCountExpr = () => window.__es.instances.filter(i => i.readyState !== 2).length;

(async () => {
  const atlas = await startAtlas({
    prefix: 'atlas-sse-spec-',
    files: {
      'proj/index.html': '<!doctype html><html><body><h1>fixture</h1></body></html>',
      'proj/notes.md': '# 笔记\n\n内容\n',
    },
  });
  console.log('实例:', atlas.base);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  // 必须在页面脚本执行前 hook，才能拦到 connectSSE 建的第一条连接
  await page.addInitScript(() => {
    const Orig = window.EventSource;
    window.__es = { opened: 0, closed: 0, instances: [] };
    const Hooked = function (url, cfg) {
      const inst = new Orig(url, cfg);
      window.__es.opened++;
      window.__es.instances.push(inst);
      const origClose = inst.close.bind(inst);
      inst.close = function () { window.__es.closed++; return origClose(); };
      return inst;
    };
    Hooked.prototype = Orig.prototype;
    Hooked.CONNECTING = 0; Hooked.OPEN = 1; Hooked.CLOSED = 2;
    window.EventSource = Hooked;
  });

  await page.goto(atlas.base, { waitUntil: 'load' });
  await page.waitForSelector('.file');

  // ========== 1. 稳态：只应有一条 SSE ==========
  console.log('\n[1] 稳态下只持有一条 SSE 连接');
  await page.waitForTimeout(1000);
  const base = await page.evaluate(() => ({
    opened: window.__es.opened,
    closed: window.__es.closed,
    active: window.__es.instances.filter(i => i.readyState !== 2).length,
  }));
  console.log(`  opened=${base.opened} closed=${base.closed} active=${base.active}`);
  check('页面加载后活跃 EventSource 恰好 1 条', base.active === 1, `active=${base.active}`);

  // ========== 2. 断连风暴：并发 onerror 不得各建一条连接 ==========
  // 这是泄漏的直接触发路径：服务重启时所有页面同时收到 error，
  // 旧代码每个 error 排一个 timer，timer 各自 new EventSource 且互相覆盖引用。
  console.log('\n[2] 连续 error 风暴后不应累积连接（核心回归点）');
  await page.evaluate(() => {
    // 对当前所有未关闭实例连打 6 次 error，模拟"服务反复重启"
    for (let round = 0; round < 6; round++) {
      window.__es.instances
        .filter(i => i.readyState !== 2)
        .forEach(i => i.dispatchEvent(new Event('error')));
    }
  });
  // 等足重连排程（修复后是单一 3s timer；旧代码这里会冒出多条）
  await page.waitForTimeout(5000);
  const storm = await page.evaluate(() => ({
    opened: window.__es.opened,
    closed: window.__es.closed,
    active: window.__es.instances.filter(i => i.readyState !== 2).length,
  }));
  console.log(`  opened=${storm.opened} closed=${storm.closed} active=${storm.active}`);
  check('error 风暴后活跃 EventSource 仍 ≤ 1（无泄漏）',
    storm.active <= 1, `active=${storm.active}`);
  check('风暴中新建的实例都被 close 掉了（opened - closed ≤ 1）',
    storm.opened - storm.closed <= 1,
    `opened=${storm.opened}, closed=${storm.closed}, 差=${storm.opened - storm.closed}`);

  // 再等一轮，确认重连最终恢复（不是靠"永久不连"来通过上面的断言）
  await page.waitForTimeout(4000);
  const healed = await page.evaluate(activeCountExpr);
  check('重连最终恢复：仍保有 1 条活跃 SSE', healed === 1, `active=${healed}`);

  // ========== 3. 反向验证：泄漏真的会被这个测试抓到 ==========
  // 故意模拟旧代码的行为（每个 error 各建一条、不 close 旧的），
  // 确认上面的断言不是"永远为真"的空断言。
  console.log('\n[3] 反向验证：旧的泄漏写法应当被判为失败');
  const leaked = await page.evaluate(async () => {
    const junk = [];
    for (let i = 0; i < 4; i++) junk.push(new EventSource('/api/events'));
    await new Promise(r => setTimeout(r, 800));
    const active = window.__es.instances.filter(i => i.readyState !== 2).length;
    junk.forEach(e => { try { e.close(); } catch {} });   // 立刻收拾干净，别占着连接
    return active;
  });
  check('刻意泄漏 4 条时，活跃数确实 > 1（说明断言有效）',
    leaked > 1, `active=${leaked}`);
  await page.waitForTimeout(500);
  const afterCleanup = await page.evaluate(activeCountExpr);
  check('清理后回到 1 条', afterCleanup <= 1, `active=${afterCleanup}`);

  // ========== 4. /api/state 挂起时必须超时，不能永久 scanning ==========
  // 覆盖 STATE_TIMEOUT_MS 那条分支：让请求既不响应也不失败，正是连接池被占满时的形态。
  console.log('\n[4] /api/state 永久挂起 → 应超时中止并排重试');
  let hangCount = 0;
  await page.route('**/api/state', async () => { hangCount++; /* 故意不 fulfill / 不 abort */ });
  await page.evaluate(() => { fetchState(); });   // 不 await：它要挂 15s
  await page.waitForTimeout(2000);
  const during = await page.evaluate(() => ({
    scanning: document.getElementById('btn-refresh').classList.contains('scanning'),
  }));
  check('挂起期间刷新按钮处于 scanning（符合预期）', during.scanning === true, `scanning=${during.scanning}`);

  // 等过 15s 超时线。用轮询而非单点采样：退避重试之间会短暂再次发请求，
  // 断言的是"最终不会一直转"，不是"某一瞬间恰好不在转"。
  let sawIdle = false;
  for (let i = 0; i < 40 && !sawIdle; i++) {
    await page.waitForTimeout(1000);
    sawIdle = await page.evaluate(() =>
      !document.getElementById('btn-refresh').classList.contains('scanning'));
  }
  const timedOut = await page.evaluate(() => ({
    scanning: document.getElementById('btn-refresh').classList.contains('scanning'),
    stats: document.getElementById('stats').textContent,
  }));
  console.log(`  stats="${timedOut.stats}"`);
  check('超时后刷新按钮不再卡在 scanning', sawIdle, `scanning=${timedOut.scanning}`);
  check('超时后给出可见提示（含"超时"或"重试"）',
    /超时|重试/.test(timedOut.stats), `stats="${timedOut.stats}"`);
  check('请求确实被发出过', hangCount >= 1, `拦到 ${hangCount} 次`);

  // ========== 5. 恢复可用后应自动重试成功，无需手动刷新 ==========
  console.log('\n[5] 后端恢复后自动重试并恢复数据');
  await page.unroute('**/api/state');
  // 退避此时是 2s 起，给足两轮
  await page.waitForTimeout(8000);
  const recovered = await page.evaluate(() => ({
    stats: document.getElementById('stats').textContent,
    scanning: document.getElementById('btn-refresh').classList.contains('scanning'),
    files: Object.keys(window.state?.files || {}).length,
  }));
  console.log(`  stats="${recovered.stats}"`);
  check('自动重试成功：统计恢复为"N 篇文档"格式（不再是错误提示）',
    /^\d+ 篇文档/.test(recovered.stats), `stats="${recovered.stats}"`);
  check('恢复后未残留 scanning 状态', recovered.scanning === false, `scanning=${recovered.scanning}`);

  // ========== 6. 全流程结束后连接数仍然干净 ==========
  console.log('\n[6] 全流程结束后连接数仍干净');
  const final = await page.evaluate(() => ({
    active: window.__es.instances.filter(i => i.readyState !== 2).length,
    opened: window.__es.opened,
    closed: window.__es.closed,
  }));
  console.log(`  opened=${final.opened} closed=${final.closed} active=${final.active}`);
  check('结束时活跃 EventSource ≤ 1', final.active <= 1, `active=${final.active}`);

  await browser.close();
  await atlas.stop();

  console.log('\n========================');
  const failed = checks.filter(c => !c.ok);
  console.log(`总计 ${checks.length} 项，失败 ${failed.length} 项`);
  if (failed.length) {
    console.log('失败列表：');
    failed.forEach(f => console.log(` - ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
    process.exit(1);
  }
})().catch(e => { console.error(e); process.exit(1); });
