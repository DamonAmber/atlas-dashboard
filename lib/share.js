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

module.exports = {
  genToken,
  getLanIPs,
  resolveSharedPath,
};
