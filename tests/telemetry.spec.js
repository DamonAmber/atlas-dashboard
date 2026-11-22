// 默认关闭、最少数据、前台事件、删除与跨实例竞态；全程隔离，不碰系统配置和真实用户统计。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const { telemetryDefaults } = require('../lib/init');
const { createTelemetry, ENDPOINT, testEndpoint } = require('../lib/telemetry');
const { startAtlas } = require('./helpers/isolated-atlas');
let total = 0;
function check(name, value, expected = true) { assert.deepStrictEqual(value, expected, name); total++; console.log(`✓ ${name}`); }
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-telemetry-unit-'));
  try {
    check('新安装默认开启但首次告知待确认', telemetryDefaults(), { telemetryEnabled: true, telemetryNoticePending: true });
    check('旧配置缺字段不被自动开启', telemetryDefaults({}), { telemetryEnabled: false, telemetryNoticePending: false });
    check('明确关闭的配置不被自动重开', telemetryDefaults({ telemetryEnabled: false }), { telemetryEnabled: false, telemetryNoticePending: false });
    check('已经开启的配置保持开启', telemetryDefaults({ telemetryEnabled: true }), { telemetryEnabled: true, telemetryNoticePending: false });
    const desktopDefaults = require('../electron/server-manager').defaultConfig();
    check('桌面首次创建使用同一默认策略', [desktopDefaults.telemetryEnabled, desktopDefaults.telemetryNoticePending], [true, true]);
    const initHome = path.join(tmp, 'cli-init'), initRoot = path.join(tmp, 'cli-docs'); fs.mkdirSync(initRoot);
    const initScript = `const prompts=require('prompts');prompts.inject([process.argv[1],4399,'node_modules,.git',4]);const fs=require('fs');const p=require('./lib/paths').configPath();const existing=fs.existsSync(p)?JSON.parse(fs.readFileSync(p)):null;require('./lib/init').runInit({existingConfig:existing}).then(c=>console.log(JSON.stringify({enabled:c.telemetryEnabled,pending:c.telemetryNoticePending})));`;
    const initEnv = { ...process.env, ATLAS_HOME: initHome };
    const first = execFileSync(process.execPath, ['-e', initScript, initRoot], { cwd: path.join(__dirname, '..'), env: initEnv, encoding: 'utf8' });
    check('CLI 首次创建默认开启且等待告知', JSON.parse(first.trim().split('\n').pop()), { enabled: true, pending: true });
    const saved = JSON.parse(fs.readFileSync(path.join(initHome, 'config.json'))); saved.telemetryEnabled = false; saved.telemetryNoticePending = false;
    fs.writeFileSync(path.join(initHome, 'config.json'), JSON.stringify(saved));
    const again = execFileSync(process.execPath, ['-e', initScript, initRoot], { cwd: path.join(__dirname, '..'), env: initEnv, encoding: 'utf8' });
    check('CLI 重配置保留已经关闭的状态', JSON.parse(again.trim().split('\n').pop()), { enabled: false, pending: false });
    let enabled = false, time = Date.UTC(2026, 10, 22, 12), calls = [];
    const fetchImpl = async (url, options) => { calls.push({ url, body: JSON.parse(options.body), options }); return { ok: true, json: async () => ({ ok: true, day: new Date(time).toISOString().slice(0, 10) }) }; };
    const options = { dir: path.join(tmp, 'state'), enabled: () => enabled, version: '0.33.0', platform: 'darwin', now: () => time, fetchImpl };
    const service = createTelemetry(options);
    await service.record({ channel: 'npm' });
    check('未同意时零外站请求', calls.length, 0);
    check('未同意时不创建身份或目录', fs.existsSync(options.dir), false);
    check('不可通过测试变量改成任意外站', testEndpoint({ ATLAS_HOME: tmp, ATLAS_TELEMETRY_TEST_URL: 'https://evil.test/' }), ENDPOINT);
    check('没有隔离 ATLAS_HOME 时不能覆写测试地址', testEndpoint({ ATLAS_TELEMETRY_TEST_URL: 'http://127.0.0.1:12345/' }), ENDPOINT);
    check('隔离本机测试地址可用', testEndpoint({ ATLAS_HOME: tmp, ATLAS_TELEMETRY_TEST_URL: 'http://127.0.0.1:12345/' }), 'http://127.0.0.1:12345');
    enabled = true;
    await Promise.all(Array.from({ length: 5 }, () => service.record({ channel: 'desktop', appVersion: '0.34.0' })));
    check('并行界面事件只上报一次', calls.length, 1);
    check('数据只含四个明确字段', Object.keys(calls[0].body).sort(), ['channel', 'installId', 'platform', 'version']);
    check('桌面版本取合法 App 版本', calls[0].body.version, '0.34.0');
    check('禁止重定向泄漏上报内容', calls[0].options.redirect, 'error');
    check('本地身份权限 0600', fs.statSync(path.join(options.dir, 'telemetry.json')).mode & 0o777, 0o600);
    const firstId = calls[0].body.installId;
    check('状态接口不含安装 ID 或删除凭证', JSON.stringify(await service.status()).includes(firstId), false);
    const secret = JSON.parse(fs.readFileSync(path.join(options.dir, 'telemetry.json'))).secret;
    check('删除凭证不作为活跃安装 ID 明文发送', calls[0].body.installId === secret, false);
    const restarted = createTelemetry(options);
    await restarted.record({ channel: 'npm' });
    check('服务重启后当天不重复成功上报', calls.length, 1);
    time += 86400000;
    await Promise.all([restarted.record({ channel: 'npm' }), service.record({ channel: 'desktop' })]);
    check('跨实例共用锁与身份，跨天只增加一次上报', calls.length, 2);
    check('跨天身份保持一致', calls[1].body.installId, firstId);
    enabled = false; await service.record({ channel: 'npm' });
    check('关闭后不继续活动上报', calls.length, 2);
    await service.forget();
    check('删除仅发送拥有证明', Object.keys(calls.at(-1).body), ['secret']);
    check('删除后本地身份被移除', (await service.status()).hasIdentity, false);
    enabled = true; await service.record({ channel: 'npm' });
    check('重新参与使用新身份', calls.at(-1).body.installId !== firstId);
    const badDir = path.join(tmp, 'failure');
    let count = 0;
    const failed = createTelemetry({ ...options, dir: badDir, fetchImpl: async () => { count++; throw Error('network'); } });
    await failed.record(); await failed.record();
    check('失败后退避，不紧密重复请求', count, 1);
    time += 60001; await failed.record(); time += 300001; await failed.record(); time += 1800001; await failed.record();
    check('失败重试有每日上限', count, 3);
    check('失败状态可见但不抛异常影响文档', (await failed.status()).state, 'retry-later');
    enabled = false;
    await failed.forget();
    check('离线删除保留待删除状态', (await failed.status()).deletionPending);
    let eraseCalls = [];
    const online = createTelemetry({ ...options, dir: badDir, fetchImpl: async (url, init) => { eraseCalls.push(url); return { ok: true, json: async () => ({ ok: true }) }; } });
    time += 60001; await online.record();
    check('关闭状态下前台恢复只重试删除、不发送活动', eraseCalls, [ENDPOINT + '/v1/forget']);
    check('联网删除完成后状态复位', (await online.status()).hasIdentity, false);
    enabled = true;
    let started;
    const startedPromise = new Promise(resolve => { started = resolve; });
    const cancellable = createTelemetry({ ...options, dir: path.join(tmp, 'cancel'), timeout: 30, fetchImpl: (_url, init) => new Promise((_resolve, reject) => { started(); init.signal.addEventListener('abort', () => reject(Error('abort'))); }) });
    const pending = cancellable.record(); await startedPromise; enabled = false; cancellable.stop(); await pending;
    check('关闭会中止在途活动请求且不记成功', (await cancellable.status()).lastSent, null);
    enabled = true;
    const timed = createTelemetry({ ...options, dir: path.join(tmp, 'timeout'), timeout: 20, fetchImpl: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('timeout')))) });
    await timed.record(); check('超时有界并返回可重试状态', (await timed.status()).state, 'retry-later');
    fs.mkdirSync(path.join(tmp, 'unsafe')); const outside = path.join(tmp, 'outside'); fs.writeFileSync(outside, '不得覆盖');
    fs.symlinkSync(outside, path.join(tmp, 'unsafe', 'telemetry.json'));
    const unsafe = createTelemetry({ ...options, dir: path.join(tmp, 'unsafe') }); await unsafe.record();
    check('符号链接身份文件不会被跟随或覆写', fs.readFileSync(outside, 'utf8'), '不得覆盖');
    check('坏身份明确显示存储错误', (await unsafe.status()).state, 'storage-error');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }

  // 浏览器端用本机模拟采集服务，不能发请求到真实统计域名。
  const received = [];
  let rejectDeletion = false;
  const collector = http.createServer((req, res) => {
    let body = ''; req.on('data', c => { body += c; }); req.on('end', () => {
      received.push({ path: req.url, body: JSON.parse(body) });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/v1/forget' && rejectDeletion) { res.statusCode = 503; res.end('{}'); return; }
      res.end(JSON.stringify({ ok: true, day: new Date().toISOString().slice(0, 10) }));
    });
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  const endpoint = 'http://127.0.0.1:' + collector.address().port;
  const atlas = await startAtlas({ prefix: 'atlas-telemetry-ui-', env: { ATLAS_TELEMETRY_TEST_URL: endpoint }, files: { 'private/never-upload.html': '<h1>不上传的私人内容</h1>' } });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const waitStatus = async predicate => {
      for (let i = 0; i < 100; i++) {
        const r = await page.request.get(atlas.base + '/api/telemetry');
        if (r.ok() && predicate(await r.json())) return;
        await wait(50);
      }
      throw Error('统计状态未在限定时间内落定');
    };
    await page.goto(atlas.base); await page.waitForSelector('#tree .file'); await wait(150);
    check('默认启动和打开界面不上传', received.length, 0);
    check('默认启动无身份文件', fs.existsSync(path.join(atlas.homeDir, 'telemetry.json')), false);
    await page.locator('#btn-settings').click(); await page.waitForSelector('#settings-modal:not(.hidden)');
    await page.locator('[data-goto="security"]').click();
    await page.waitForFunction(() => !document.getElementById('telemetry-toggle').disabled);
    check('设置开关默认不选中', await page.locator('#telemetry-toggle').isChecked(), false);
    check('本地统计状态接口可用', (await page.request.get(atlas.base + '/api/telemetry')).status(), 200);
    await page.locator('#telemetry-toggle').check();
    await waitStatus(s => typeof s.lastSent === 'string');
    check('用户明确开启后发送一次活跃', received.filter(r => r.path === '/v1/activity').length, 1);
    check('真实浏览器上报没有私人数据', JSON.stringify(received).includes('never-upload') || JSON.stringify(received).includes(atlas.scanDir), false);
    const status = await (await page.request.get(atlas.base + '/api/telemetry')).json();
    check('本地状态不向浏览器泄漏删除凭证', Object.keys(status).some(k => ['secret', 'installId'].includes(k)), false);
    let activePosts = 0; page.on('request', r => { if (r.url().endsWith('/api/telemetry/active')) activePosts++; });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); probeUsage(true); });
    await wait(80);
    check('隐藏界面不触发活跃操作', activePosts, 0);
    await page.evaluate(() => { delete document.hidden; });
    await page.evaluate(() => { probeUsage(true); probeUsage(true); }); await wait(100);
    check('重复前台事件当天只记录一次', received.filter(r => r.path === '/v1/activity').length, 1);
    const cross = await page.request.post(atlas.base + '/api/telemetry/forget', { headers: { Origin: 'https://evil.test' }, data: {} });
    check('跨站不能关闭或删除使用统计', cross.status(), 403);
    rejectDeletion = true;
    await page.locator('#telemetry-forget').click(); await page.waitForSelector('.atlas-dialog');
    await page.locator('.atlas-dialog button').filter({ hasText: '停止并删除' }).click();
    await waitStatus(s => s.deletionPending);
    await page.evaluate(() => refreshUsageSetting());
    check('离线删除先关闭开关，不假报删除完成', await page.locator('#telemetry-toggle').isChecked(), false);
    check('删除失败有明确等待提示', (await page.locator('#telemetry-status').textContent()).includes('尚未完成'));
    rejectDeletion = false;
    await page.locator('#telemetry-forget').click(); await page.waitForSelector('.atlas-dialog');
    await page.locator('.atlas-dialog button').filter({ hasText: '停止并删除' }).click();
    await waitStatus(s => !s.hasIdentity);
    check('用户重试删除成功，云端删除只发送证明', Object.keys(received.at(-1).body), ['secret']);
    check('删除后统计保持关闭', (await (await page.request.get(atlas.base + '/api/telemetry')).json()).enabled, false);
    await page.evaluate(() => refreshUsageSetting());
    await page.waitForFunction(() => document.getElementById('telemetry-forget').disabled);
    check('删除成功后 UI 不保留旧身份操作', await page.locator('#telemetry-forget').isDisabled());
    await page.screenshot({ path: '/tmp/atlas-telemetry-settings-light.png' });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
    await page.screenshot({ path: '/tmp/atlas-telemetry-settings-dark.png' });
    await page.setViewportSize({ width: 780, height: 1000 });
    check('窄窗口说明和删除按钮不溢出', await page.locator('.telemetry-setting').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    check('隐私技术细节默认折叠', await page.locator('.telemetry-details').getAttribute('open'), null);
    await page.locator('.telemetry-details summary').click();
    check('展开后仍保留字段、HMAC、留存与删除完整说明', (await page.locator('.telemetry-details').textContent()).includes('HMAC') && (await page.locator('.telemetry-details').textContent()).includes('90 天'));
    check('展开隐私说明不产生横向溢出', await page.locator('.telemetry-setting').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.locator('.telemetry-details summary').click();
    await page.setViewportSize({ width: 375, height: 900 });
    check('手机宽度的统计设置不横向溢出', await page.locator('.telemetry-setting').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    check('小屏设置导航不被版本/日志挤出大块空白', await page.locator('.settings-nav').evaluate(el => el.getBoundingClientRect().height < 90));
    await page.screenshot({ path: '/tmp/atlas-usage-setting-narrow.png' });
    check('无未捕获脚本异常', errors, []);
    for (const decision of ['accept', 'decline', 'escape']) {
      const fresh = await startAtlas({ prefix: 'atlas-usage-new-', config: telemetryDefaults(), env: { ATLAS_TELEMETRY_TEST_URL: endpoint }, files: { 'demo/a.html': '<h1>首次使用示例</h1>' } });
      const freshPage = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      try {
        const baseline = received.length;
        const early = await freshPage.request.post(fresh.base + '/api/telemetry/active', { data: { channel: 'npm' } });
        check(`新安装 ${decision}：确认前活动 API 不能触发上报`, early.status(), 202);
        await wait(80); check(`新安装 ${decision}：确认前无身份生成`, fs.existsSync(path.join(fresh.homeDir, 'telemetry.json')), false);
        await freshPage.goto(fresh.base); await freshPage.waitForSelector('#telemetry-intro-modal:not(.hidden)');
        check(`新安装 ${decision}：首次开关默认开启`, await freshPage.locator('#telemetry-intro-toggle').isChecked());
        check(`新安装 ${decision}：说明显示前后仍然零上报`, received.length, baseline);
        if (decision === 'accept') {
          await freshPage.screenshot({ path: '/tmp/atlas-usage-intro-light.png' });
          await freshPage.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
          await freshPage.screenshot({ path: '/tmp/atlas-usage-intro-dark.png' });
          await freshPage.setViewportSize({ width: 375, height: 900 });
          check('首次说明在手机宽度不横向溢出', await freshPage.locator('.usage-intro').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
          await freshPage.screenshot({ path: '/tmp/atlas-usage-intro-narrow.png' });
          await freshPage.locator('#telemetry-intro-start').click();
        } else if (decision === 'decline') await freshPage.locator('#telemetry-intro-decline').click();
        else await freshPage.keyboard.press('Escape');
        await freshPage.waitForSelector('#telemetry-intro-modal', { state: 'hidden' });
        if (decision === 'accept') {
          for (let i = 0; i < 100; i++) { if ((await (await freshPage.request.get(fresh.base + '/api/telemetry')).json()).lastSent) break; await wait(50); }
          check('首次确认后只增加一次真实模拟上报', received.length, baseline + 1);
          check('首次说明已持久化，不需每次确认', fresh.readConfig().telemetryNoticePending, false);
          await freshPage.request.put(fresh.base + '/api/config', { data: { telemetryEnabled: false } });
        } else {
          await wait(80); check(`新安装 ${decision}：拒绝或关闭后仍然不上传`, received.length, baseline);
          check(`新安装 ${decision}：未生成身份`, fs.existsSync(path.join(fresh.homeDir, 'telemetry.json')), false);
        }
        await freshPage.reload(); await freshPage.waitForSelector('#tree .file'); await wait(120);
        check(`新安装 ${decision}：关闭后刷新不自动重开`, (await (await freshPage.request.get(fresh.base + '/api/telemetry')).json()).enabled, false);
        check(`新安装 ${decision}：不重复弹首次说明`, await freshPage.locator('#telemetry-intro-modal').isVisible(), false);
      } finally { await freshPage.close(); await fresh.stop(); }
    }
  } finally { await browser.close(); await atlas.stop(); await new Promise(resolve => collector.close(resolve)); }
  // 私有看板的视觉测试使用明确的本地合成样本，不写入线上统计。
  const day = new Date().toISOString().slice(0, 10);
  const sample = { date: day, timezone: 'UTC', dau: 3, wau: 8, mau: 12, firstRecorded: 1,
    days: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10), active: i % 5, first_recorded: i % 2 })),
    distributions: { version: [{ label: '0.33.0', n: 12 }], platform: [{ label: 'darwin', n: 12 }], channel: [{ label: 'desktop', n: 12 }] } };
  const dashboard = fs.readFileSync(path.join(__dirname, '../cloudflare/usage/dashboard.html'), 'utf8');
  const view = http.createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/api/summary' ? 'application/json' : 'text/html');
    res.end(req.url === '/api/summary' ? JSON.stringify(sample) : dashboard);
  });
  await new Promise(resolve => view.listen(0, '127.0.0.1', resolve));
  const chartBrowser = await chromium.launch();
  try {
    for (const width of [1440, 375]) {
      const page = await chartBrowser.newPage({ viewport: { width, height: 1000 } });
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.goto('http://127.0.0.1:' + view.address().port);
      await page.waitForFunction(() => document.getElementById('dau').textContent === '3');
      check(`看板 ${width}px：不横向溢出`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      check(`看板 ${width}px：图表标签不随 SVG 缩小为不可读`, await page.locator('#chart').evaluate(el => Math.abs(el.viewBox.baseVal.width - el.getBoundingClientRect().width) < 1));
      await page.locator('#chart').focus(); await page.keyboard.press('End');
      check(`看板 ${width}px：键盘可查看每日数据`, (await page.locator('#tooltip').textContent()).includes('个活跃安装'));
      await page.locator('[data-range="7"]').click();
      check(`看板 ${width}px：时间筛选与数据表一致`, await page.locator('#daily tr').count(), 7);
      await page.locator('#theme').click();
      await page.screenshot({ path: `/tmp/atlas-usage-dashboard-${width}.png` });
      check(`看板 ${width}px：无未捕获异常`, errors, []);
      await page.close();
    }
  } finally { await chartBrowser.close(); await new Promise(resolve => view.close(resolve)); }
  console.log(`\n通过 ${total} 项，失败 0 项。`);
})().catch(e => { console.error(e); process.exitCode = 1; });
