// 「上次已读版本」快照库。
//
// 未读红点只告诉你"AI 动过这个文件"，不告诉你"动了什么"。要能回答后者，
// 就必须在用户看过的那一刻把内容留一份底本，之后才有东西可比。
//
// 存到 ATLAS_HOME/versions/，与编辑备份（lib/edit-backup.js，那是"写盘前的
// 安全兜底"）分开：两者生命周期和语义都不一样，混在一个目录里会互相干扰淘汰。
//
// 命名：<safeStem>-<pathHash8>-<contentSha8><原扩展名>
//   pathHash 用来区分不同目录下的同名文件；contentSha 用来去重（内容没变不重复存）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const KEEP_PER_FILE = 5;          // 每个源文件保留最近几份底本
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;   // 超过这个大小不做快照（diff 也没意义）

function versionsDir() {
  return path.join(paths.configDir(), 'versions');
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function pathHash(absPath) {
  return sha1(Buffer.from(absPath, 'utf8')).slice(0, 8);
}

// 文件名里安全的 stem（保留中文，去掉危险字符）
function safeStem(absPath) {
  const base = path.basename(absPath).replace(/\.[^.]*$/, '');
  return base.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 60) || 'file';
}

function prefixFor(absPath) {
  return `${safeStem(absPath)}-${pathHash(absPath)}-`;
}

/**
 * 给一个文件存"当前内容"作为底本。
 * 内容与最新一份底本相同时不重复写。
 * @returns {{ ok, file?, hash?, size?, at?, skipped? }}
 */
function snapshot(absPath) {
  let stat;
  try { stat = fs.statSync(absPath); } catch { return { ok: false, skipped: 'stat-failed' }; }
  if (!stat.isFile()) return { ok: false, skipped: 'not-file' };
  if (stat.size > MAX_SNAPSHOT_BYTES) return { ok: false, skipped: 'too-large' };

  let content;
  try { content = fs.readFileSync(absPath); } catch { return { ok: false, skipped: 'read-failed' }; }
  const hash = sha1(content);

  const dir = versionsDir();
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch { return { ok: false, skipped: 'mkdir-failed' }; }

  const ext = path.extname(absPath) || '.txt';
  const file = `${prefixFor(absPath)}${hash.slice(0, 8)}${ext}`;
  const dest = path.join(dir, file);
  if (fs.existsSync(dest)) {
    // 内容相同的底本已经有了，只更新访问时间，不重复写
    try { fs.utimesSync(dest, new Date(), new Date()); } catch {}
    return { ok: true, file, hash, size: stat.size, at: Date.now(), deduped: true };
  }
  try {
    fs.writeFileSync(dest, content);
  } catch { return { ok: false, skipped: 'write-failed' }; }
  pruneOld(absPath);
  return { ok: true, file, hash, size: stat.size, at: Date.now() };
}

// 读回底本内容（utf8）。读不到返回 null
function readSnapshot(file) {
  if (!file || typeof file !== 'string') return null;
  // 防目录穿越：只允许纯文件名
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return null;
  try {
    return fs.readFileSync(path.join(versionsDir(), file), 'utf8');
  } catch {
    return null;
  }
}

function hasSnapshot(file) {
  if (!file || typeof file !== 'string') return false;
  if (file.includes('/') || file.includes('\\') || file.includes('..')) return false;
  try { return fs.statSync(path.join(versionsDir(), file)).isFile(); } catch { return false; }
}

// 同一源文件只保留最近 KEEP_PER_FILE 份
function pruneOld(absPath) {
  const dir = versionsDir();
  const prefix = prefixFor(absPath);
  let entries;
  try {
    entries = fs.readdirSync(dir).filter(f => f.startsWith(prefix));
  } catch { return; }
  if (entries.length <= KEEP_PER_FILE) return;
  const withTime = entries.map(f => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
    return { f, mtime };
  });
  withTime.sort((a, b) => b.mtime - a.mtime);   // 新 → 旧
  for (const { f } of withTime.slice(KEEP_PER_FILE)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

// 源文件被删 / 改名后，清掉它的所有底本
function removeAllFor(absPath) {
  const dir = versionsDir();
  const prefix = prefixFor(absPath);
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(prefix)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
  } catch {}
}

module.exports = {
  versionsDir,
  snapshot,
  readSnapshot,
  hasSnapshot,
  removeAllFor,
  sha1,
  KEEP_PER_FILE,
  MAX_SNAPSHOT_BYTES,
};
