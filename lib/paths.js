// 跨平台用户目录管理
// macOS/Linux: ~/.atlas/
// Windows:     %LOCALAPPDATA%/atlas/  （fallback 到 USERPROFILE）

const path = require('path');
const os = require('os');
const fs = require('fs');

function configDir() {
  if (process.env.ATLAS_HOME) return path.resolve(process.env.ATLAS_HOME);
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir();
    return path.join(base, 'atlas');
  }
  return path.join(os.homedir(), '.atlas');
}

function ensureConfigDir() {
  const dir = configDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function configPath() { return path.join(configDir(), 'config.json'); }
function storePath()  { return path.join(configDir(), 'store.json'); }
function logPath()    { return path.join(configDir(), 'atlas.log'); }
function pidPath()    { return path.join(configDir(), 'atlas.pid'); }

// 把 ~/foo 这样的路径展开成绝对路径
function expand(p) {
  if (typeof p !== 'string') return p;
  let s = p.trim();
  if (s.startsWith('~/') || s === '~') {
    s = path.join(os.homedir(), s.slice(2));
  } else if (s.startsWith('$HOME/')) {
    s = path.join(os.homedir(), s.slice(6));
  }
  return path.resolve(s);
}

module.exports = {
  configDir,
  ensureConfigDir,
  configPath,
  storePath,
  logPath,
  pidPath,
  expand,
};
