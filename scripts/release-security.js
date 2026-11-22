'use strict';

// 开源发布安全门禁：不改变运行时架构，只约束发布文件并扫描最终产物。
// 报错仅包含文件路径与规则名，绝不打印匹配到的凭据内容。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const LIB_FILES = [
  'activity-log', 'chromium', 'diff', 'edit-apply', 'edit-backup', 'editable',
  'fs-watcher', 'icloud-download', 'icloud', 'init', 'link-index', 'paths',
  'pdf-export', 'plain-render', 'restart-helper-template', 'self-writes',
  'share', 'telemetry', 'thumbnail', 'update-check', 'version-store',
].map(name => `lib/${name}.js`);
const PUBLIC_FILES = [
  'public/index.html', 'public/styles.css', 'public/app.js', 'public/changelog.js',
  'public/favicon.svg', 'public/peek.js', 'public/river.js', 'public/starmap.js',
  'public/vendor/markdown.js', 'public/vendor/mermaid.min.js',
  'public/vendor/Sortable.min.js', 'public/vendor/qrcode.min.js',
  'public/vendor/katex/katex.min.css', 'public/vendor/katex/katex.min.js',
];
const FONT_PATTERN = 'public/vendor/katex/fonts/*.woff2';
const COMMON_FILES = ['server.js', ...LIB_FILES, ...PUBLIC_FILES, FONT_PATTERN];
const NPM_FILES = ['bin/atlas.js', ...COMMON_FILES, 'README.md', 'LICENSE'];
const APP_FILES = [
  'package.json', 'LICENSE', ...COMMON_FILES,
  'electron/main.js', 'electron/preload.js', 'electron/pdf.js',
  'electron/server-manager.js', 'electron/titlebar.js',
  'electron/build/trayTemplate.png', 'electron/build/trayTemplate@2x.png',
];
const NAME_RULES = [
  ['环境或配置凭据文件', b => /(^|\.)env($|\.)/i.test(b) || b === '.npmrc' || b === '.netrc'],
  ['私钥或证书文件', b => /\.(p12|pfx|pem|key)$/i.test(b) || /^id_/.test(b)],
];
const CONTENT_RULES = [
  ['Apple 公证密码字段', /APPLE_APP_SPECIFIC_PASSWORD/],
  ['Apple ID 赋值', /\bAPPLE_ID\s*=/],
  ['npm token', /npm_[A-Za-z0-9]{36,}/],
  ['GitHub token', /gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}/],
  ['App 专用密码格式', /(?<![A-Za-z0-9_-])[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}(?![A-Za-z0-9_-])/],
  ['私钥内容', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
];

