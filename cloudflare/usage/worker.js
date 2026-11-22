import { createRemoteJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify } from 'jose';
import { DASHBOARD } from './dashboard.js';

const encoder = new TextEncoder();
const ID_RE = /^[a-f0-9]{64}$/;
const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,24})?$/;
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
} });
export const dayOf = time => new Date(time).toISOString().slice(0, 10);
const shiftedDay = (time, delta) => dayOf(time + delta * 86400000);
export async function sha256(text) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export async function hmac(text, secret) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = await crypto.subtle.sign('HMAC', key, encoder.encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function validActivity(body) {
  return body && Object.keys(body).sort().join(',') === 'channel,installId,platform,version' &&
    ID_RE.test(body.installId) && typeof body.version === 'string' && VERSION_RE.test(body.version) &&
    ['darwin', 'win32', 'linux'].includes(body.platform) && ['desktop', 'npm'].includes(body.channel);
}
async function smallBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('type');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const parts = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2048) { await reader.cancel(); throw new Error('size'); }
    parts.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
const keySets = new Map();
export async function verifyAccess(token, team, audience, keys) {
  // 白名单域名，避免配置错误把 JWT/证书请求发往任意站点。
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !/^[a-f0-9]{64}$/.test(audience)) return false;
  try {
    if (decodeProtectedHeader(token).alg !== 'RS256') return false;
    const claims = decodeJwt(token);
    if (!Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.iat > Date.now() / 1000 + 5 || claims.iss !== team ||
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) return false;
    if (!keys) {
      if (!keySets.has(team)) keySets.set(team, createRemoteJWKSet(new URL(team + '/cdn-cgi/access/certs'), { timeoutDuration: 3000 }));
      keys = keySets.get(team);
    }
    const result = await jwtVerify(token, keys, { issuer: team, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat'], clockTolerance: 5 });
    return result.payload.type === 'app' && typeof result.payload.email === 'string' && result.payload.email.length > 0;
  } catch { return false; }
}
export async function rollup(db, time = Date.now()) {
  const today = dayOf(time), cutoff = shiftedDay(time, -89);
  // 已汇总的日计数不可反查身份；删除明细后不重新缩减已生成的匿名汇总。
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO daily_totals(day, active, first_recorded)
      SELECT a.day, COUNT(*), SUM(CASE WHEN i.first_day = a.day THEN 1 ELSE 0 END)
      FROM activity a JOIN installs i ON i.id_hash = a.id_hash WHERE a.day < ? GROUP BY a.day`).bind(today),
    db.prepare('DELETE FROM activity WHERE day < ?').bind(cutoff),
    db.prepare('DELETE FROM installs WHERE last_day < ?').bind(cutoff),
    db.prepare('DELETE FROM revoked WHERE until_day < ?').bind(today),
    db.prepare('DELETE FROM budget WHERE day < ?').bind(shiftedDay(time, -7)),
  ]);
}
export async function summary(db, time = Date.now()) {
  const today = dayOf(time), week = shiftedDay(time, -6), month = shiftedDay(time, -29);
  const head = await db.prepare(`SELECT COUNT(DISTINCT CASE WHEN day = ? THEN id_hash END) AS dau,
    COUNT(DISTINCT CASE WHEN day >= ? THEN id_hash END) AS wau, COUNT(DISTINCT id_hash) AS mau
    FROM activity WHERE day >= ?`).bind(today, week, month).first();
  const first = await db.prepare('SELECT COUNT(*) AS n FROM installs WHERE first_day = ?').bind(today).first();
  const daily = (await db.prepare(`SELECT day, active, first_recorded FROM daily_totals WHERE day >= ? AND day < ?
    UNION ALL SELECT ?, COUNT(*), (SELECT COUNT(*) FROM installs WHERE first_day = ?) FROM activity WHERE day = ?
    ORDER BY day`).bind(month, today, today, today, today).all()).results;
  const latest = `FROM activity a JOIN (SELECT id_hash, MAX(day) AS day FROM activity WHERE day >= ? GROUP BY id_hash) b
    ON a.id_hash = b.id_hash AND a.day = b.day`;
  const distributions = {};
  for (const column of ['version', 'platform', 'channel']) {
    distributions[column] = (await db.prepare(`SELECT a.${column} AS label, COUNT(*) AS n ${latest}
      GROUP BY a.${column} ORDER BY n DESC, label`).bind(month).all()).results;
  }
  const byDay = new Map(daily.map(row => [row.day, row]));
  const days = Array.from({ length: 30 }, (_, i) => {
    const day = shiftedDay(time, i - 29);
    return byDay.get(day) || { day, active: 0, first_recorded: 0 };
  });
  return { date: today, timezone: 'UTC', ...head, firstRecorded: first.n, days, distributions };
}
async function activity(request, env, time) {
  let body;
  try { body = await smallBody(request); } catch { return json({ error: 'invalid-body' }, 400); }
  if (!validActivity(body)) return json({ error: 'invalid-fields' }, 400);
  const today = dayOf(time), hash = await hmac(body.installId, env.HMAC_KEY);
  const ipKey = await hmac('source:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), env.HMAC_KEY);
  for (const key of ['ip:' + ipKey, 'install:' + hash]) {
    if (!(await env.RATE_LIMIT.limit({ key })).success) return json({ error: 'rate-limited' }, 429);
  }
  if (await env.DB.prepare('SELECT 1 AS n FROM revoked WHERE id_hash = ? AND until_day >= ?').bind(hash, today).first()) return json({ error: 'revoked' }, 410);
  if (await env.DB.prepare('SELECT 1 AS n FROM activity WHERE day = ? AND id_hash = ?').bind(today, hash).first()) return json({ ok: true, day: today });
  const budget = await env.DB.prepare(`INSERT INTO budget(day, used) VALUES(?, 1) ON CONFLICT(day)
    DO UPDATE SET used = used + 1 WHERE used < ? RETURNING used`).bind(today, Math.min(10000, Math.max(1, Number(env.DAILY_REQUEST_LIMIT) || 10000))).first();
  if (!budget) return json({ error: 'daily-capacity' }, 429);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO installs(id_hash, first_day, last_day) SELECT ?, ?, ?
      WHERE NOT EXISTS(SELECT 1 FROM revoked WHERE id_hash = ? AND until_day >= ?)
      ON CONFLICT(id_hash) DO UPDATE SET first_day = MIN(installs.first_day, excluded.first_day), last_day = MAX(installs.last_day, excluded.last_day)`).bind(hash, today, today, hash, today),
    env.DB.prepare(`INSERT OR IGNORE INTO activity(day, id_hash, version, platform, channel) SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS(SELECT 1 FROM revoked WHERE id_hash = ? AND until_day >= ?)`).bind(today, hash, body.version, body.platform, body.channel, hash, today),
  ]);
  // 删除请求与活动写入并发时，不能向客户端假报记录成功。
  if (await env.DB.prepare('SELECT 1 AS n FROM revoked WHERE id_hash = ? AND until_day >= ?').bind(hash, today).first()) return json({ error: 'revoked' }, 410);
  return json({ ok: true, day: today });
}
async function forget(request, env, time) {
  let body;
  try { body = await smallBody(request); } catch { return json({ error: 'invalid-body' }, 400); }
  if (!body || Object.keys(body).join(',') !== 'secret' || !ID_RE.test(body.secret)) return json({ error: 'invalid-fields' }, 400);
  const hash = await hmac(await sha256(body.secret), env.HMAC_KEY);
  const source = await hmac('source:' + (request.headers.get('CF-Connecting-IP') || 'unknown'), env.HMAC_KEY);
  if (!(await env.RATE_LIMIT.limit({ key: 'forget:' + source })).success) return json({ error: 'rate-limited' }, 429);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO revoked(id_hash, until_day) VALUES(?, ?) ON CONFLICT(id_hash) DO UPDATE SET until_day = excluded.until_day`).bind(hash, shiftedDay(time, 7)),
    env.DB.prepare('DELETE FROM activity WHERE id_hash = ?').bind(hash),
    env.DB.prepare('DELETE FROM installs WHERE id_hash = ?').bind(hash),
  ]);
  return json({ ok: true });
}
const PRIVACY = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Atlas 使用统计说明</title><style>body{font:16px system-ui;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.9;color:#243047;background:#fff}h1{font-size:26px}a{color:#5151cf}</style><h1>Atlas 使用统计</h1><p>支持此功能的新版本，新安装默认开启，首次使用会显著说明，可在首次上报前关闭；首次说明确认前不生成统计身份、不发送统计。现有安装沿用原选择，已关闭的不自动开启。仅在统计开启并打开界面或进入前台后，上报去重用随机安装标识、版本、平台和桌面/npm 渠道，每个 UTC 日最多一次成功上报。后台服务单独在线不计活跃。</p><p>不采集文件名、路径、内容、扫描根或文档数量。随机标识由服务器 HMAC 后保存，不保存原始标识、删除凭证和 IP；网络请求仍由 Cloudflare 处理。稳定标识可关联多天活动，因此这属于去标识化安装统计，不是完全匿名，也不等于人数或全部用户。</p><p>明细保留 90 天，之后只保留不含安装标识的日汇总。90 天没有记录后重新参与，会作为记录窗口内的新安装。设置中可关闭，并请求删除此安装明细；已生成匿名汇总无法定位某个安装，不会撤回。删除后保留最多约 8 天的 HMAC 删除屏障，防止在途旧请求重建记录，之后自动清理。Cloudflare D1 的灾难恢复副本可能在服务保留期内存在（最长按 Cloudflare 套餐为 30 天），不参与日常统计。</p><p>删除时会发送单独的删除凭证来证明拥有该安装；不提供给浏览器、不保存于数据库。离线删除会先停用统计，再保留待删除请求，在联网时重试。</p><p>开源：<a href="https://github.com/DamonAmber/atlas-dashboard">atlas-dashboard</a> · <a href="https://unmadebox.com/">Unmade Box</a></p></html>`;
export async function handle(request, env, time = Date.now()) {
  const url = new URL(request.url);
  if (url.hostname === env.ADMIN_HOST) {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return json({ error: 'access-not-configured' }, 503);
    if (!(await verifyAccess(request.headers.get('Cf-Access-Jwt-Assertion') || '', env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD))) return json({ error: 'unauthorized' }, 401);
    if (request.method !== 'GET') return json({ error: 'method-not-allowed' }, 405);
    if (url.pathname === '/api/summary') return json(await summary(env.DB, time));
    if (url.pathname === '/') return new Response(DASHBOARD, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    } });
    return json({ error: 'not-found' }, 404);
  }
  if (url.hostname !== env.COLLECT_HOST) return json({ error: 'not-found' }, 404);
  if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, service: 'atlas-usage' });
  if (request.method === 'GET' && url.pathname === '/privacy') return new Response(PRIVACY, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
  if (request.method !== 'POST' || !['/v1/activity', '/v1/forget'].includes(url.pathname)) return json({ error: 'not-found' }, 404);
  if (!env.HMAC_KEY || !env.DB || !env.RATE_LIMIT) return json({ error: 'service-not-configured' }, 503);
  return url.pathname === '/v1/activity' ? activity(request, env, time) : forget(request, env, time);
}
export default {
  async fetch(request, env) { try { return await handle(request, env); } catch { return json({ error: 'service-unavailable' }, 503); } },
  async scheduled(_event, env) { await rollup(env.DB); },
};
