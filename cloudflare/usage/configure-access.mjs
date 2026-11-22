// Team Domain / AUD 是公开应用参数，不是 API token；不要把登录凭据传给此脚本。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
const pick = flag => { const i = args.indexOf(flag); return i < 0 ? '' : args[i + 1]; };
let team = pick('--team') || '', aud = pick('--aud') || '';
if (team && !team.startsWith('https://')) team = 'https://' + team;
team = team.replace(/\/$/, '');
if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(team) || !/^[a-f0-9]{64}$/.test(aud)) {
  console.error('用法：node cloudflare/usage/configure-access.mjs --team 团队名.cloudflareaccess.com --aud 应用的64位AUD');
  process.exit(1);
}
const configFile = new URL('./wrangler.json', import.meta.url);
const config = JSON.parse(readFileSync(configFile));
config.vars.ACCESS_TEAM_DOMAIN = team; config.vars.ACCESS_AUD = aud;
writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
const cli = fileURLToPath(new URL('./node_modules/.bin/wrangler', import.meta.url));
execFileSync(process.execPath, [fileURLToPath(new URL('./build-dashboard.mjs', import.meta.url))], { stdio: 'inherit' });
execFileSync(cli, ['deploy', '--config', fileURLToPath(configFile)], { stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
console.log('Worker 已同步 Access 校验参数。请在浏览器登录后确认私有看板，不要关闭 Access 策略。');
