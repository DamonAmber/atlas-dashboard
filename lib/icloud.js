// iCloud 云盘支持（design §2）：纯函数、iCloud 根解析、下载目标解析、
// file:// 渲染依赖检查、SSE 批量合并器、测试钩子与读审计。
//
// 这里的东西都可以在 Linux 上纯 node 单测：
//   · 判定 dataless / 占位文件只看 stat 字段与文件名，平台由参数给出（ATLAS_ICLOUD_PLATFORM 可覆盖）
//   · 渲染依赖检查的 I/O 全部注入（stat / readText / isDataless / cloudKindNow）
//   · 测试钩子只在 ATLAS_TEST_CLOUD + ATLAS_HOME 同时设置、且钩子文件在 ATLAS_HOME 之内时启用
//
// 只依赖 Node 内置模块与 ./paths。
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { fileURLToPath } = require('url');
const paths = require('./paths');

// ---------- §2.1 纯函数 ----------

// `.报告.md.icloud` → `报告.md`。inner 以 . 开头（`..x.md.icloud`）或含路径分隔符时不认：
// 前者是隐藏文件的占位，后者不可能是合法文件名。是不是文档类型由调用方判断。
function placeholderOriginalName(name) {
  const m = /^\.(.+)\.icloud$/.exec(String(name == null ? '' : name));
  if (!m) return null;
  const inner = m[1];
  if (inner.startsWith('.') || inner.includes('/') || inner.includes('\\')) return null;
  return inner;
}

function placeholderPathFor(absPath) {
  return path.join(path.dirname(absPath), '.' + path.basename(absPath) + '.icloud');
}

// dataless：有大小、但一个数据块都没占（内容还在云端）。
// blocks 拿不到（undefined / NaN）时一律当本地：宁可多读也不能把本地文件误判成云端。
function isDatalessStat(st, platform) {
  if (platform !== 'darwin' || !st) return false;
  if (typeof st.isFile !== 'function' || !st.isFile()) return false;
  if (!Number.isFinite(st.size) || st.size <= 0) return false;
  return Number.isFinite(st.blocks) && st.blocks === 0;
}

// 两次记录之间是「只是云端状态变了」还是「内容变了」（design §6.2）
function classifyTransition(prev, next) {
  if (!prev || !next) return 'content';
  const pc = (prev && prev.cloud) || null;
  const nc = (next && next.cloud) || null;
  const sameSize = prev.size === next.size;
  const sameMtime = prev.mtime === next.mtime;
  if (pc !== nc && (pc === 'placeholder' || nc === 'placeholder' || (sameSize && sameMtime))) return 'state';
  if (pc === nc && sameSize && sameMtime) return 'none';
  return 'content';
}

// target 严格位于 root 之内（不含 root 本身）。不用 rel.startsWith('..')：那会误拒 `..foo/x.md`。
function isWithin(rootReal, targetReal) {
  const rel = path.relative(rootReal, targetReal);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

function isWithinOrEqual(root, p) {
  const rel = path.relative(root, p);
  return rel === '' || isWithin(root, p);
}

// 只认行首的命令名：帮助里别的命令的说明文字提到 download 不算
function parseBrctlHelp(output) {
  return { download: /^download(\s|$)/m.test(String(output == null ? '' : output)) };
}

// ~/Library/CloudStorage 下是 Dropbox / OneDrive / Google Drive 的 File Provider，
// 也会产生 dataless 文件，但不是 iCloud。只影响文案。
function iCloudLabelFor(absPath, homedir) {
  const cs = path.join(homedir, 'Library', 'CloudStorage');
  return isWithin(cs, path.resolve(absPath)) ? '仅在云端' : '在 iCloud 中';
}

// ---------- 资源引用提取（给 §4.3 的依赖检查用） ----------

function decodeHtmlEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|quot|apos|amp|lt|gt);/gi, (m, e) => {
    const l = e.toLowerCase();
    if (l[0] === '#') {
      const cp = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' }[l];
  });
}

