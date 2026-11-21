// 发布门禁单测：只操作临时产物，不启动服务、不接触 ~/.atlas，不读取真实凭据。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const gate = require('../scripts/release-security');
const pkg = require('../package.json');
const ROOT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-release-security-spec-'));
let passed = 0;
function check(name, f) { f(); passed++; console.log(`✓ ${name}`); }
function put(root, rel, text = '正常的运行时文件') {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function appFixture(name) {
  const app = path.join(tmp, `${name}.app`), root = path.join(app, 'Contents', 'Resources', 'app');
  for (const rel of gate.APP_FILES.filter(f => !f.includes('*'))) put(root, rel);
  put(root, 'public/vendor/katex/fonts/KaTeX_Main-Regular.woff2');
  return { app, root };
}
function contentErrors(text) { const errors = []; gate.checkContent('fixture.js', Buffer.from(text), errors); return errors; }
try {
  check('npm 只含开源运行时白名单', () => assert.deepStrictEqual(pkg.files, gate.NPM_FILES));
  check('桌面包只含显式白名单，保留 asar:false', () => {
    assert.deepStrictEqual(pkg.build.files, gate.APP_FILES);
    assert.strictEqual(pkg.build.asar, false);
    assert(!pkg.build.files.includes('electron/**'));
  });
  check('保持 MIT / 可发布 npm，不引入遥测', () => {
    assert.strictEqual(pkg.license, 'MIT'); assert(!pkg.private);
    assert(!gate.APP_FILES.some(f => /telemetry|npm-sunset/.test(f)));
  });
  check('所有出包链路挂门禁', () => {
    assert.strictEqual(pkg.build.afterPack, './scripts/release-security.js');
    assert(pkg.scripts.prepack.includes('--npm'));
    assert(pkg.scripts['app:build'].startsWith('node scripts/release-security.js --check-notary &&'));
    assert(pkg.scripts['app:dir'].includes('--dir'));
  });
  const clean = appFixture('clean');
  check('正常开源 App 和生产依赖通过', () => {
    put(clean.root, 'node_modules/express/index.js', 'module.exports = {};');
    put(path.dirname(clean.root), 'app-update.yml', 'provider: github');
    assert.deepStrictEqual(gate.scanApp(clean.app).errors, []);
  });
  for (const filename of ['electron/build/notarize.env', 'electron/build/.env.local',
    'electron/build/cert.p12', 'electron/build/secret.pem', 'electron/build/private.key',
    'node_modules/dep/.npmrc', 'node_modules/dep/id_rsa']) {
    check(`阻止凭据文件 ${filename}`, () => {
      const fixture = appFixture(`name-${passed}`); put(fixture.root, filename);
      assert(gate.scanApp(fixture.app).errors.some(e => /凭据|私钥/.test(e)));
    });
  }
  check('目录白名单不能夹带未知 electron 或 lib 文件', () => {
    const fixture = appFixture('extra'); put(fixture.root, 'electron/notes.txt'); put(fixture.root, 'lib/unknown.js');
    assert.strictEqual(gate.scanApp(fixture.app).errors.filter(e => /白名单外/.test(e)).length, 2);
  });
  for (const text of ['APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_ID = "fixture@example.invalid"',
    'npm_' + 'a'.repeat(36), 'ghp_' + 'b'.repeat(36), 'github_pat_' + 'c'.repeat(40),
    'abcd-efgh-ijkl-mnop', '-----BEGIN RSA PRIVATE KEY-----']) {
    check(`阻止内容特征 ${passed}`, () => assert(contentErrors(text).length > 0));
  }
  check('普通连字符标识符不会误报 App 密码', () => {
    assert.deepStrictEqual(contentErrors('prefix-abcd-efgh-ijkl-mnop-suffix'), []);
  });
  check('跨 64KB 分块的 token 不漏检', () => {
    const fixture = appFixture('boundary');
    put(fixture.root, 'server.js', 'x'.repeat(65530) + ' npm_' + 'd'.repeat(36));
    assert(gate.scanApp(fixture.app).errors.some(e => e.includes('npm token')));
  });
  check('Resources 顶层与嵌套文件同样检查', () => {
    const fixture = appFixture('resources');
    put(path.dirname(fixture.root), 'extra/sub/credentials.txt', 'ghp_' + 'e'.repeat(36));
    assert(gate.scanApp(fixture.app).errors.some(e => e.includes('GitHub token')));
  });
  check('拒绝符号链接，不跟随读取根外文件', () => {
    const fixture = appFixture('symlink');
    fs.symlinkSync('/does-not-exist', path.join(fixture.root, 'external'));
    assert(gate.scanApp(fixture.app).errors.some(e => e.includes('符号链接')));
  });
  check('产物根目录也不能是符号链接', () => {
    const fixture = appFixture('root-link');
    const link = path.join(tmp, 'linked-root'); fs.symlinkSync(fixture.root, link);
    assert(gate.scanTree(link, { channel: 'app' }).errors.length > 0);
  });
  check('缺少 KaTeX 字体必须失败', () => {
    const fixture = appFixture('no-font');
    fs.unlinkSync(path.join(fixture.root, 'public/vendor/katex/fonts/KaTeX_Main-Regular.woff2'));
    assert(gate.scanApp(fixture.app).errors.some(e => e.includes('字体')));
  });
  check('缺失 App 或运行时文件必须失败', () => {
    assert(gate.scanApp(path.join(tmp, 'missing.app')).errors.length > 0);
    const fixture = appFixture('missing-runtime'); fs.unlinkSync(path.join(fixture.root, 'server.js'));
    assert(gate.scanApp(fixture.app).errors.some(e => e.includes('缺少运行时')));
  });
  check('意外 asar 产物不会成为扫描盲区', () => {
    const fixture = appFixture('asar'); put(path.dirname(fixture.root), 'app.asar');
    assert(gate.scanApp(fixture.app).errors.some(e => e.includes('asar')));
  });
  check('正式出包无公证配置即失败，钥匙串配置通过', () => {
    assert.throws(() => gate.assertNotaryEnv({}));
    gate.assertNotaryEnv({ APPLE_KEYCHAIN_PROFILE: 'atlas-notary' });
    assert.throws(() => gate.assertNotaryEnv({ APPLE_KEYCHAIN_PROFILE: 'atlas-notary', APPLE_ID: 'fixture' }));
    assert.throws(() => gate.assertNotaryEnv({ APPLE_KEYCHAIN_PROFILE: 'atlas-notary', APPLE_API_KEY: 'fixture' }));
    assert.throws(() => gate.assertNotaryEnv({ APPLE_ID: 'fixture', APPLE_TEAM_ID: 'fixture' }));
    gate.assertNotaryEnv({ APPLE_ID: 'fixture', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'fixture' });
  });
  check('真实 npm tarball 通过且没有桌面资源、构建脚本或埋点', () => {
    const result = gate.scanNpm(ROOT);
    assert.deepStrictEqual(result.errors, []);
    assert(!result.files.some(f => /^(electron|scripts|tests|infra|npm-sunset)\//.test(f)));
    assert(result.files.includes('bin/atlas.js'));
  });
  check('外层 npm dry-run 的 prepack 门禁仍能生成临时检查归档', () => {
    const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--cache', path.join(tmp, 'dry-run-cache')], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
    });
    assert.strictEqual(result.status, 0, 'dry-run 应通过门禁而不继承到内部 pack');
  });
  const npmFixture = path.join(tmp, 'npm');
  for (const rel of gate.NPM_FILES.filter(f => !f.includes('*'))) put(npmFixture, rel);
  put(npmFixture, 'public/vendor/katex/fonts/KaTeX_Main-Regular.woff2');
  put(npmFixture, 'package.json', JSON.stringify({ name: 'atlas-security-fixture', version: '1.0.0', files: gate.NPM_FILES }));
  check('npm 门禁检查归档内容，凭据写进合法文件也失败', () => {
    put(npmFixture, 'server.js', 'npm_' + 'f'.repeat(36));
    assert(gate.scanNpm(npmFixture).errors.some(e => e.includes('npm token')));
  });
  check('npm 改宽 files 仍被独立白名单拦住', () => {
    put(npmFixture, 'server.js');
    const p = JSON.parse(fs.readFileSync(path.join(npmFixture, 'package.json')));
    p.files.push('electron/**'); put(npmFixture, 'package.json', JSON.stringify(p));
    put(npmFixture, 'electron/notes.txt');
    assert(gate.scanNpm(npmFixture).errors.some(e => e.includes('白名单外')));
  });
  check('CLI 失败返回非零，日志不包含匹配值', () => {
    const fixture = appFixture('logging'); const fake = 'ghp_' + 'z'.repeat(36);
    put(fixture.root, 'server.js', fake);
    const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/release-security.js'), '--app', fixture.app], { encoding: 'utf8' });
    assert.strictEqual(result.status, 1); assert(!`${result.stdout}${result.stderr}`.includes(fake));
  });
  console.log(`\n通过 ${passed} 项，失败 0 项。`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
