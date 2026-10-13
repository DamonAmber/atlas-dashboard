// 自我写入登记（从 server.js 抽出，便于单测；行为不变）。
// /api/save-edits 等写盘后登记 path→{mtime, reason}，watcher 事件命中则不把文件标未读
// （避免用户刚保存就看到自己的未读标记），并在 SSE 负载里带上 self / selfReason，
// 前端据此不把它当成"AI 刚改过"；活动日志据 reason 分类（'save' → s，'rename' → a）。
//   reason：'save'（保存 / 还原 / 回退等 Atlas 自己写内容）| 'rename'（/api/rename 的新路径）
// mtime 容差 2 秒；条目 10 秒后过期；命中即删（一次性）。
'use strict';
const TTL_MS = 10_000;
const TOLERANCE_MS = 2000;

function createSelfWrites({ ttlMs = TTL_MS, toleranceMs = TOLERANCE_MS } = {}) {
  const map = new Map();
  function mark(filePath, mtimeMs, reason = 'save') {
    const entry = { mtime: mtimeMs, reason };
    map.set(filePath, entry);
    const timer = setTimeout(() => {
      // 按对象身份比较：同一路径 10s 内被再次登记时，旧定时器不能删掉新条目
      if (map.get(filePath) === entry) map.delete(filePath);
    }, ttlMs);
    if (timer.unref) timer.unref();
  }
  // 命中返回登记时的 reason（'save' | 'rename'），未命中返回 null。命中即删。
  function check(filePath, mtimeMs) {
    const v = map.get(filePath);
    if (v === undefined) return null;
    if (Math.abs((mtimeMs || 0) - v.mtime) < toleranceMs) {
      map.delete(filePath);
      return v.reason || 'save';
    }
    return null;
  }
  return { mark, check, size: () => map.size, has: (p) => map.has(p) };
}

module.exports = { createSelfWrites, TTL_MS, TOLERANCE_MS };
