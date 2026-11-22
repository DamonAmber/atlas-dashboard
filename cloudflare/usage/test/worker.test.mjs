import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { handle, hmac, sha256, summary, rollup, verifyAccess } from '../worker.js';
const T = Date.UTC(2026, 10, 20, 12);
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
async function database(fn) {
  const mf = new Miniflare({ ...convertV4MiniflareOptions({ name: 'test', modules: true, script: 'export default { fetch() { return new Response("test") } }', d1Databases: ['DB'], compatibilityDate: '2026-07-30' }), telemetry: { enabled: false } });
  try {
    const DB = await mf.getD1Database('DB');
    for (const statement of schema.split(';').filter(s => s.trim())) await DB.prepare(statement).run();
    const env = { DB, HMAC_KEY: 'unit-test-key-only', COLLECT_HOST: 'atlas-telemetry.unmadebox.com', ADMIN_HOST: 'atlas-stats.unmadebox.com', RATE_LIMIT: { limit: async () => ({ success: true }) }, DAILY_REQUEST_LIMIT: '10000' };
    await fn(DB, env);
  } finally { await mf.dispose(); }
}
const request = (route, body, host = 'atlas-telemetry.unmadebox.com') => new Request('https://' + host + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function payload(secret, extra = {}) { return { installId: await sha256(secret), version: '0.33.0', platform: 'darwin', channel: 'desktop', ...extra }; }
test('真实 D1 每日去重、多日活跃、首次记录与安装级删除', async () => database(async (DB, env) => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64);
  assert.equal((await handle(request('/v1/activity', await payload(a)), env, T)).status, 200);
  assert.equal((await handle(request('/v1/activity', await payload(a)), env, T)).status, 200);
  assert.equal((await summary(DB, T)).dau, 1);
  const next = T + 86400000;
  await handle(request('/v1/activity', await payload(a, { version: '0.34.0' })), env, next);
  await handle(request('/v1/activity', await payload(b, { platform: 'linux', channel: 'npm' })), env, next);
  let s = await summary(DB, next);
  assert.deepEqual([s.dau, s.wau, s.mau, s.firstRecorded], [2, 2, 2, 1]);
  assert.equal(s.distributions.version.length, 2);
  await rollup(DB, next);
  assert.equal((await summary(DB, next)).days.at(-2).active, 1);
  assert.equal((await handle(request('/v1/forget', { secret: 'f'.repeat(64) }), env, next)).status, 200);
  assert.equal((await summary(DB, next)).mau, 2, '错误凭证不能删除其他安装');
  await handle(request('/v1/forget', { secret: a }), env, next);
  s = await summary(DB, next);
  assert.deepEqual([s.dau, s.wau, s.mau], [1, 1, 1]);
  assert.equal(s.days.at(-2).active, 1, '已生成汇总不撤回');
  assert.equal((await handle(request('/v1/activity', await payload(a)), env, next)).status, 410, '在途旧身份被屏障拒绝');
  const serialized = JSON.stringify((await DB.prepare('SELECT * FROM installs').all()).results);
  assert(!serialized.includes(b)); assert(!serialized.includes(await sha256(b)));
  assert(serialized.includes(await hmac(await sha256(b), env.HMAC_KEY)));
}));
test('字段白名单、体积限制、来源限流与每天容量限制', async () => database(async (DB, env) => {
  const body = await payload('1'.repeat(64));
  for (const bad of [{ ...body, path: '/private/file' }, { ...body, version: '<script>' }, { ...body, platform: 'unknown' }, { ...body, installId: 'x' }, { ...body, channel: 'bot' }]) assert.equal((await handle(request('/v1/activity', bad), env, T)).status, 400);
  assert.equal((await handle(request('/v1/activity', { ...body, padding: 'x'.repeat(3000) }), env, T)).status, 400);
  assert.equal((await handle(request('/v1/activity', body), { ...env, RATE_LIMIT: { limit: async () => ({ success: false }) } }, T)).status, 429);
  env.DAILY_REQUEST_LIMIT = '1';
  assert.equal((await handle(request('/v1/activity', body), env, T)).status, 200);
  assert.equal((await handle(request('/v1/activity', body), env, T)).status, 200);
  assert.equal((await handle(request('/v1/activity', await payload('2'.repeat(64))), env, T)).status, 429);
  assert.equal((await summary(DB, T)).dau, 1);
}));
test('明细 90 天清理与匿名汇总保留', async () => database(async (DB, env) => {
  const old = T - 100 * 86400000;
  await handle(request('/v1/activity', await payload('3'.repeat(64))), env, old);
  await handle(request('/v1/activity', await payload('4'.repeat(64))), env, T - 20 * 86400000);
  await rollup(DB, T);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM activity').first()).n, 1);
  assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM installs').first()).n, 1);
  assert.equal((await DB.prepare('SELECT SUM(active) AS n FROM daily_totals').first()).n, 2);
}));
test('采集域名不能访问看板，未配置和伪造 Access 均拒绝', async () => database(async (_DB, env) => {
  for (const route of ['/', '/api/summary']) assert.equal((await handle(new Request('https://atlas-stats.unmadebox.com' + route), env)).status, 503);
  env.ACCESS_TEAM_DOMAIN = 'https://test.cloudflareaccess.com'; env.ACCESS_AUD = 'c'.repeat(64);
  assert.equal((await handle(new Request('https://atlas-stats.unmadebox.com/api/summary', { headers: { 'Cf-Access-Jwt-Assertion': 'forged' } }), env)).status, 401);
  assert.equal((await handle(new Request('https://atlas-telemetry.unmadebox.com/api/summary'), env)).status, 404);
  assert.equal((await handle(new Request('https://alternate.workers.dev/'), env)).status, 404);
  assert.equal((await handle(new Request('https://atlas-telemetry.unmadebox.com/privacy'), env)).status, 200);
  assert.equal((await handle(request('/v1/activity', await payload('5'.repeat(64))), { ...env, HMAC_KEY: '' })).status, 503);
}));
test('Access JWT 校验签名、issuer、audience、有效期与应用类型', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = await exportJWK(publicKey); jwk.kid = 'test';
  const keys = createLocalJWKSet({ keys: [jwk] });
  const team = 'https://test.cloudflareaccess.com', aud = 'c'.repeat(64);
  const sign = async (issuer = team, audience = aud, exp = '1h', type = 'app') => new SignJWT({ email: 'test@example.test', type }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuedAt().setIssuer(issuer).setAudience(audience).setExpirationTime(exp).sign(privateKey);
  assert.equal(await verifyAccess(await sign(), team, aud, keys), true);
  assert.equal(await verifyAccess(await sign('https://other.cloudflareaccess.com'), team, aud, keys), false);
  assert.equal(await verifyAccess(await sign(team, 'd'.repeat(64)), team, aud, keys), false);
  assert.equal(await verifyAccess(await sign(team, aud, 1), team, aud, keys), false);
  assert.equal(await verifyAccess(await sign(team, aud, '1h', 'service'), team, aud, keys), false);
  const other = await generateKeyPair('RS256');
  const forged = await new SignJWT({ email: 'test@example.test', type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).setIssuedAt().setIssuer(team).setAudience(aud).setExpirationTime('1h').sign(other.privateKey);
  assert.equal(await verifyAccess(forged, team, aud, keys), false);
});