function allowed(rel, channel) {
  const files = channel === 'app' ? APP_FILES : [...NPM_FILES, 'package.json'];
  if (files.includes(rel)) return true;
  if (/^public\/vendor\/katex\/fonts\/[^/]+\.woff2$/.test(rel)) return true;
  // electron-builder 自动收集生产依赖；它们是开源版运行时所必需的。
  return channel === 'app' && rel.startsWith('node_modules/');
}
function safeLabel(rel) { return JSON.stringify(rel); }
function checkName(rel, errors) {
  // 每一层都检查，避免将秘密放进名为 .env 的目录。
  for (const part of rel.split('/')) {
    for (const [rule, test] of NAME_RULES) {
      if (test(part)) errors.push(`${safeLabel(rel)}：${rule}`);
    }
  }
}
function checkContent(rel, bytes, errors) {
  const text = bytes.toString('latin1');
  for (const [rule, re] of CONTENT_RULES) {
    if (re.test(text)) errors.push(`${safeLabel(rel)}：${rule}`);
  }
}
function scanFile(file, rel, errors) {
  // 有界内存逐块扫描，重叠足以覆盖跨块凭据；读错直接失败。
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(64 * 1024);
  let tail = Buffer.alloc(0);
  try {
    let count;
    while ((count = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      const bytes = Buffer.concat([tail, buf.subarray(0, count)]);
      checkContent(rel, bytes, errors);
      tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024)));
    }
  } finally { fs.closeSync(fd); }
}
function scanTree(root, { channel, checkWhitelist = true } = {}) {
  const files = [], errors = [];
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      checkName(rel, errors);
      if (entry.isSymbolicLink()) {
        errors.push(`${safeLabel(rel)}：发布物中不允许符号链接`);
      } else if (entry.isDirectory()) walk(abs, rel);
      else if (entry.isFile()) {
        files.push(rel);
        if (checkWhitelist && !allowed(rel, channel)) errors.push(`${safeLabel(rel)}：白名单外文件`);
        scanFile(abs, rel, errors);
      } else errors.push(`${safeLabel(rel)}：非普通文件`);
    }
  }
  try {
    if (!fs.lstatSync(root).isDirectory()) throw new Error('产物根必须是普通目录');
    walk(root, '');
  }
  catch { errors.push('无法完整读取发布物，已阻止发布'); }
  return { files: files.sort(), errors: [...new Set(errors)] };
}
function scanApp(appPath) {
  const resources = path.join(appPath, 'Contents', 'Resources');
  const root = path.join(resources, 'app');
  const result = scanTree(root, { channel: 'app' });
  for (const required of APP_FILES.filter(f => f !== FONT_PATTERN)) {
    if (!result.files.includes(required)) result.errors.push(`${safeLabel(required)}：缺少运行时文件`);
  }
  if (!result.files.some(f => /^public\/vendor\/katex\/fonts\/[^/]+\.woff2$/.test(f))) {
    result.errors.push('缺少 KaTeX 字体文件');
  }
  // asar:false 是现有架构的约束；不能悄悄换成旧闭源分支的打包布局。
  if (fs.existsSync(path.join(resources, 'app.asar')) || fs.existsSync(path.join(resources, 'app.asar.unpacked'))) {
    result.errors.push('开源版预期 asar:false，发现未扫描的 asar 产物');
  }
  try {
    for (const entry of fs.readdirSync(resources, { withFileTypes: true })) {
      if (entry.name === 'app') continue;
      const rel = `Resources/${entry.name}`;
      checkName(rel, result.errors);
      if (entry.isSymbolicLink()) result.errors.push(`${safeLabel(rel)}：不允许符号链接`);
      else if (entry.isFile()) scanFile(path.join(resources, entry.name), rel, result.errors);
      else if (entry.isDirectory()) {
        const nested = scanTree(path.join(resources, entry.name), { checkWhitelist: false });
        result.errors.push(...nested.errors.map(e => `${safeLabel(rel)} / ${e}`));
      } else result.errors.push(`${safeLabel(rel)}：非普通文件`);
    }
  } catch { result.errors.push('无法完整读取 Resources，已阻止发布'); }
  result.errors = [...new Set(result.errors)];
  return result;
}
function run(command, args, cwd, encoding = 'utf8') {
  const r = spawnSync(command, args, { cwd, encoding, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  // 不透传外部命令 stderr，避免它将凭据内容带入日志。
  if (r.error || r.status !== 0) throw new Error(`${command} 检查失败`);
  return r.stdout;
}
function scanNpm(pkgDir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-release-gate-'));
  const errors = [], files = [];
  try {
    // ignore-scripts 防止 prepack 递归；显式取消继承的 dry-run，内层只在临时目录
    // 生成检查用 tgz（不发布），外层 npm pack/publish --dry-run 仍不写正式包。
    const output = run('npm', ['pack', '--ignore-scripts', '--dry-run=false', '--json', '--pack-destination', tmp,
      '--cache', path.join(tmp, 'cache')], pkgDir);
    const info = JSON.parse(output);
    const filename = info[0].filename;
    if (path.basename(filename) !== filename || !filename.endsWith('.tgz')) throw new Error('无效归档名');
    const archive = path.join(tmp, filename);
    const entries = run('tar', ['-tzf', archive], tmp).trim().split('\n');
    for (const entry of entries) {
      if (!entry.startsWith('package/') || /(^|\/)\.\.(\/|$)/.test(entry) || entry.includes('\\')) {
        errors.push('npm 归档路径非法'); continue;
      }
      const rel = entry.slice('package/'.length);
      checkName(rel, errors);
      if (entry.endsWith('/')) continue;
      files.push(rel);
      if (!allowed(rel, 'npm')) errors.push(`${safeLabel(rel)}：白名单外文件`);
      checkContent(rel, run('tar', ['-xOzf', archive, '--', entry], tmp, 'buffer'), errors);
    }
    if (!files.some(f => /^public\/vendor\/katex\/fonts\/[^/]+\.woff2$/.test(f))) errors.push('npm 包缺少 KaTeX 字体文件');
    for (const required of [...NPM_FILES.filter(f => f !== FONT_PATTERN), 'package.json']) {
      if (!files.includes(required)) errors.push(`${safeLabel(required)}：npm 包缺少文件`);
    }
  } catch { errors.push('无法完整检查 npm 归档，已阻止发布'); }
  finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return { files: files.sort(), errors: [...new Set(errors)] };
}
// 签名 / staple 会改变 DMG 字节；发布前刷新清单，zip 与顶层 sha512 保持对应。
async function refreshMacFeed(dir) {
  const yaml = require('js-yaml');
  const crypto = require('crypto');
  const file = path.join(dir, 'latest-mac.yml');
  let feed;
  try { feed = yaml.load(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('自动更新清单无法解析'); }
  const version = require('../package.json').version;
  if (!feed || feed.version !== version || !Array.isArray(feed.files)) throw new Error('自动更新版本或清单结构不一致');
  const allowed = new Set(['Atlas-mac-arm64.zip', 'Atlas-mac-arm64.dmg']);
  const seen = new Set();
  for (const item of feed.files) {
    if (!item || !allowed.has(item.url) || seen.has(item.url)) throw new Error('自动更新清单包含非法或重复文件');
    seen.add(item.url);
    const target = path.join(dir, item.url);
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) throw new Error('自动更新文件必须是普通文件');
    const hash = crypto.createHash('sha512');
    for await (const chunk of fs.createReadStream(target)) hash.update(chunk);
    item.sha512 = hash.digest('base64');
    item.size = stat.size;
  }
  if (!seen.has('Atlas-mac-arm64.zip')) throw new Error('自动更新清单缺少 zip');
  if (feed.path) {
    const primary = feed.files.find(item => item.url === feed.path);
    if (!primary || !feed.path.endsWith('.zip')) throw new Error('macOS 主更新文件必须是 zip');
    feed.sha512 = primary.sha512;
  }
  fs.writeFileSync(file + '.tmp', yaml.dump(feed, { lineWidth: -1 }));
  fs.renameSync(file + '.tmp', file);
  return feed.files.length;
}
function report(result) {
  if (result.errors.length) {
    console.error(`发布安全门禁失败：\n${result.errors.map(e => `- ${e}`).join('\n')}`);
    return false;
  }
  console.log(`发布安全门禁通过：${result.files.length} 个运行时文件，无白名单外文件或凭据特征。`);
  return true;
}
async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') throw new Error('当前门禁仅支持 macOS 桌面产物');
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!report(scanApp(app))) throw new Error('发布物检查失败，不许签名或上传');
}
function assertNotaryEnv(env) {
  if (env.APPLE_KEYCHAIN_PROFILE) {
    if (!env.APPLE_ID && !env.APPLE_APP_SPECIFIC_PASSWORD && !env.APPLE_API_KEY) return;
  } else if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) return;
  throw new Error('正式出包需要完整的 Apple 公证环境变量或钥匙串 profile；不要混用。凭据只能在仓库外配置。');
}
module.exports = afterPack;
Object.assign(module.exports, { APP_FILES, NPM_FILES, scanApp, scanNpm, scanTree, checkName, checkContent, assertNotaryEnv, refreshMacFeed });
if (require.main === module) {
  (async () => {
    const [mode, target] = process.argv.slice(2);
    if (mode === '--check-notary') {
      if (fs.existsSync(path.join(__dirname, '../electron/build/notarize.env'))) throw new Error('仓库内仍有公证凭据文件，请先迁出仓库。');
      assertNotaryEnv(process.env); console.log('公证配置前置检查通过（未输出凭据）。');
    } else if (mode === '--npm') process.exitCode = report(scanNpm(path.resolve(target || '.'))) ? 0 : 1;
    else if (mode === '--app' && target) process.exitCode = report(scanApp(path.resolve(target))) ? 0 : 1;
    else if (mode === '--mac-feed' && target) {
      const count = await refreshMacFeed(path.resolve(target));
      console.log(`自动更新清单已刷新：${count} 个文件的大小与 sha512，主更新文件为 zip。`);
    } else throw new Error('用法：--npm [目录] / --app <Atlas.app> / --check-notary / --mac-feed <产物目录>');
  })().catch(e => { console.error(e.message); process.exitCode = 1; });
}
