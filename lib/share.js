// 局域网分享：管理 token、LAN IP 检测、path traversal 防御
const crypto = require('crypto');
const path = require('path');
const os = require('os');

function genToken() {
  // 16 字符十六进制（8 字节 = 64 bit 熵），不可猜
  return crypto.randomBytes(8).toString('hex');
}

// 收集本机所有非 loopback 的 IPv4 地址（多网卡时返回所有）
function getLanIPs() {
  const ifs = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifs)) {
    for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

// 把分享 url 中的相对路径解析成磁盘绝对路径——严格防 path traversal
// baseDir: HTML 原文件所在目录的绝对路径
// relPath: URL 中 /share/<token>/ 后面的部分（已 decodeURIComponent 过）
// 返回 { ok, abs } 或 { ok: false, reason }
function resolveSharedPath(baseDir, relPath) {
  // 规范化：去掉前导 /，禁止绝对路径
  let r = (relPath || '').replace(/^\/+/, '');
  if (path.isAbsolute(r)) return { ok: false, reason: 'absolute-path' };
  // path.resolve 会处理 .. ./
  const abs = path.resolve(baseDir, r);
  // 必须仍在 baseDir 里（以 baseDir + sep 开头，或恰好等于 baseDir 自身）
  const normBase = path.resolve(baseDir);
  const sep = path.sep;
  if (abs !== normBase && !abs.startsWith(normBase + sep)) {
    return { ok: false, reason: 'outside-base' };
  }
  return { ok: true, abs };
}

// ---------- 引用资源白名单 ----------
//
// 为什么需要：/share/:token/* 原来服务的是「被分享文件所在目录的整棵子树」。
// resolveSharedPath 只防住了 ../ 越界，没防住"同目录下的其他文件"。分享
// ~/Documents/report.html 等于把整个 ~/Documents/ 开放给局域网里拿到 token 的人。
//
// 现在默认只放行文档真正引用到的资源（scope='refs'）。用户可以显式切换成
// 同目录全开（scope='dir'）——有些页面在 JS 里动态拼图片路径，白名单抓不到。

const ABSOLUTE_OR_SPECIAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i;

// 把 URL 引用规范化成"相对 baseDir 的 posix 相对路径"，不可用则返回 null
function normalizeRef(ref) {
  let v = String(ref || '').trim();
  if (!v) return null;
  // 去掉查询串与 hash：磁盘上找的是文件本体
  v = v.split('#')[0].split('?')[0].trim();
  if (!v) return null;
  if (ABSOLUTE_OR_SPECIAL.test(v)) return null;   // http(s)/data/mailto/协议相对/绝对路径/锚点
  try { v = decodeURIComponent(v); } catch {}
  v = v.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!v || v.startsWith('../')) return null;      // 越界的直接不收
  return v;
}

