// 时间河流（design §3d）—— window.AtlasRiver
//
// 纯函数为主：日志与 SSE 的合并、mtime 兜底、168 根小时柱的分桶、总数、时间段命中、
// 窗口滚动夹取；renderRiverSvg 把分桶结果画成 SVG。状态（日志副本、state.timeRange、
// 刷选交互）都在 app.js，这里不读全局 state。
// 文件末尾 module.exports 给 node spec 直接 require（同 window.AtlasMarkdown / AtlasStarmap 的写法）。
//
// 事件形状：{ t, kind, path, src? }，kind 0 = add、1 = change（计数事件），2 = Atlas 自写的覆盖标记
// （不计数，只用来压住 mtime 兜底）。src: 'mtime' 表示兜底合成的事件。
(function (root) {
  'use strict';
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const BARS = 168;                       // 7 天 × 24 小时
  const DEFAULT_MERGE_MS = 60_000;        // 响应缺 mergeWindowMs 时（不应发生）的回退
  const FUTURE_SLACK_MS = 5 * 60_000;
  const RETAIN_MS = 8 * DAY;
  const FALLBACK_SLACK_MS = 2000;
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  // 合并判定：与 lib/activity-log.js 的 shouldMergeExpr 同一个表达式（固定窗口，含 t === lastT）
  function shouldMerge(lastT, t, windowMs) {
    return lastT != null && Math.abs(t - lastT) < windowMs;
  }
  // 与服务端写日志前的夹取一致：> now + 5min 夹到 now；< now - 8d 丢弃；0 / 非法忽略
  function clampTime(t, now) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) return null;
    if (t > now + FUTURE_SLACK_MS) return now;
    if (t < now - RETAIN_MS) return null;
    return t;
  }
  // SSE fs 负载 → kind。与服务端 classifyEvent 同一张表：
  //   selfReason 'save' → 2；'rename' → 0（无论 kind 是 add 还是 change）；null → add 0 / change 1
  function classifySse(data) {
    if (!data || (data.kind !== 'add' && data.kind !== 'change')) return null;
    if (data.selfReason === 'save') return 2;
    if (data.selfReason === 'rename') return 0;
    return data.kind === 'add' ? 0 : 1;
  }

  // 当前本地整点
  function floorHour(t) {
    const d = new Date(t);
    d.setMinutes(0, 0, 0);
    return d.getTime();
  }
  // 168 根柱的起点：最后一根是当前小时
  function windowStart(now) {
    return floorHour(now) + HOUR - BARS * HOUR;
  }

  // /api/activity 的紧凑响应 → 本地副本 { logStart, mergeWindowMs, events, truncated, skipped }
  function decodeLog(resp) {
    if (!resp || !Array.isArray(resp.events)) return null;
    const paths = Array.isArray(resp.paths) ? resp.paths : [];
    const events = [];
    for (const e of resp.events) {
      if (!Array.isArray(e)) continue;
      const p = paths[e[2]];
      if (typeof p !== 'string' || typeof e[0] !== 'number') continue;
      events.push({ t: e[0], kind: e[1], path: p });
    }
    return {
      logStart: resp.logStart == null ? null : resp.logStart,
      mergeWindowMs: Number.isFinite(resp.mergeWindowMs) ? resp.mergeWindowMs : DEFAULT_MERGE_MS,
      events,
      truncated: !!resp.truncated,
      skipped: resp.skipped || 0,
    };
  }

  // 本地副本里每个路径每个类别最后一条事件的 t（按数组顺序，后者覆盖前者）
  function lastIndex(local) {
    if (local._last && local._last.n === local.events.length) return local._last;
    const count = new Map();
    const self = new Map();
    for (const ev of local.events) (ev.kind === 2 ? self : count).set(ev.path, ev.t);
    local._last = { n: local.events.length, count, self };
    return local._last;
  }

  // SSE 收到 add / change 时追加到本地副本，规则与服务端写日志完全同构：
  // t = data.mtime（不用墙钟）、同样夹取、按类别 shouldMerge。返回是否追加了
  function appendSseEvent(local, data, mergeWindowMs, now) {
    if (!local || !data || !data.path) return false;
    const kind = classifySse(data);
    if (kind == null) return false;
    const t = clampTime(data.mtime, now);
    if (t == null) return false;
    const w = Number.isFinite(mergeWindowMs) ? mergeWindowMs
      : (Number.isFinite(local.mergeWindowMs) ? local.mergeWindowMs : DEFAULT_MERGE_MS);
    const idx = lastIndex(local);
    const map = kind === 2 ? idx.self : idx.count;
    if (shouldMerge(map.get(data.path), t, w)) return false;
    map.set(data.path, t);
    local.events.push({ t, kind, path: data.path });
    idx.n = local.events.length;
    return true;
  }

  // 日志事件 + mtime 兜底 → 河流用的事件集合（§3d「前端：数据合并」第 3–6 条）
  //   log：decodeLog 的结果；null = 日志不可用（全部按 mtime 兜底）
  //   files：当前非归档的文档 [{ path, mtime }]（state.files 的值）
  // 兜底：mtime 落在窗口内的文档 p，当且仅当
  //   logStart == null || mtime < logStart || 日志里没有 p 的事件落在 [mtime - 窗口 - 2s, mtime + 2s]
  // 时补一个合成事件（kind 1，src 'mtime'）。kind 2 也算"这个 mtime 已有记录"。
  // 结果按 (path, t, 是否计数) 去重，只留 files 里的路径，按 t 升序。O(事件 + 文档)
  function mergeWithFallback(log, files, now) {
    const w = log && Number.isFinite(log.mergeWindowMs) ? log.mergeWindowMs : DEFAULT_MERGE_MS;
    const logStart = log ? log.logStart : null;
    const ws = windowStart(now);
    const list = Array.isArray(files) ? files : Object.values(files || {});
    const live = new Set();
    for (const f of list) if (f && f.path) live.add(f.path);
    const byPath = new Map();
    const out = [];
    const seen = new Set();
    const push = (ev) => {
      const key = ev.t + '|' + (ev.kind === 2 ? 0 : 1) + '|' + ev.path;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(ev);
    };
    if (log) {
      for (const ev of log.events) {
        if (!live.has(ev.path)) continue;
        let arr = byPath.get(ev.path);
        if (!arr) { arr = []; byPath.set(ev.path, arr); }
        arr.push(ev.t);
        push({ t: ev.t, kind: ev.kind, path: ev.path });
      }
    }
    for (const f of list) {
      if (!f || !f.path) continue;
      const t = clampTime(f.mtime, now);
      if (t == null || t < ws) continue;
      const arr = byPath.get(f.path);
      const synthesize = logStart == null || t < logStart
        || !arr || !arr.some(x => x >= t - w - FALLBACK_SLACK_MS && x <= t + FALLBACK_SLACK_MS);
      if (synthesize) push({ t, kind: 1, path: f.path, src: 'mtime' });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  }

  // 7 × 24 = 168 个小时桶，只计 kind 0 / 1。docs[i] = 该小时涉及的文档数
  function bucketize(events, now) {
    const start = windowStart(now);
    const counts = new Array(BARS).fill(0);
    const sets = new Array(BARS);
    for (const ev of events || []) {
      if (ev.kind !== 0 && ev.kind !== 1) continue;
      let i = Math.floor((ev.t - start) / HOUR);
      if (i >= BARS && ev.t <= now + FUTURE_SLACK_MS) i = BARS - 1;   // 夹到 now 的未来时间戳
      if (i < 0 || i >= BARS) continue;
      counts[i]++;
      (sets[i] || (sets[i] = new Set())).add(ev.path);
    }
    const docs = counts.map((_, i) => (sets[i] ? sets[i].size : 0));
    return { start, now, counts, docs };
  }

  // 总数与最忙的小时（并列取最早的）。卡片头统计、读数「近 7 天改动」、摘要共用这一次结果
  function riverTotals(buckets) {
    const counts = (buckets && buckets.counts) || [];
    let total = 0;
    let busiest = -1;
    let busiestCount = 0;
    for (let i = 0; i < counts.length; i++) {
      total += counts[i];
      if (counts[i] > busiestCount) { busiestCount = counts[i]; busiest = i; }
    }
    return { total, busiest, busiestCount };
  }

  function inRange(t, range) {
    return range.from <= t && (range.to === null || t < range.to);
  }
  // 区间内每篇文档最后一次计数事件的 t（首页「该时段改动的文档」按它倒序）
  function timeRangeLatest(events, range) {
    const out = new Map();
    if (!range) return out;
    for (const ev of events || []) {
      if (ev.kind !== 0 && ev.kind !== 1) continue;
      if (!inRange(ev.t, range)) continue;
      const prev = out.get(ev.path);
      if (prev === undefined || ev.t > prev) out.set(ev.path, ev.t);
    }
    return out;
  }
  // 区间内有至少一个计数事件的文档：from ≤ t 且 (to === null || t < to)
  function timeRangePaths(events, range) {
    return new Set(timeRangeLatest(events, range).keys());
  }

  // 窗口滚动：from 夹到窗口起点；to 为数字且不晚于窗口起点（整段滑出）→ cleared。
  // 夹取后若等价于"整个窗口、开放到现在"（两手柄在 0 与 168）也视为已清除。
  function clampRange(range, ws) {
    if (!range) return { range: null, cleared: false, changed: false };
    if (range.to !== null && range.to <= ws) return { range: null, cleared: true, changed: true };
    if (range.from < ws) {
      if (range.to === null) return { range: null, cleared: true, changed: true };
      return { range: { from: ws, to: range.to }, cleared: false, changed: true };
    }
    return { range, cleared: false, changed: false };
  }

  // 手柄位置（0..168）↔ 时间段。两手柄在 0 与 168 等价 null（不筛选）；右手柄在 168 = 开放到现在
  function rangeFromHandles(a, b, ws) {
    a = Math.max(0, Math.min(BARS, Math.round(a)));
    b = Math.max(0, Math.min(BARS, Math.round(b)));
    if (b <= a) b = Math.min(BARS, a + 1);
    if (b <= a) a = b - 1;
    if (a <= 0 && b >= BARS) return null;
    return { from: ws + a * HOUR, to: b >= BARS ? null : ws + b * HOUR };
  }
  function handlesFromRange(range, ws) {
    if (!range) return [0, BARS];
    const a = Math.max(0, Math.min(BARS, Math.round((range.from - ws) / HOUR)));
    const b = range.to === null ? BARS : Math.max(0, Math.min(BARS, Math.round((range.to - ws) / HOUR)));
    return [a, Math.max(b, Math.min(BARS, a + 1))];
  }
  // 「24 小时」/「3 天」预设：从 当前整点 - (h-1) 小时 开始，开放到现在（正好 h 根柱）
  function presetRange(hours, now) {
    return { from: floorHour(now) - (hours - 1) * HOUR, to: null };
  }

  // 柱高比例尺（client-fix §10）：以前按全窗口最大值开方，一个 117 次的尖峰把其余 1–3 次的柱子
  // 全压成 6–9% 高、整张图看着几乎是空的。现在：
  //   cap = 非零小时的 p95（至少 4）；0 < c ≤ cap 按 √ 映射到 14%–80%，一次改动也看得见；
  //   c > cap 的柱子在 80%–92% 之间按对数压缩（max 处画满），仍能看出谁更高；
  //   c ≥ 3·cap 的尖峰列为 peaks，柱顶标注真实次数（最多标 6 根最高的）
  const BAR_MIN_H = 14;
  const BAR_CAP_H = 80;
  const BAR_MAX_H = 92;
  function riverScale(counts) {
    const nz = [];
    let max = 0;
    for (const c of counts || []) if (c > 0) { nz.push(c); if (c > max) max = c; }
    if (!nz.length) return { cap: 1, max: 0, peaks: [] };
    nz.sort((a, b) => a - b);
    const p95 = nz[Math.min(nz.length - 1, Math.floor(0.95 * (nz.length - 1)))];
    const cap = Math.max(4, p95);
    const peaks = [];
    (counts || []).forEach((c, i) => { if (c >= 3 * cap) peaks.push(i); });
    peaks.sort((x, y) => counts[y] - counts[x] || x - y);
    return { cap, max, peaks: peaks.slice(0, 6).sort((x, y) => x - y) };
  }
  function barHeight(c, cap, max) {
    if (!c) return 2;
    if (c <= cap) return BAR_MIN_H + (Math.sqrt(c) / Math.sqrt(cap)) * (BAR_CAP_H - BAR_MIN_H);
    const top = Math.max(c, max || c);
    if (top <= cap) return BAR_CAP_H;
    return BAR_CAP_H + (BAR_MAX_H - BAR_CAP_H) * (Math.log(c / cap) / Math.log(top / cap) || 0);
  }

  // ---------- 文案 ----------
  const p2 = (n) => String(n).padStart(2, '0');
  function fmtShort(t) {
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  }
  function fmtRange(range) {
    if (!range) return '';
    return `${fmtShort(range.from)}–${range.to === null ? '现在' : fmtShort(range.to)}`;
  }
  // 手柄 aria-valuetext：「10月3日 周四 14:00」
  function fmtValueText(t) {
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]} ${p2(d.getHours())}:00`;
  }
  function fmtBarTitle(t, count, docs, mtimeOnly) {
    const d = new Date(t);
    const e = new Date(t + HOUR);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${p2(d.getHours())}:00–${p2(e.getHours())}:00`
      + ` · ${count} 次改动 · ${docs} 篇` + (mtimeOnly ? ' · 仅修改时间' : '');
  }
  function metaText(buckets, totals) {
    if (!totals.total) return '7 天内没有改动';
    const d = new Date(buckets.start + totals.busiest * HOUR);
    return `${totals.total} 次改动 · 最忙 ${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:00（${totals.busiestCount} 次）`;
  }
  function summaryText(buckets, totals) {
    if (!totals.total) return '过去 7 天没有改动。';
    const d = new Date(buckets.start + totals.busiest * HOUR);
    return `过去 7 天共 ${totals.total} 次改动，最忙的是 ${d.getMonth() + 1} 月 ${d.getDate()} 日 ${d.getHours()} 时（${totals.busiestCount} 次）。`;
  }

  // ---------- 渲染 ----------
  // container：#home-river（里面有 svg.river-svg）或 svg 本身。
  // model：bucketize 的结果 + { logStart }（null = 全部只有修改时间）。
  // opts：{ grow（首次出现的升起动画）, daysEl（底部日期标签容器）, hatchTagEl（「仅修改时间」标签）, nowTagEl }
  // 168 个 rect，柱高见 riverScale / barHeight（p95 截顶 + √）；24h 内 --star-2、更早 --star-3、logStart 之前 --star-4 + 斜线底纹
  function renderRiverSvg(container, model, opts = {}) {
    if (!container || !model) return null;
    const svg = container.tagName && container.tagName.toLowerCase() === 'svg'
      ? container : container.querySelector('svg.river-svg');
    if (!svg) return null;
    const { start, now, counts, docs } = model;
    const logStart = model.logStart == null ? null : model.logStart;
    const { cap, max, peaks } = riverScale(counts);
    const hatchW = logStart == null ? BARS : Math.max(0, Math.min(BARS, (logStart - start) / HOUR));
    let s = '<defs><pattern id="river-hatch" width="2.4" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">'
      + '<rect class="river-hatch-line" width="1" height="6"/></pattern></defs>';
    if (hatchW > 0) s += `<rect class="river-hatch" x="0" y="0" width="${hatchW.toFixed(3)}" height="100"/>`;
    for (let i = 1; i < BARS; i++) {
      if (new Date(start + i * HOUR).getHours() === 0) {
        s += `<line class="river-dayline" x1="${i}" x2="${i}" y1="0" y2="100"/>`;
      }
    }
    s += '<line class="river-baseline" x1="0" x2="168" y1="99.5" y2="99.5"/>';
    for (let i = 0; i < BARS; i++) {
      const c = counts[i];
      const t = start + i * HOUR;
      const h = barHeight(c, cap, max);
      const mtimeOnly = logStart == null || t + HOUR <= logStart;
      const recent = now - t < DAY;
      // 颜色只表达新旧（24 小时内 / 更早）；「仅按修改时间推断」由底纹表达，柱子本身不再换成和底纹同色调的灰
      const cls = !c ? 'zero' : (recent ? 'recent' : 'older') + (mtimeOnly ? ' mtime-only' : '');
      s += `<rect class="bar ${cls}${peaks.includes(i) ? ' peak' : ''}${opts.grow ? ' grow' : ''}" data-i="${i}" data-c="${c}" style="--i:${i}"`
        + ` x="${(i + 0.14).toFixed(2)}" y="${(100 - h).toFixed(2)}" width="0.72" height="${h.toFixed(2)}" rx="0.2">`
        + `<title>${fmtBarTitle(t, c, docs ? docs[i] : 0, mtimeOnly)}</title></rect>`;
    }
    const nowX = Math.max(0, Math.min(BARS, (now - start) / HOUR));
    s += `<line class="river-nowline" x1="${nowX.toFixed(3)}" x2="${nowX.toFixed(3)}" y1="-4" y2="100"/>`;
    svg.innerHTML = s;
    if (opts.hatchTagEl) opts.hatchTagEl.classList.toggle('hidden', hatchW < 12);
    // 截顶的尖峰柱：柱顶标注真实次数（HTML 叠层，svg 是非等比拉伸的，不能在里面写字）
    if (opts.peaksEl) {
      opts.peaksEl.innerHTML = peaks.map((i) =>
        `<span class="river-peak" style="left:${((i + 0.5) / BARS * 100).toFixed(3)}%">${counts[i]}</span>`).join('');
    }
    if (opts.nowTagEl) opts.nowTagEl.style.left = (nowX / BARS * 100) + '%';
    if (opts.daysEl) {
      const today = new Date(now).toDateString();
      let days = '';
      for (let i = 0; i < BARS; i++) {
        const d = new Date(start + i * HOUR);
        if (d.getHours() !== 0 && i !== 0) continue;
        if (i === 0 && d.getHours() > 12) continue;   // 窗口起点那天只剩半天不到：不放标签，免得和下一个挤
        const isToday = d.toDateString() === today;
        days += `<span class="${isToday ? 'today' : ''}" style="left:${(i / BARS * 100).toFixed(3)}%">`
          + `${isToday ? '今天' : WEEK[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}</span>`;
      }
      opts.daysEl.innerHTML = days;
    }
    return { hatchW, nowX, cap, peaks };
  }

  const pure = {
    HOUR, BARS, DEFAULT_MERGE_MS,
    shouldMerge, clampTime, classifySse, floorHour, windowStart, decodeLog,
    appendSseEvent, mergeWithFallback, bucketize, riverTotals,
    timeRangePaths, timeRangeLatest, clampRange, rangeFromHandles, handlesFromRange, presetRange,
    fmtShort, fmtRange, fmtValueText, fmtBarTitle, metaText, summaryText,
    riverScale, barHeight,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  root.AtlasRiver = Object.assign({}, pure, { renderRiverSvg });
})(typeof window !== 'undefined' ? window : globalThis);
