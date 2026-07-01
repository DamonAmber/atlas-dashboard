// 编辑保存前的安全备份：把原文件拷到 ATLAS_HOME/backups/。
// 编辑写盘破坏了 Atlas「只读」承诺，留一份兜底，出问题可手动恢复。
// 不污染用户的扫描根目录。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const KEEP_PER_FILE = 20;

function backupsDir() {
  return path.join(paths.configDir(), 'backups');
}

// 文件名里安全的 stem（去扩展名 + 去危险字符，保留中文）
function safeStem(absPath) {
  const base = path.basename(absPath).replace(/\.[^.]*$/, '');
  return base.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'file';
}

// 备份一个文件。返回备份文件的绝对路径（失败抛错）。
function backup(absPath) {
  const dir = backupsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const content = fs.readFileSync(absPath);
  const sha8 = crypto.createHash('sha1').update(content).digest('hex').slice(0, 8);
  const stem = safeStem(absPath);
  const ts = Date.now();
  const dest = path.join(dir, `${stem}-${sha8}-${ts}.html`);
  fs.writeFileSync(dest, content);

  pruneOld(dir, stem);
  return dest;
}

// 同一原文件保留最近 KEEP_PER_FILE 份，超出按时间删除
function pruneOld(dir, stem) {
  let entries;
  try {
    entries = fs.readdirSync(dir).filter(f => f.startsWith(stem + '-') && f.endsWith('.html'));
  } catch {
    return;
  }
  if (entries.length <= KEEP_PER_FILE) return;
  const withTime = entries.map(f => {
    let mtime = 0;
    try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch {}
    return { f, mtime };
  });
  withTime.sort((a, b) => b.mtime - a.mtime); // 新→旧
  for (const { f } of withTime.slice(KEEP_PER_FILE)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}

module.exports = { backup, backupsDir, KEEP_PER_FILE };