// srcset="a.png 1x, b.png 2x" → ['a.png','b.png']
function splitSrcset(value) {
  return String(value || '')
    .split(',')
    .map(part => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

// 从 HTML 文本里抽出引用到的本地资源。
// 用正则而不是完整解析：这里只用来构造白名单，宁可多收一点（放行合法资源）
// 也不要漏收导致页面裂开；安全边界由 resolveSharedPath 的目录约束兜底。
function extractHtmlRefs(html) {
  const out = new Set();
  const add = (v) => { const n = normalizeRef(v); if (n) out.add(n); };
  const text = String(html || '');

  // src / href / poster / data-src
  const attrRe = /\b(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m;
  while ((m = attrRe.exec(text)) !== null) add(m[1] || m[2] || m[3]);

  // srcset / imagesrcset
  const srcsetRe = /\b(?:srcset|imagesrcset)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  while ((m = srcsetRe.exec(text)) !== null) splitSrcset(m[1] || m[2]).forEach(add);

  // 内联样式与 <style> 里的 url()
  extractCssRefs(text).forEach(v => out.add(v));
  return out;
}

// 从 CSS 文本里抽出 url(...) 引用
function extractCssRefs(css) {
  const out = new Set();
  const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi;
  let m;
  while ((m = re.exec(String(css || ''))) !== null) {
    const n = normalizeRef(m[1] || m[2] || m[3]);
    if (n) out.add(n);
  }
  return out;
}

// 从 Markdown 源码里抽出引用（图片 / 链接 / 内嵌 HTML）
function extractMarkdownRefs(md) {
  const out = new Set();
  const add = (v) => { const n = normalizeRef(v); if (n) out.add(n); };
  const text = String(md || '');
  // ![alt](path)  /  [text](path)
  const linkRe = /!?\[[^\]]*\]\(\s*<?([^)>\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  let m;
  while ((m = linkRe.exec(text)) !== null) add(m[1]);
  // 引用式定义： [id]: path
  const refDefRe = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/gm;
  while ((m = refDefRe.exec(text)) !== null) add(m[1]);
  // md 里内嵌的 HTML
  extractHtmlRefs(text).forEach(v => out.add(v));
  return out;
}

const CSS_EXT = /\.css$/i;
const HTML_EXT = /\.html?$/i;
const MD_EXT = /\.(md|markdown)$/i;

/**
 * 构造某个被分享文档的资源白名单（相对 baseDir 的 posix 路径集合）。
 *
 * 会跟一层引用：入口文档 → 它引用的 CSS → CSS 里的 url()。
 * 入口文档引用的其它 HTML（比如 iframe 子页）也会被跟进一层。
 *
 * @param {object} io   注入的读文件实现 { readFile(absPath): Promise<string> }
 * @param {string} baseDir  被分享文件所在目录（绝对路径）
 * @param {string} entryRel 入口文件相对 baseDir 的路径
 * @returns {Promise<Set<string>>}
 */
async function buildAllowlist(io, baseDir, entryRel) {
  const path_ = require('path');
  const allow = new Set();
  const visited = new Set();

  const inside = (rel) => {
    const abs = path_.resolve(baseDir, rel);
    const normBase = path_.resolve(baseDir);
    return abs === normBase || abs.startsWith(normBase + path_.sep);
  };

  // 待处理队列：[相对路径, 还能再跟几层]
  const queue = [[entryRel.replace(/\\/g, '/'), 2]];

  while (queue.length) {
    const [rel, depth] = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    if (!inside(rel)) continue;
    allow.add(rel);
    if (depth <= 0) continue;

    let content = '';
    try {
      content = await io.readFile(path_.resolve(baseDir, rel));
    } catch {
      continue;   // 读不到（不存在 / 是二进制）就不再往下跟
    }

    let refs;
    if (CSS_EXT.test(rel)) refs = extractCssRefs(content);
    else if (MD_EXT.test(rel)) refs = extractMarkdownRefs(content);
    else if (HTML_EXT.test(rel)) refs = extractHtmlRefs(content);
    else continue;   // 其它类型不解析（图片等二进制）

    const dir = path_.posix.dirname(rel.split('/').length > 1 ? rel : './' + rel);
    for (const ref of refs) {
      // 引用是相对"当前文件所在目录"的
      const joined = dir === '.' ? ref : path_.posix.normalize(dir + '/' + ref);
      if (joined.startsWith('../')) continue;
      // 只对文本类资源继续往下跟，其余只加入白名单
      const nextDepth = (CSS_EXT.test(joined) || HTML_EXT.test(joined) || MD_EXT.test(joined))
        ? depth - 1 : 0;
      queue.push([joined, nextDepth]);
    }
  }
  return allow;
}

// 分享是否已过期。expiresAt 缺失 = 永不过期（兼容老 store.json）
function isExpired(entry, now = Date.now()) {
  if (!entry) return true;
  if (!entry.expiresAt) return false;
  return now >= entry.expiresAt;
}

module.exports = {
  genToken,
  getLanIPs,
  resolveSharedPath,
  normalizeRef,
  extractHtmlRefs,
  extractCssRefs,
  extractMarkdownRefs,
  buildAllowlist,
  isExpired,
};
