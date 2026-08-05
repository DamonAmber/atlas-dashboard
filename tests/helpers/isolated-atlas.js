// 隔离测试实例 helper
//
// 为什么需要它：多数 spec 原本连用户本机 :4321 上跑着的 Atlas，测的是真实
// ~/.atlas/config.json、真实 store（备注名 / 未读 / 最近打开）和真实文档。代价是：
//   ① 跑一次测试就可能弄乱正在用的看板；中断的测试还会残留脏数据
//      （toast.spec 失败时会往 scanRoots 塞临时目录，越堆越慢、越慢越容易再失败）
//   ② 测的是全局安装的那份代码，不是工作区代码，改了代码却测到旧版
//   ③ 必须先手动把服务起着，CI 里还得额外准备 fixture
//
// 用法：
//   const { startAtlas } = require('./helpers/isolated-atlas');
//   const atlas = await startAtlas({ files: { 'proj/a.html': '<h1>x</h1>' } });
//   ...  atlas.base / atlas.scanDir / atlas.filePath('proj/a.html')
//   await atlas.stop();
//
// 实例完全独立：临时 ATLAS_HOME（自带 config/store）+ 临时扫描根 + 随机端口，
// 结束后整个临时目录删除，绝不触碰用户真实数据。

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

// 端口从 4340 起随机取，避开用户默认的 4321 与 preview-live-edit 用的 4300~4380
function pickPort() {
  return 4400 + Math.floor(Math.random() * 400);
}

function health(base) {
  return new Promise((resolve) => {
    const req = http.get(`${base}/api/state`, (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => { req.destroy(); resolve(false); });
  });
}

/**
 * 起一个隔离的 Atlas 实例。
 *
 * @param {object}  opts
 * @param {object}  opts.files      { 相对路径: 内容 }，写到临时扫描根下（自动建父目录）
 * @param {object}  opts.config     额外的 config 字段，覆盖默认值
 * @param {number}  opts.scanRootCount 建几个扫描根（默认 1），多根场景用
 * @param {string}  opts.prefix     临时目录前缀，便于排查
 * @returns {Promise<object>} 实例句柄
 */
async function startAtlas(opts = {}) {
  const {
    files = {},
    config: extraConfig = {},
    scanRootCount = 1,
    prefix = 'atlas-spec-',
  } = opts;

  const port = pickPort();
  const base = `http://127.0.0.1:${port}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });

  // 扫描根：scan / scan2 / scan3 …
  const scanDirs = [];
  for (let i = 0; i < scanRootCount; i++) {
    const d = path.join(tmp, i === 0 ? 'scan' : `scan${i + 1}`);
    fs.mkdirSync(d, { recursive: true });
    scanDirs.push(d);
  }

  // fixture 文档写到第一个扫描根
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(scanDirs[0], rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  const configPath = path.join(home, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    scanRoots: scanDirs,
    ignore: ['node_modules', '.git'],
    port,
    maxDepth: 6,
    docTypes: ['html', 'md'],
    ...extraConfig,
  }, null, 2));

  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: {
      ...process.env,
      ATLAS_HOME: home,
      ATLAS_CONFIG_PATH: configPath,
      ATLAS_STORE_PATH: path.join(home, 'store.json'),
      ATLAS_PUBLIC_DIR: path.join(ROOT, 'public'),
      ATLAS_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', d => logs.push(String(d)));
  child.stderr.on('data', d => logs.push(String(d)));

  // 同步清理：kill 子进程 + 删临时目录。做成同步是为了能挂到 process exit 上——
  // spec 断言失败时会 process.exit(1)，异步清理来不及跑，子进程和临时目录就泄漏了。
  let stopped = false;
  const stopSync = () => {
    if (stopped) return;
    stopped = true;
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  };
  // 兜底：无论正常结束、抛异常还是 process.exit，都不留残渣
  process.once('exit', stopSync);
  process.once('SIGINT', () => { stopSync(); process.exit(130); });
  process.once('SIGTERM', () => { stopSync(); process.exit(143); });

  let healthy = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await health(base)) { healthy = true; break; }
    if (child.exitCode !== null) break;
  }
  if (!healthy) {
    const log = logs.join('');
    stopSync();
    throw new Error('隔离 Atlas 实例启动失败：\n' + log);
  }

  return {
    base,
    port,
    tmpDir: tmp,
    homeDir: home,
    configPath,
    storePath: path.join(home, 'store.json'),
    scanDir: scanDirs[0],
    scanDirs,
    /** 扫描根下某个相对路径的绝对路径 */
    filePath: (rel) => path.join(scanDirs[0], rel),
    /** 读当前 config.json */
    readConfig: () => JSON.parse(fs.readFileSync(configPath, 'utf8')),
    /** 读当前 store.json（不存在则返回 null） */
    readStore: () => {
      try { return JSON.parse(fs.readFileSync(path.join(home, 'store.json'), 'utf8')); }
      catch { return null; }
    },
    /** 新建一个空目录（给"添加扫描根"这类用例用），返回绝对路径 */
    makeDir: (name) => {
      const d = path.join(tmp, name);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
    serverLogs: () => logs.join(''),
    stopSync,
    async stop() { stopSync(); },
  };
}

/**
 * 生成"有规模"的 fixture 文档树，供帧率 / 滚动 / 拖拽类 spec 用。
 * 这些用例原本依赖用户真实的几百篇文档才有意义，用它就能在隔离实例里造出同等规模。
 *
 * @param {object} opts
 * @param {number} opts.projects        分组数（每个分组会成为目录树里的一个 folder）
 * @param {number} opts.filesPerProject 每个分组的文档数
 * @param {boolean} opts.longContent    文档正文是否填充到足够长（供 iframe 内滚动测试）
 * @param {string[]} opts.keywords      掺进正文的关键词（供全文搜索类用例探测）
 * @returns {object} { 相对路径: 内容 } 可直接传给 startAtlas 的 files
 */
function makeTreeFixtures(opts = {}) {
  const {
    projects = 6,
    filesPerProject = 20,
    longContent = false,
    keywords = ['echarts', 'svg', 'rgb', 'flex', 'chart', '数据'],
  } = opts;

  const files = {};
  const filler = longContent
    ? '<p>填充行：让文档长到足以出现滚动条 lorem ipsum dolor sit amet 内容 数据</p>\n'.repeat(300)
    : '';

  for (let p = 1; p <= projects; p++) {
    const proj = `proj-${String(p).padStart(2, '0')}`;
    for (let f = 1; f <= filesPerProject; f++) {
      const kw = keywords[(p + f) % keywords.length];
      const idx = String(f).padStart(2, '0');
      // 每组末尾掺一个 .md，保证 html/md 混合
      if (f === filesPerProject) {
        files[`${proj}/note-${idx}.md`] = `# ${proj} 笔记 ${idx}\n\n正文包含关键词 ${kw}。\n`;
      } else {
        files[`${proj}/doc-${idx}.html`] =
          `<!doctype html><html><head><title>${proj} ${idx}</title></head><body>`
          + `<h1>${proj} 文档 ${idx}</h1><p>正文包含关键词 ${kw}。</p>${filler}</body></html>`;
      }
    }
  }
  return files;
}

module.exports = { startAtlas, makeTreeFixtures };
