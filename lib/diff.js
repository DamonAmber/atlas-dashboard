// 行级 diff：给"和上次已读版本对比"用。
//
// 用 Myers 的贪心 O(ND) 算法（git 用的也是这一族）。为什么不用简单的 LCS 动态
// 规划：那个是 O(N*M) 内存，一份几千行的 HTML 报告就能吃掉几百 MB。
//
// 输入是两个字符串，先按行切分；输出按 hunk 分组，每个 hunk 带若干行上下文，
// 形态接近 unified diff，但用结构化数据返回，方便前端渲染。

const MAX_EDIT_DISTANCE = 4000;   // 差异过大时不值得逐行对齐，直接整体替换

function splitLines(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  if (s === '') return [];
  const lines = s.split('\n');
  // 结尾换行会切出一个空串，去掉它才符合"行数"的直觉
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// trace 里每一层只存 v 的有效区间 [-(d+1), d+1]，索引换算成 k + d + 1。
// 存整个 v 的话内存是 D×(N+M)：6000 行文件、D=2000 时就是几百 MB。
// 半宽 d+1（而不是 d）是因为回溯时要读 k±1。
function readV(slice, d, k) {
  const i = k + d + 1;
  if (i < 0 || i >= slice.length) return -1;
  return slice[i];
}

/**
 * Myers 贪心 diff，返回编辑脚本 [{ type: 'eq'|'del'|'add', a?, b?, text }]
 * a / b 是各自在原数组里的行号（0 基）。
 *
 * 复杂度 O((N+M)·D)，D 是编辑距离。注意上限要卡在 D 上，不能卡在 N+M ——
 * 卡错的话，一份 6000 行只改了 12 处的文件会被误判成"差异过大"而整体替换。
 */
function myers(a, b) {
  const N = a.length, M = b.length;
  const max = N + M;
  if (max === 0) return [];
  const dLimit = Math.min(max, MAX_EDIT_DISTANCE);

  // offset 多留 1 格的余量：trace 每层要切 [offset-d-1, offset+d+2)，
  // d 最大能到 max，offset 取 max 时左边界会算成 -1，而 TypedArray.slice
  // 把负数当成"从末尾数"，会静默切出错误区间
  const offset = max + 1;
  const v = new Int32Array(2 * max + 5).fill(-1);
  v[offset + 1] = 0;
  const trace = [];

  let dFound = -1;
  for (let d = 0; d <= dLimit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const ki = offset + k;
      let x;
      // 选择从上（k+1）还是从左（k-1）延伸
      if (k === -d || (k !== d && v[ki - 1] < v[ki + 1])) x = v[ki + 1];
      else x = v[ki - 1] + 1;
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      v[ki] = x;
      if (x >= N && y >= M) { dFound = d; break; }
    }
    if (dFound >= 0) break;
  }
  // 编辑距离超过上限：不再逐行对齐，退化成整块替换
  if (dFound < 0) return wholeReplace(a, b);

  // 回溯 trace 得到编辑脚本（倒序生成，最后反转）
  const script = [];
  let x = N, y = M;
  for (let d = dFound; d >= 0; d--) {
    const vPrev = trace[d];
    const k = x - y;
    let prevK, prevX;
    if (d === 0) {
      prevK = 0;
      prevX = 0;
    } else {
      if (k === -d || (k !== d && readV(vPrev, d, k - 1) < readV(vPrev, d, k + 1))) prevK = k + 1;
      else prevK = k - 1;
      prevX = readV(vPrev, d, prevK);
    }
    const prevY = prevX - prevK;
    // 这一步之前沿对角线走过的相等行
    while (x > prevX && y > prevY) {
      script.push({ type: 'eq', a: x - 1, b: y - 1, text: a[x - 1] });
      x--; y--;
    }
    if (d === 0) break;
    if (x === prevX) {
      script.push({ type: 'add', b: y - 1, text: b[y - 1] });
      y--;
    } else {
      script.push({ type: 'del', a: x - 1, text: a[x - 1] });
      x--;
    }
  }

  script.reverse();
  return script;
}

function wholeReplace(a, b) {
  const out = [];
  for (let i = 0; i < a.length; i++) out.push({ type: 'del', a: i, text: a[i] });
  for (let j = 0; j < b.length; j++) out.push({ type: 'add', b: j, text: b[j] });
  return out;
}

/**
 * 把编辑脚本按 hunk 分组：只保留改动附近 context 行上下文，
 * 中间大段没变的内容折叠掉（用 gap 表示跳过了多少行）。
 */
function toHunks(script, context = 3) {
  const changedIdx = [];
  script.forEach((op, i) => { if (op.type !== 'eq') changedIdx.push(i); });
  if (!changedIdx.length) return [];

  // 把相邻的改动合成一个区间（间隔 ≤ 2*context 就并到一起）
  const ranges = [];
  let start = changedIdx[0], end = changedIdx[0];
  for (let i = 1; i < changedIdx.length; i++) {
    if (changedIdx[i] - end <= context * 2) end = changedIdx[i];
    else { ranges.push([start, end]); start = end = changedIdx[i]; }
  }
  ranges.push([start, end]);

  const hunks = [];
  let prevEnd = -1;
  for (const [s, e] of ranges) {
    const from = Math.max(0, s - context);
    const to = Math.min(script.length - 1, e + context);
    const lines = [];
    for (let i = from; i <= to; i++) {
      const op = script[i];
      lines.push({
        type: op.type,
        oldLine: op.a != null ? op.a + 1 : null,
        newLine: op.b != null ? op.b + 1 : null,
        text: op.text,
      });
    }
    hunks.push({
      // 跳过了多少个「未改动的脚本条目」——前端用它显示"…省略 N 行…"
      skipped: prevEnd < 0 ? from : from - prevEnd - 1,
      lines,
    });
    prevEnd = to;
  }
  return hunks;
}

/**
 * 主入口。
 * @param {string} oldText 旧内容（上次已读的版本）
 * @param {string} newText 新内容（磁盘上的当前版本）
 * @param {object} opts { context = 3, maxHunks = 400 }
 * @returns {{ changed, added, removed, hunks, truncated, oldLines, newLines }}
 */
function diffText(oldText, newText, opts = {}) {
  const context = opts.context == null ? 3 : opts.context;
  const maxHunks = opts.maxHunks == null ? 400 : opts.maxHunks;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (oldText === newText) {
    return { changed: false, added: 0, removed: 0, hunks: [], truncated: false, oldLines: a.length, newLines: b.length };
  }
  const script = myers(a, b);
  let added = 0, removed = 0;
  for (const op of script) {
    if (op.type === 'add') added++;
    else if (op.type === 'del') removed++;
  }
  let hunks = toHunks(script, context);
  const truncated = hunks.length > maxHunks;
  if (truncated) hunks = hunks.slice(0, maxHunks);
  return {
    changed: added > 0 || removed > 0,
    added,
    removed,
    hunks,
    truncated,
    oldLines: a.length,
    newLines: b.length,
  };
}

module.exports = { diffText, splitLines, toHunks, MAX_EDIT_DISTANCE };
