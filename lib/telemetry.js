'use strict';
// 关闭或首次说明未确认时不创建身份、不发请求；只由界面前台事件调用，不启动后台心跳。
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const ENDPOINT = 'https://atlas-telemetry.unmadebox.com';
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,24})?$/;
const SECRET_RE = /^[a-f0-9]{64}$/;
const dayOf = time => new Date(time).toISOString().slice(0, 10);
function testEndpoint(env) {
  if (!env.ATLAS_HOME || !env.ATLAS_TELEMETRY_TEST_URL) return ENDPOINT;
  try {
    const u = new URL(env.ATLAS_TELEMETRY_TEST_URL);
    if (u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) && u.pathname === '/' && !u.username && !u.password) return u.origin;
  } catch {}
  return ENDPOINT;
}
function createTelemetry({ dir, enabled, version, platform = process.platform, endpoint = ENDPOINT, fetchImpl = globalThis.fetch, now = Date.now, timeout = 3000 } = {}) {
  const file = path.join(dir, 'telemetry.json'), lockFile = file + '.lock';
  let busy = null, controller = null, requestKind = null, phase = 'idle';
  const consent = () => { try { return enabled() === true; } catch { return false; } };
  async function read() {
    try {
      const st = await fs.lstat(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('invalid-state');
      const s = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!SECRET_RE.test(s.secret)) throw new Error('invalid-state');
      return s;
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async function write(s) {
    // 所有修改都在跨进程锁内；原子替换避免重启时读到半份身份。
    const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    try { await fs.writeFile(temp, JSON.stringify(s), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, file); }
    finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function locked(task, waitForLock = false) {
    let fd;
    try {
      await fs.mkdir(dir, { recursive: true });
      const deadline = Date.now() + (waitForLock ? timeout + 500 : 0);
      while (!fd) {
        try { fd = await fs.open(lockFile, 'wx', 0o600); }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          let st;
          try { st = await fs.lstat(lockFile); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          if (!st.isFile() || st.isSymbolicLink()) throw new Error('invalid-lock');
          if (Date.now() - st.mtimeMs >= 30000) { await fs.unlink(lockFile).catch(() => {}); continue; }
          if (Date.now() >= deadline) return;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      return await task();
    } finally { if (fd) { await fd.close(); await fs.unlink(lockFile).catch(() => {}); } }
  }
  async function status() {
    let s;
    try { s = await read(); }
    catch { return { enabled: consent(), hasIdentity: false, state: 'storage-error', deletionPending: false, endpoint: ENDPOINT, lastSent: null }; }
    return {
      enabled: consent(), hasIdentity: !!s, deletionPending: !!s?.deletionPending,
      state: phase === 'storage-error' ? 'storage-error' : s?.deletionPending ? (phase === 'deleting' ? 'deleting' : 'delete-pending') : phase === 'sending' ? phase : !consent() ? 'off' : s?.lastError ? 'retry-later' : 'ready',
      lastSent: s?.lastSent || null, lastDay: s?.lastDay || null, endpoint: ENDPOINT,
    };
  }
  async function post(route, body) {
    controller = new AbortController();
    requestKind = route;
    const c = controller, timer = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetchImpl(endpoint + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: c.signal });
      if (!r.ok) throw new Error('request-failed');
      const data = await r.json();
      if (data.ok !== true) throw new Error('request-failed');
      return data;
    } finally { clearTimeout(timer); if (controller === c) { controller = null; requestKind = null; } }
  }
  const canTry = (s, kind) => {
    const current = dayOf(now());
    const attempts = s[kind + 'Day'] === current ? s[kind + 'Count'] || 0 : 0;
    return attempts < 3 && (!s[kind + 'After'] || s[kind + 'After'] <= now());
  };
  function attempt(s, kind) {
    const current = dayOf(now());
    s[kind + 'Count'] = s[kind + 'Day'] === current ? (s[kind + 'Count'] || 0) + 1 : 1;
    s[kind + 'Day'] = current;
    s[kind + 'After'] = now() + [60000, 300000, 1800000][Math.min(2, s[kind + 'Count'] - 1)];
  }
  async function erase(s) {
    if (!canTry(s, 'erase')) return;
    phase = 'deleting'; attempt(s, 'erase'); await write(s);
    try {
      await post('/v1/forget', { secret: s.secret });
      await fs.unlink(file);
      phase = 'idle';
    } catch {
      s.lastError = 'delete-failed'; await write(s); phase = 'idle';
    }
  }
  function stop() { if (requestKind === '/v1/activity') controller?.abort(); phase = 'idle'; }
  async function run(task, waitForLock = false) {
    if (busy) { await busy; return status(); }
    busy = locked(task, waitForLock).catch(() => { phase = 'storage-error'; }).finally(() => { busy = null; });
    await busy;
    return status();
  }
  async function record({ channel = 'npm', appVersion } = {}) {
    // 未同意且没有待删除记录时不拿锁、不创建任何文件。
    let initial;
    try { initial = await read(); } catch { return status(); }
    if (!consent() && !initial?.deletionPending) return status();
    return run(async () => {
      let s = await read();
      if (s?.deletionPending) { await erase(s); return; }
      if (!consent()) return;
      if (!s) { s = { secret: crypto.randomBytes(32).toString('hex') }; await write(s); }
      const day = dayOf(now());
      if (s.lastDay === day || !canTry(s, 'send')) return;
      if (!['desktop', 'npm'].includes(channel) || !['darwin', 'win32', 'linux'].includes(platform)) return;
      const v = appVersion && VERSION_RE.test(appVersion) ? appVersion : version;
      if (!VERSION_RE.test(v)) return;
      phase = 'sending'; attempt(s, 'send'); await write(s);
      if (!consent()) { phase = 'idle'; return; }
      try {
        const installId = crypto.createHash('sha256').update(s.secret).digest('hex');
        const result = await post('/v1/activity', { installId, version: v, platform, channel });
        if (!consent()) { phase = 'idle'; return; }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(result.day)) throw new Error('invalid-day');
        s.lastDay = result.day; s.lastSent = new Date(now()).toISOString(); delete s.lastError; await write(s);
      } catch { s.lastError = 'send-failed'; await write(s); }
      finally { phase = 'idle'; }
    });
  }
  async function forget() {
    stop();
    if (busy) await busy;
    let initial;
    try { initial = await read(); } catch { return status(); }
    if (!initial) return status();
    await run(async () => {
      const s = await read(); if (!s) return;
      s.deletionPending = true; delete s.eraseAfter; s.eraseCount = 0; s.eraseDay = dayOf(now());
      await write(s); await erase(s);
    }, true);
    return status();
  }
  return { status, record, forget, stop };
}
module.exports = { createTelemetry, testEndpoint, ENDPOINT, dayOf };
