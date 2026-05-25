// 检查 npm 上是否有新版本，缓存到 ~/.atlas/update-check.json，每天最多查一次
// 不阻塞调用方：所有 IO 都是异步且 catch 失败

const fs = require('fs');
const path = require('path');
const https = require('https');
const paths = require('./paths');

const CHECK_INTERVAL_MS = 60 * 60 * 1000;        // 1 小时（够及时，不会被 npm 限流）
const REQUEST_TIMEOUT_MS = 2500;

function cachePath() {
  return path.join(paths.configDir(), 'update-check.json');
}

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), 'utf8'));
  } catch { return null; }
}

function writeCache(data) {
  try {
    paths.ensureConfigDir();
    fs.writeFileSync(cachePath(), JSON.stringify(data, null, 2));
  } catch {}
}

// 简单 semver 比较：a > b 返回 true
function isNewer(a, b) {
  if (!a || !b) return false;
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return true;
    if (pa[i] < pb[i]) return false;
  }
  return false;
}

function fetchLatest(pkgName, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${pkgName}/latest`;
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json && typeof json.version === 'string' ? json.version : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// 拿当前已知的"上次检查结果"。不会触发网络请求。
// 用于 CLI 启动时立刻基于缓存显示提示，背景再去刷新
function getCachedResult(currentVersion) {
  const cache = readCache();
  if (!cache || !cache.latest) return null;
  if (isNewer(cache.latest, currentVersion)) {
    return { current: currentVersion, latest: cache.latest, checkedAt: cache.checkedAt };
  }
  return null;
}

// 后台异步刷新缓存（不阻塞调用方）。如果距上次检查 < CHECK_INTERVAL_MS，跳过。
function refreshInBackground(pkgName) {
  const cache = readCache() || {};
  if (cache.checkedAt && Date.now() - cache.checkedAt < CHECK_INTERVAL_MS) {
    return;
  }
  fetchLatest(pkgName).then((latest) => {
    if (latest) {
      writeCache({ latest, checkedAt: Date.now() });
    }
  });
}

// 主动刷新一次，返回结果。给定时轮询 / SSE 推送用。
// 返回 { latest, hasUpdate, changed }——changed 表示这次检查比缓存里的 latest 更新（首次发现新版本）
async function refreshAndCheck(pkgName, currentVersion) {
  const prev = readCache() || {};
  const latest = await fetchLatest(pkgName);
  if (!latest) return { latest: null, hasUpdate: false, changed: false };
  writeCache({ latest, checkedAt: Date.now() });
  const hasUpdate = isNewer(latest, currentVersion);
  const changed = hasUpdate && latest !== prev.latest;
  return { latest, hasUpdate, changed };
}

module.exports = {
  getCachedResult,
  refreshInBackground,
  refreshAndCheck,
  isNewer,
  CHECK_INTERVAL_MS,
  // 暴露给测试用
  _readCache: readCache,
  _writeCache: writeCache,
  _fetchLatest: fetchLatest,
};
