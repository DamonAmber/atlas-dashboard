// 仅为 Cron 开通必要的账户子域；登录凭据只在子进程/内存中流转，不输出或落盘。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const config = JSON.parse(readFileSync(new URL('./wrangler.json', import.meta.url)));
const cli = fileURLToPath(new URL('./node_modules/.bin/wrangler', import.meta.url));
async function main() {
  const auth = JSON.parse(execFileSync(cli, ['auth', 'token', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } }));
  if (!auth.token) throw new Error('auth');
  const url = `https://api.cloudflare.com/client/v4/accounts/${config.account_id}/workers/subdomain`;
  const headers = { Authorization: 'Bearer ' + auth.token, 'Content-Type': 'application/json' };
  let r = await fetch(url, { headers }), b = await r.json();
  if (b.success && b.result?.subdomain) { console.log('账户 Workers 子域已就绪：' + b.result.subdomain); return; }
  if (r.status !== 404 || !(b.errors || []).some(e => e.code === 10007)) throw new Error('read-denied');
  r = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ subdomain: 'unmadebox-atlas' }) }); b = await r.json();
  if (!b.success || !b.result?.subdomain) throw new Error('create-failed');
  console.log('已创建账户 Workers 子域：' + b.result.subdomain + '.workers.dev；统计服务仍关闭 workers.dev 访问。');
}
main().catch(() => { console.error('账户子域配置未完成，请打开 Cloudflare Workers & Pages 后重试；没有输出凭据。'); process.exitCode = 1; });