// 开始标签：属性值里带 > 也不会截断（引号内整体吃掉）
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR_RE = /(?:^|\s)(src|poster|data|href|xlink:href|srcset|imagesrcset|srcdoc|content|http-equiv)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;
// href 只在这些标签上会被渲染器加载；<a> / <area> 不算（否则任何链接到云端文档的页面都截不了图）
const HREF_TAGS = new Set(['link', 'image', 'use', 'feimage', 'script', 'source']);
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\()?\s*["']?([^"')\s;]+)/gi;
const LITERAL_RE = /["'`]([^"'`\s]+\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|json|csv|txt|woff2?|ttf|otf|mp4|webm|mov|mp3|wav|ogg|pdf|html?|md))["'`]/gi;
const MD_IMG_RE = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)/g;
const MD_REFDEF_RE = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?\s*$/gm;
const JS_IMPORT_RE = /\b(?:import|export)\b[^'"`]*?['"`]([^'"`]+)['"`]/g;
const JS_DYN_IMPORT_RE = /\bimport\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
const META_URL_RE = /url\s*=\s*['"]?([^'";\s]+)/i;

// 每次用一个新的 RegExp 实例：srcdoc 会递归进同一组规则，共用 lastIndex 会把外层循环拨回开头
function eachMatch(pattern, text, fn) {
  const re = new RegExp(pattern.source, pattern.flags);
  let m;
  while ((m = re.exec(text)) !== null) {
    fn(m);
    if (m[0] === '') re.lastIndex++;
  }
}

function collectTags(text, out, state, depth) {
  eachMatch(TAG_RE, text, (tm) => {
    const tag = tm[1].toLowerCase();
    const attrs = tm[2] || '';
    let httpEquiv = null;
    let content = null;
    eachMatch(ATTR_RE, attrs, (am) => {
      const name = am[1].toLowerCase();
      const unquoted = am[4] !== undefined;
      let v = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4];
      v = decodeHtmlEntities(v);
      const push = (x) => {
        out.push(x);
        // `<img src=a.png/>`：不带引号的值会把自闭合的 / 吃进来，去掉它的版本也算一条（多抓）
        if (unquoted && x.length > 1 && x.endsWith('/')) out.push(x.slice(0, -1));
      };
      switch (name) {
        case 'src': case 'poster': case 'data':
          push(v); break;
        case 'href': case 'xlink:href':
          if (tag === 'base') { if (state.base == null) state.base = v; }
          else if (HREF_TAGS.has(tag)) push(v);
          break;
        case 'srcset': case 'imagesrcset':
          for (const part of v.split(',')) {
            const u = part.trim().split(/\s+/)[0];
            if (u) push(u);
          }
          break;
        case 'srcdoc':
          // 属性值已经做过实体解码，按 html 递归，最多 2 层
          if (depth < 2) {
            const sub = extractRaw(v, 'html', depth + 1);
            for (const r of sub.raw) out.push(r);
          }
          break;
        case 'http-equiv':
          if (httpEquiv == null) httpEquiv = v; break;
        case 'content':
          if (content == null) content = v; break;
        default: break;
      }
    });
    if (tag === 'meta' && httpEquiv != null && httpEquiv.trim().toLowerCase() === 'refresh' && content != null) {
      const mm = META_URL_RE.exec(content);
      if (mm) out.push(mm[1]);
    }
  });
}

function collectCss(text, out) {
  eachMatch(CSS_URL_RE, text, (m) => out.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]));
  eachMatch(CSS_IMPORT_RE, text, (m) => out.push(m[1]));
}
// 字面量规则对全文跑，但 <a> / <area> 的开始标签先抹掉：它们的 href 渲染器不会加载，
// 否则 `<a href="doc.md">` 会被字面量规则捡回来，让「链接到云端文档」的页面截不了图
const NON_LOADING_TAG_RE = /<(?:a|area)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
function stripNonLoadingTags(text) {
  return text.replace(NON_LOADING_TAG_RE, (m) => ' '.repeat(m.length));
}

function collectLiterals(text, out) {
  eachMatch(LITERAL_RE, text, (m) => out.push(m[1]));
}

// 按 kind 跑对应规则，返回未规整的原始引用
function extractRaw(text, kind, depth) {
  const src = String(text == null ? '' : text);
  const raw = [];
  const state = { base: null };
  if (kind === 'html' || kind === 'svg') {
    collectTags(src, raw, state, depth);
    collectCss(src, raw);
    collectLiterals(stripNonLoadingTags(src), raw);
  } else if (kind === 'css') {
    collectCss(src, raw);
    collectLiterals(src, raw);
  } else if (kind === 'md') {
    eachMatch(MD_IMG_RE, src, (m) => raw.push(m[1]));
    eachMatch(MD_REFDEF_RE, src, (m) => raw.push(m[1]));
    // MD 里的内联 HTML（含 <style> / style=""）走标签与 CSS 规则
    collectTags(src, raw, state, depth);
    collectCss(src, raw);
    collectLiterals(src, raw);
  } else if (kind === 'js') {
    collectLiterals(src, raw);
    eachMatch(JS_IMPORT_RE, src, (m) => raw.push(m[1]));
    eachMatch(JS_DYN_IMPORT_RE, src, (m) => raw.push(m[1]));
  }
  return { raw, base: state.base };
}

// 规整一条引用：丢掉非本地协议与锚点，去 ?query / #hash，尽量 decode。丢弃时返回 null。
function normalizeRef(r) {
  let s = String(r == null ? '' : r).trim();
  if (!s || s.startsWith('#') || s.startsWith('//')) return null;
  const sch = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  let isFile = false;
  if (sch && sch[1].length > 1) {   // 一个字母的「协议」是 Windows 盘符
    if (sch[1].toLowerCase() !== 'file') return null;   // http / data / blob / mailto / javascript / about …
    isFile = true;
  }
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  if (!s) return null;
  if (isFile) return s;   // 调用方用 fileURLToPath
  try { s = decodeURIComponent(s); } catch {}
  return s || null;
}

/**
 * 从文档 / 样式 / 脚本文本里找出可能被 file:// 渲染器加载的本地资源引用。规则一律宁可多抓。
 * @param {string} text
 * @param {'html'|'md'|'svg'|'css'|'js'} kind
 * @returns {{ refs: string[], overflow: boolean, base: string|null }}
 */
function extractLocalResourceRefs(text, kind, { max = 2000 } = {}) {
  const { raw, base } = extractRaw(text, kind, 0);
  const seen = new Set();
  for (const r of raw) {
    const n = normalizeRef(r);
    if (n) seen.add(n);
  }
  const all = [...seen];
  const overflow = all.length > max;
  return { refs: overflow ? all.slice(0, max) : all, overflow, base: base == null ? null : String(base).trim() };
}

// ---------- §4.3 file:// 渲染依赖检查 ----------

// 渲染器会继续加载、并且其中还能再引用别的资源的文本类型
const FOLLOW = { '.css': 'css', '.html': 'html', '.htm': 'html', '.svg': 'svg', '.js': 'js', '.mjs': 'js' };
// stat 这些错误时 Chromium 也读不到这个文件，不会触发下载 → 跳过这条引用
const SKIP_STAT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EPERM', 'EACCES', 'ENAMETOOLONG', 'ELOOP', 'EINVAL']);

function schemeOf(s) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(s);
  return m && m[1].length > 1 ? m[1].toLowerCase() : null;
}

// 文档自己的解析基准：所在目录；有 <base href> 时按它解析。远程 base 下相对引用不是本地文件 → []
function baseDirsFor(file, rawBase) {
  const dir = path.dirname(file);
  if (rawBase == null || !String(rawBase).trim()) return [dir];
  const b = String(rawBase).trim().replace(/[?#].*$/, '');
  if (!b) return [dir];
  const sch = schemeOf(b);
  if (b.startsWith('//') || (sch && sch !== 'file')) return [];
  let p;
  if (sch === 'file') {
    try { p = fileURLToPath(b); } catch { return [dir]; }
  } else {
    let s = b;
    try { s = decodeURIComponent(s); } catch {}
    p = path.resolve(dir, s);
  }
  return [/[\\/]$/.test(b) ? path.resolve(p) : path.dirname(path.resolve(p))];
}

function refToPaths(ref, bases) {
  if (schemeOf(ref) === 'file') {
    try { return [path.resolve(fileURLToPath(ref))]; } catch { return []; }
  }
  if (ref.startsWith('/') || path.isAbsolute(ref)) return [path.resolve(ref)];   // file:// 语义：以 / 开头即文件系统绝对路径
  return bases.map((b) => path.resolve(b, ref));
}

async function checkRenderDepsInner(o) {
  const {
    abs, kind, cloudKindNow, stat, isDataless, readText,
    maxFileBytes = 32 * 1024 * 1024,
    maxTotalBytes = 64 * 1024 * 1024,
    maxRefs = 2000,
    maxFollowDepth = 3,
  } = o;
  if (await cloudKindNow(abs)) return 'cloud';
  if (kind !== 'html' && kind !== 'md' && kind !== 'svg') return null;

  const src = path.resolve(abs);
  const visited = new Set([src]);
  const seenRefs = new Set();
  let totalBytes = 0;
  let unverified = false;
  // 队列元素 { file, kind, depth, docBases }：docBases 是「引入它的文档」的解析基准，只给 js 用
  const queue = [{ file: src, kind, depth: 0, docBases: null }];
  while (queue.length) {
    const item = queue.shift();
    // 走到这里的文件都已确认不是 dataless（源文件由 cloudKindNow 判过，其余入队前 stat 判过）
    const r = await readText(item.file, maxFileBytes);
    const text = r && r.text != null ? String(r.text) : '';
    if (r && r.truncated) return 'deps-unverified';
    totalBytes += r && Number.isFinite(r.bytes) ? r.bytes : Buffer.byteLength(text);
    if (totalBytes > maxTotalBytes) return 'deps-unverified';
    const ex = extractLocalResourceRefs(text, item.kind, { max: maxRefs });
    if (ex.overflow) return 'deps-unverified';

    let bases;
    let childDocBases;
    if (item.kind === 'html' || item.kind === 'svg') {
      bases = baseDirsFor(item.file, ex.base);
      childDocBases = bases;
    } else if (item.kind === 'js') {
      // 脚本里的相对路径在运行时按文档的 base 解析，但 import 按脚本自己的目录解析：两种都 stat（宁可多抓）
      bases = [...new Set([path.dirname(item.file), ...(item.docBases || [])])];
      childDocBases = item.docBases || [path.dirname(item.file)];
    } else {
      bases = [path.dirname(item.file)];   // css / md
      childDocBases = bases;
    }

    for (const ref of ex.refs) {
      for (const p of refToPaths(ref, bases)) {
        if (seenRefs.has(p)) continue;
        seenRefs.add(p);
        if (seenRefs.size > maxRefs) return 'deps-unverified';
        let st;
        try { st = await stat(p); } catch (e) {
          if (e && SKIP_STAT_CODES.has(e.code)) continue;
          throw e;
        }
        if (isDataless(p, st)) return 'cloud-deps';
        const fk = FOLLOW[path.extname(p).toLowerCase()];
        if (!fk || visited.has(p) || !st || typeof st.isFile !== 'function' || !st.isFile()) continue;
        visited.add(p);
        // 层数超了不立即返回：同一批里后面可能还有 dataless 引用，那时应当报 cloud-deps
        if (item.depth + 1 > maxFollowDepth) { unverified = true; continue; }
        queue.push({ file: p, kind: fk, depth: item.depth + 1, docBases: childDocBases });
      }
    }
  }
  return unverified ? 'deps-unverified' : null;
}

/**
 * file:// 渲染（缩略图 / PDF 导出）之前的依赖检查，fail-closed：拿不准就拦。
 *
 * 第 7 步是「本地文本资源队列」（plan M2）：css / html / svg / js 子资源都会被继续读取并提取引用，
 * 三项预算（visited、去重后的引用数、累计读取字节）全队列共享；dataless 判定永远先于 readText，
 * 所以 dataless 的子资源本身不会被读。
 *
 * 唯一已知的漏网：脚本在运行时**拼出来**的路径（`'img/' + name + '.png'`）——静态提取看不到它。
 *
 * 任何抛错（readText 失败、stat 的非常规错误等）都按 'deps-unverified' 处理，不抛给调用方（plan M3）。
 *
 * @returns {Promise<null|'cloud'|'cloud-deps'|'deps-unverified'>}
 */
async function checkRenderDeps(opts) {
  try {
    return await checkRenderDepsInner(opts);
  } catch (e) {
    const log = (opts && opts.log) || console;
    try { log.warn('  ! 依赖检查失败，按无法确认处理:', opts && opts.abs, e && (e.code || e.message)); } catch {}
    return 'deps-unverified';
  }
}

// ---------- §2.2 iCloud 根解析 ----------

function defaultExistsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * @returns {{ platform, enabled, root, rootExists, available, source, statDetection }}
 *   statDetection：ATLAS_CLOUD_DETECT=off 时为 false（只关 blocks 判定，给 blocks 恒为 0 的文件系统用）
 */
function resolveICloudConfig({ env = process.env, platform = process.platform, homedir, existsDir = defaultExistsDir } = {}) {
  const e = env || {};
  const ov = e.ATLAS_ICLOUD_PLATFORM;
  const plat = ov === 'darwin' || ov === 'linux' || ov === 'win32' ? ov : platform;
  const enabled = plat === 'darwin';
  let root;
  let source;
  const rv = typeof e.ATLAS_ICLOUD_ROOT === 'string' ? e.ATLAS_ICLOUD_ROOT.trim() : '';
  if (rv) {
    if (rv === 'off') { root = null; source = 'off'; }
    else { root = path.resolve(paths.expand(rv)); source = 'env'; }   // expand 只展开开头的 ~/，段内的 ~ 原样保留
  } else {
    const home = homedir || os.homedir();
    root = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    source = 'default';
  }
  const rootExists = root ? !!existsDir(root) : false;
  return {
    platform: plat,
    enabled,
    root,
    rootExists,
    available: enabled && !!root && rootExists,
    source,
    statDetection: String(e.ATLAS_CLOUD_DETECT || '').trim().toLowerCase() !== 'off',
  };
}

// ---------- §2.3 下载目标解析 ----------

const MAX_ANCESTOR_LEVELS = 64;

// 父目录不存在时：逐级向上找第一个能 realpath 的祖先，再把剩下的段原样拼回去（N1）
async function realpathOfNearestAncestor(abs, realpath = fsp.realpath) {
  const target = path.resolve(abs);
  let cur = path.dirname(target);
  for (let i = 0; i < MAX_ANCESTOR_LEVELS; i++) {
    try {
      const r = await realpath(cur);
      return path.join(r, path.relative(cur, target));
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return target;
}

// 同步孪生（plan M1）：测试钩子按 realpath 记账时用
function realpathOfNearestAncestorSync(abs) {
  const target = path.resolve(abs);
  let cur = path.dirname(target);
  for (let i = 0; i < MAX_ANCESTOR_LEVELS; i++) {
    try {
      const r = fs.realpathSync(cur);
      return path.join(r, path.relative(cur, target));
    } catch {}
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return target;
}

// 路径的规范写法：能 realpath 就用它，否则用最近祖先的 realpath 拼回剩余段
function canonPathSync(p) {
  try { return fs.realpathSync(p); } catch { return realpathOfNearestAncestorSync(p); }
}

/**
 * 下载目标的安全不变量只由这里负责：先判越界、再判存在（根外路径不论存不存在一律 403）。
 * @returns {Promise<{ok:true, abs, real, targetKind:'file'|'placeholder'} | {ok:false, code:400|403|404, error}>}
 *   abs 是身份（fileIndex key / SSE path / 钩子集合），real 是 I/O 目标（已解析全部符号链接）。
 *   targetKind 只决定 real 的来源；交给下载器的 kind 由调用方另用 cloudKindNow 求（N8）。
 */
async function resolveDownloadTarget(p, { roots = [], realpath = fsp.realpath, lstat = fsp.lstat, placeholderPath = placeholderPathFor } = {}) {
  if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) return { ok: false, code: 400, error: 'bad-request' };
  const abs = path.resolve(p);
  const rootsReal = (await Promise.all((roots || []).map((r) => realpath(r).catch(() => null)))).filter(Boolean);
  const parentReal = await realpath(path.dirname(abs)).catch(() => null);
  const lexical = parentReal ? path.join(parentReal, path.basename(abs)) : await realpathOfNearestAncestor(abs, realpath);
  if (!rootsReal.some((r) => isWithin(r, lexical))) return { ok: false, code: 403, error: 'outside-roots' };
  let real = null;
  try { real = await realpath(abs); } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, code: 403, error: 'unresolvable' };   // ELOOP / EACCES
  }
  if (real) {
    if (!rootsReal.some((r) => isWithin(r, real))) return { ok: false, code: 403, error: 'outside-roots' };   // 符号链接逃逸
    return { ok: true, abs, real, targetKind: 'file' };
  }
  // realpath ENOENT：abs 必须完全不存在。lstat 看得到说明是悬空符号链接
  if (await lstat(abs).then(() => true, () => false)) return { ok: false, code: 403, error: 'dangling-symlink' };
  if (!parentReal) return { ok: false, code: 404, error: 'not-found' };
  const ph = await lstat(placeholderPath(lexical)).catch(() => null);
  if (!ph || !ph.isFile()) return { ok: false, code: 404, error: 'not-found' };   // 占位文件本身是链接也拒
  return { ok: true, abs, real: lexical, targetKind: 'placeholder' };
}

// ---------- §5.5 批量合并器（SSE cloud 通道） ----------

const PHASE_RANK = { started: 0, state: 1, done: 2, error: 3 };

/**
 * 250ms 尾部去抖 + 1000ms maxWait；同一批里同一路径只发一条：
 * phase 取优先级最高的（error > done > state > started），reason / message 跟随被选中的 phase；
 * 其余字段（cloud / busy / mtime / size …）取最后一条。
 */
function createBatcher({
  debounceMs = 250, maxWaitMs = 1000, flush = () => {},
  now = Date.now, setTimeout: setT = setTimeout, clearTimeout: clearT = clearTimeout,
} = {}) {
  let items = new Map();
  let batchStart = 0;
  let timer = null;

  function fire() {
    timer = null;
    const out = [...items.values()];
    items = new Map();
    if (out.length) { try { flush(out); } catch {} }
  }
  function merge(prev, next) {
    const out = { ...prev };
    for (const k of Object.keys(next)) {
      if (k === 'phase' || k === 'reason' || k === 'message') continue;
      out[k] = next[k];
    }
    const pr = PHASE_RANK[prev.phase] != null ? PHASE_RANK[prev.phase] : -1;
    const nr = PHASE_RANK[next.phase] != null ? PHASE_RANK[next.phase] : -1;
    if (nr >= pr) {
      out.phase = next.phase;
      if ('reason' in next) out.reason = next.reason; else delete out.reason;
      if ('message' in next) out.message = next.message; else delete out.message;
    }
    return out;
  }
  function push(item) {
    if (!item || typeof item.path !== 'string') return;
    const t = now();
    if (!items.size) batchStart = t;
    const prev = items.get(item.path);
    items.set(item.path, prev ? merge(prev, item) : { ...item });
    const due = Math.min(t + debounceMs, batchStart + maxWaitMs);
    if (timer) clearT(timer);
    timer = setT(fire, Math.max(0, due - t));
    if (timer && timer.unref) timer.unref();
  }
  function flushNow() {
    if (timer) { clearT(timer); timer = null; }
    fire();
  }
  function close() {
    if (timer) { clearT(timer); timer = null; }
    items = new Map();
  }
  return { push, flushNow, close, pending: () => items.size };
}

// ---------- §2.4 测试钩子 ATLAS_TEST_CLOUD ----------

function parseHookText(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('钩子文件必须是 JSON 对象');
  // M1：所有 key 先 canon；同一 canon 的多种写法记第一次出现的，注入事件时还原成它
  const origOf = new Map();
  const canonOf = (p) => {
    const c = canonPathSync(p);
    if (!origOf.has(c)) origOf.set(c, p);
    return c;
  };
  const list = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === 'string' && s) : []);
  const toSet = (v) => new Set(list(v).map(canonOf));
  const toMap = (v) => {
    const m = new Map();
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k, x] of Object.entries(v)) if (k) m.set(canonOf(k), x);
    }
    return m;
  };
  const dataless = toSet(j.dataless);
  const sticky = toSet(j.stickyDataless);
  const silent = toSet(j.silent);
  const auditExtra = toSet(j.auditExtra);
  // N7：钩子不扫盘，审计集合 = dataless ∪ stickyDataless ∪ auditExtra，每个成员存 resolve 与 canon 两种写法
  const auditSet = new Set();
  for (const p of [...list(j.dataless), ...list(j.stickyDataless), ...list(j.auditExtra)]) {
    auditSet.add(path.resolve(p));
    auditSet.add(canonPathSync(p));
  }
  return {
    dataless, sticky, silent, auditExtra, auditSet, origOf,
    sizes: toMap(j.sizes),
    touchMeta: toMap(j.touchMeta),
    readBehavior: toMap(j.readBehavior),
    statDetection: j.statDetection === true,
    brctl: j.brctl === 'supported' || j.brctl === 'unsupported' ? j.brctl : null,
    brctlBehavior: j.brctlBehavior === 'fail' || j.brctlBehavior === 'hang' ? j.brctlBehavior : 'materialize',
    materializeContent: typeof j.materializeContent === 'string' ? j.materializeContent : '# materialized\n',
    settleMs: Number.isFinite(j.settleMs) && j.settleMs >= 0 ? j.settleMs : null,
    audit: j.audit === true,
  };
}

/**
 * 测试钩子。启用条件：ATLAS_TEST_CLOUD 与 ATLAS_HOME 都设置、钩子文件 realpath 在 realpath(configDir()) 之内、
 * 内容是 JSON 对象。没设 ATLAS_TEST_CLOUD 时静默返回 null；其余条件不满足时 warn 一行并返回 null。
 *
 * inject(paths: string[])：重载后云端集合的对称差（减去 silent）与 touchMeta 计数变化的路径，
 * 以钩子文件里的**原始写法**传入（同一 canon 多种写法取第一次出现的）。调用方负责把每个路径
 * 送进对应 watcher 的 emit('change', p)。启动时的初始状态不注入。
 */
function loadTestHook({ env = process.env, configDir = paths.configDir, log = console, inject = () => {}, pollMs = 100 } = {}) {
  const e = env || {};
  const rawFile = e.ATLAS_TEST_CLOUD;
  if (!rawFile) return null;
  const warn = (...a) => { try { (log.warn || console.warn).apply(log, a); } catch {} };
  if (!e.ATLAS_HOME) { warn('  ! 忽略 ATLAS_TEST_CLOUD：没有同时设置 ATLAS_HOME'); return null; }
  const file = path.resolve(rawFile);
  let fileReal;
  let cfgReal;
  try {
    fileReal = fs.realpathSync(file);
    cfgReal = fs.realpathSync(configDir());
  } catch (err) {
    warn('  ! 忽略 ATLAS_TEST_CLOUD：钩子文件或 ATLAS_HOME 不存在:', file, err && err.code);
    return null;
  }
  if (!isWithin(cfgReal, fileReal)) { warn('  ! 忽略 ATLAS_TEST_CLOUD：钩子文件不在 ATLAS_HOME 之内:', file); return null; }
  let state;
  let lastSig;
  try {
    const st = fs.statSync(file);
    lastSig = st.mtimeMs + ':' + st.size;
    state = parseHookText(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warn('  ! 忽略 ATLAS_TEST_CLOUD：钩子文件无法解析:', file, err && err.message);
    return null;
  }
  try { (log.log || console.log).call(log, `[test] iCloud 测试钩子已启用：${file}`); } catch {}

  const home = path.resolve(e.ATLAS_HOME);
  const callsFile = path.join(home, 'test-brctl-calls.jsonl');
  const materialized = new Set();   // 被桩「下载」掉的 canon 路径，只在内存里
  let mem = new Set();
  let closed = false;

  // mem = (fileDl − materialized) ∪ fileSticky
  function recompute() {
    const next = new Set();
    for (const c of state.dataless) if (!materialized.has(c)) next.add(c);
    for (const c of state.sticky) next.add(c);
    mem = next;
  }
  recompute();

  const origFor = (c, prevOrig) => state.origOf.get(c) || (prevOrig && prevOrig.get(c)) || c;

  function apply(next) {
    // 文件里「新加入」的 dataless 路径 → 显式重新设为云端
    for (const c of next.dataless) if (!state.dataless.has(c)) materialized.delete(c);
    const before = mem;
    const prevOrig = state.origOf;
    const prevTouch = state.touchMeta;
    state = next;
    recompute();
    const out = new Set();
    for (const c of before) if (!mem.has(c)) out.add(c);
    for (const c of mem) if (!before.has(c)) out.add(c);
    for (const c of next.silent) out.delete(c);
    for (const k of new Set([...prevTouch.keys(), ...next.touchMeta.keys()])) {
      if (prevTouch.get(k) !== next.touchMeta.get(k)) out.add(k);
    }
    if (out.size) {
      const list = [...out].map((c) => origFor(c, prevOrig));
      try { inject(list); } catch (err) { warn('  ! 测试钩子注入事件失败:', err && err.message); }
    }
  }

  function tryReload() {
    let next;
    try { next = parseHookText(fs.readFileSync(file, 'utf8')); } catch (err) {
      // N6：解析失败保留上一次状态，不清空集合、不注入事件
      warn('  ! 测试钩子文件解析失败，保留上一次状态:', file, err && err.message);
      return false;
    }
    apply(next);
    return true;
  }

  const timer = setInterval(() => {
    if (closed) return;
    let st;
    try { st = fs.statSync(file); } catch { return; }
    const sig = st.mtimeMs + ':' + st.size;
    if (sig === lastSig) return;
    lastSig = sig;
    tryReload();
  }, pollMs);
  if (timer.unref) timer.unref();

  function appendCall(obj) {
    try { fs.appendFileSync(callsFile, JSON.stringify(obj) + '\n'); } catch (err) { warn('  ! 写 test-brctl-calls.jsonl 失败:', err && err.message); }
  }

  function markMaterialized(real) {
    materialized.add(canonPathSync(real));
    recompute();
  }

  // 读取回退的桩：不真读文件（所以读审计不会把下载器自己算进去）。
  // 默认 delay:300；delay:N 延迟 N 毫秒后 materialize；fail:ERRNO 以对应 errno 失败、不改集合。
  function readStub(real, opts) {
    appendCall({ fn: 'read', path: real, opts: opts || {} });
    const s = new EventEmitter();
    s.destroyed = false;
    let t = null;
    const closeSoon = () => setImmediate(() => s.emit('close'));
    s.destroy = () => {
      if (s.destroyed) return s;
      s.destroyed = true;
      if (t) clearTimeout(t);
      closeSoon();
      return s;
    };
    const beh = String(state.readBehavior.get(canonPathSync(real)) || 'delay:300');
    const fm = /^fail:([A-Z0-9_]+)$/.exec(beh);
    const dm = /^delay:(\d+)$/.exec(beh);
    if (fm) {
      t = setTimeout(() => {
        if (s.destroyed) return;
        s.destroyed = true;
        const err = Object.assign(new Error(`${fm[1]}: 测试钩子模拟的读取失败`), { code: fm[1] });
        s.emit('error', err);
        closeSoon();
      }, 10);
    } else {
      const delay = dm ? +dm[1] : 300;
      t = setTimeout(() => {
        if (s.destroyed) return;
        s.emit('data', Buffer.from('x'));
        markMaterialized(real);   // stickyDataless 不受影响（mem 里并上 sticky）
        s.destroyed = true;
        s.emit('end');
        closeSoon();
      }, delay);
    }
    return s;
  }

  // brctl 的桩：签名同 child_process.execFile(file, args, opts, cb)，返回带 kill() 的假子进程
  function brctlStub(fileArg, args, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    appendCall({ fn: 'brctl', file: fileArg, argv: Array.isArray(args) ? args.slice() : args, opts: opts || {} });
    const child = new EventEmitter();
    child.killed = false;
    child.kills = [];
    let done = false;
    let t = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      setImmediate(() => {
        try { if (typeof cb === 'function') cb(err || null, '', err ? 'brctl: failed' : ''); } catch {}
        child.emit('exit', err ? (err.code != null ? err.code : null) : 0, (err && err.signal) || null);
      });
    };
    child.kill = (sig = 'SIGTERM') => {
      child.kills.push(sig);
      if (done) return false;
      child.killed = true;
      finish(Object.assign(new Error('brctl killed'), { killed: true, code: null, signal: sig }));
      return true;
    };
    const behavior = state.brctlBehavior;
    if (behavior === 'hang') return child;
    const target = Array.isArray(args) && args[0] === 'download' ? args[1] : null;
    t = setTimeout(() => {
      if (behavior === 'fail' || typeof target !== 'string') {
        return finish(Object.assign(new Error('brctl exited with code 1'), { code: 1 }));
      }
      try {
        const ph = placeholderPathFor(target);
        let isPh = false;
        try { isPh = fs.lstatSync(ph).isFile(); } catch {}
        if (isPh) {
          fs.writeFileSync(target, state.materializeContent);
          fs.unlinkSync(ph);
        } else {
          markMaterialized(target);
        }
      } catch (err) {
        return finish(Object.assign(err, { code: 1 }));
      }
      finish(null);
    }, 20);
    return child;
  }

  const hook = {
    file,
    isDataless(abs) {
      if (!mem.size || typeof abs !== 'string') return false;
      return mem.has(canonPathSync(abs));
    },
    sizeOf(abs) {
      if (!state.sizes.size || typeof abs !== 'string') return undefined;
      const v = state.sizes.get(canonPathSync(abs));
      return Number.isFinite(v) ? v : undefined;
    },
    readStub,
    brctlStub,
    /** 'supported' | 'unsupported' | null（null = 不覆盖真实探测） */
    get brctlMode() { return state.brctl; },
    get brctlBehavior() { return state.brctlBehavior; },
    /** 钩子里的 settleMs，没写时为 null（调用方用默认值） */
    get settleMs() { return state.settleMs; },
    /** 测试模式下默认 false：关掉真实的 blocks 判定 */
    get statDetection() { return state.statDetection; },
    get audit() { return state.audit; },
    get auditSet() { return state.auditSet; },
    debug() {
      return {
        materialized: [...materialized].map((c) => origFor(c)),
        mem: [...mem].map((c) => origFor(c)),
      };
    },
    /** 立刻重读钩子文件（不等 100ms 轮询）。返回是否解析成功 */
    reloadNow() {
      try { const st = fs.statSync(file); lastSig = st.mtimeMs + ':' + st.size; } catch {}
      return tryReload();
    },
    close() {
      closed = true;
      clearInterval(timer);
    },
  };
  return hook;
}

/**
 * 读审计：包装 fs 的打开 / 读取 / 复制入口，路径（String / Buffer / URL）path.resolve 后命中
 * hook.auditSet 就往 auditFile 追加一行 {fn, path}。必须在其他模块 require 之前安装。
 * 已知盲区：模块加载时就解构拿走的函数（仓库里目前没有这种写法）。
 * @returns {() => void} 卸载函数（测试用）
 */
function installReadAudit(hook, auditFile) {
  const append = fs.appendFileSync;
  const promises = fs.promises;
  let busy = false;
  const toPathString = (p) => {
    if (typeof p === 'string') return p;
    if (Buffer.isBuffer(p)) return p.toString();
    if (p instanceof URL) { try { return fileURLToPath(p); } catch { return null; } }
    return null;   // fd / FileHandle
  };
  const note = (fn, p) => {
    if (busy) return;
    const s = toPathString(p);
    if (!s) return;
    let r;
    try { r = path.resolve(s); } catch { return; }
    const set = hook && hook.auditSet;
    if (!set || !set.has(r)) return;
    busy = true;
    try { append(auditFile, JSON.stringify({ fn, path: r }) + '\n'); } catch {} finally { busy = false; }
  };
  const restore = [];
  // Node 自己的 readFileSync 等会经由公开的 fs.openSync 再打开一次：同步嵌套里只记最外层那次
  let depth = 0;
  const wrap = (obj, name, label) => {
    const orig = obj && obj[name];
    if (typeof orig !== 'function') return;
    const wrapped = function (p, ...rest) {
      if (depth === 0) note(label, p);
      depth++;
      try { return orig.call(this, p, ...rest); } finally { depth--; }
    };
    obj[name] = wrapped;
    restore.push(() => { if (obj[name] === wrapped) obj[name] = orig; });
  };
  for (const n of ['open', 'openSync', 'readFile', 'readFileSync', 'createReadStream', 'copyFile', 'copyFileSync', 'cp', 'cpSync']) wrap(fs, n, n);
  for (const n of ['open', 'readFile', 'copyFile', 'cp']) wrap(promises, n, 'promises.' + n);
  return function uninstall() { while (restore.length) restore.pop()(); };
}

module.exports = {
  // §2.1
  placeholderOriginalName,
  placeholderPathFor,
  isDatalessStat,
  classifyTransition,
  isWithin,
  isWithinOrEqual,
  parseBrctlHelp,
  iCloudLabelFor,
  extractLocalResourceRefs,
  decodeHtmlEntities,
  // §4.3
  checkRenderDeps,
  FOLLOW,
  // §2.2
  resolveICloudConfig,
  // §2.3
  resolveDownloadTarget,
  realpathOfNearestAncestor,
  realpathOfNearestAncestorSync,
  canonPathSync,
  // §5.5
  createBatcher,
  // §2.4
  loadTestHook,
  installReadAudit,
};
