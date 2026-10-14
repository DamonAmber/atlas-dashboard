// 星图视图 —— window.AtlasStarmap（design §3a、§10.1–10.2、§10.9、§11.A、§12.4）
//
// 文件分两半：
//   ① 纯函数（布局 / 档位 / 空间索引 / 命中测试 / 标签布局 / 星团聚合连线），不碰 DOM，
//      文件末尾 module.exports 给 node spec 直接 require（同 window.AtlasMarkdown 的写法）
//   ② 渲染器（Canvas 2D，按需 rAF 重绘），只在浏览器里初始化
//
// 星图模块不读 app.js 的 state：数据经 setData(rows) / setFilter(set) / setLinks(payload) 传入，
// 交互经 init(opts) 里的回调交还 app.js（打开文档、快速查看、星表联动）。
(function (root) {
  'use strict';

  // ==================== ① 纯函数 ====================
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  const DEG = Math.PI / 180;
  const GOLDEN = 137.508;
  const CLUSTER_GAP = 28;          // 星团光晕之间的留白（世界坐标，§12.4b）
  const SPIRAL_STEP = 24;
  const SPIRAL_MAX = 20000;
  const GRID_FALLBACK_P = 2000;
  const STAR_CELL = 32;            // 世界坐标空间索引格边
  const LABEL_CELL = 48;           // 屏幕空间标签索引格边
  const LOD_FAR = 0.35;
  const LOD_NEAR = 1.5;
  const S_MIN = 0.05;
  const S_MAX = 8;
  const DOC_QUOTA = { mid: 40, near: 150 };
  const CAND_CAP = 600;
  const STAR_OBSTACLE_CAP = 3000;
  const FAR_CLUSTER_LABELS = 40;
  const LABEL_BUDGET_MS = 4;
  const LABEL_H = 19;
  const CLUSTER_LABEL_H = 20;
  // flags 位
  const F_UNREAD = 1;
  const F_FRESH = 2;               // 未读且 24 小时内
  const F_JUST = 4;                // 刚变更（本会话经 SSE 收到）
  const F_CLOUD = 8;               // 只在 iCloud 里、没下载到本机：星点降低不透明度（design §7.3）

  const nowMs = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now() : () => Date.now();

  // 新鲜度档位：1 = 1 小时内，2 = 24 小时内，3 = 7 天内，4 = 更早（未来时间算第 1 档）
  function tierOf(mtime, now) {
    const a = now - (mtime || 0);
    if (a < HOUR) return 1;
    if (a < DAY) return 2;
    if (a < WEEK) return 3;
    return 4;
  }
  function lodOf(s) { return s < LOD_FAR ? 'far' : s < LOD_NEAR ? 'mid' : 'near'; }

  // djb2，种子可换（同一路径用两个种子得到互不相关的两个哈希）
  function djb2(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(h, 33) + str.charCodeAt(i)) >>> 0;
    return h >>> 0;
  }
  // 路径集合签名：篇数 + 全部 path 哈希的累加（与顺序无关）
  function pathSignature(rows) {
    let acc = 0;
    for (const r of rows) acc = (acc + djb2(r.path, 5381)) >>> 0;
    return rows.length + ':' + acc;
  }

  let spiralCache = null;
  function spiral() {
    if (spiralCache) return spiralCache;
    const x = new Float64Array(SPIRAL_MAX), y = new Float64Array(SPIRAL_MAX);
    for (let k = 0; k < SPIRAL_MAX; k++) {
      const ang = k * GOLDEN * DEG, rr = SPIRAL_STEP * Math.sqrt(k);
      x[k] = Math.cos(ang) * rr; y[k] = Math.sin(ang) * rr;
    }
    spiralCache = { x, y };
    return spiralCache;
  }

  function byName(a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; }

  // 星团半径（client-fix §9）：64 篇以内仍是 R = 14√n（星点密度不变）；超过 64 篇改为对数增长
  // R = 112·(1 + ln(n/64)/2)。以前 800 篇的星团光晕占全部光晕面积的 39%、和 1 篇的星团面积比 800 : 1，
  // 小星团被挤成一个点；现在 800 篇 R ≈ 253（原 396），面积比降到约 330 : 1，大星团内的星点稍密一些
  const R_LINEAR_MAX = 64;
  function clusterRadius(n) {
    n = Math.max(1, n || 0);
    if (n <= R_LINEAR_MAX) return 14 * Math.sqrt(n);
    return 14 * Math.sqrt(R_LINEAR_MAX) * (1 + Math.log(n / R_LINEAR_MAX) / 2);
  }

  // 星团布局（§12.4b）：R = clusterRadius(n)，光晕 H = 1.25R；按项目名排序，依次沿黄金角螺旋
  // （角度 k·137.508°、半径 24√k）找第一个对所有已放置星团 dist ≥ Hi + Hj + 28 的位置。
  // 最多试 20,000 步，失败时沿最外圈外推；P > 2000 退化为按名字的方格排布。
  // 输入 [{ name, count }]，输出按名字排序的 [{ name, count, r, h, cx, cy }]。
  function layoutClusters(projects) {
    const list = projects.slice().sort(byName).map((p) => {
      const r = clusterRadius(p.count);
      return { name: p.name, count: p.count || 0, r, h: 1.25 * r, cx: 0, cy: 0 };
    });
    if (list.length > GRID_FALLBACK_P) {
      let hMax = 0;
      for (const c of list) hMax = Math.max(hMax, c.h);
      const cell = 2 * hMax + CLUSTER_GAP;
      const cols = Math.ceil(Math.sqrt(list.length));
      list.forEach((c, i) => {
        c.cx = (i % cols - (cols - 1) / 2) * cell;
        c.cy = (Math.floor(i / cols) - (cols - 1) / 2) * cell;
      });
      return list;
    }
    // 螺旋候选点只依赖 k，预先算好；allow[k] = 该点上还能放下的最大光晕半径
    // （= min over 已放置星团 (dist − Hj − 28)）。一个点对星团 i 合法 ⇔ allow[k] ≥ Hi，
    // 与"对所有已放置星团 dist ≥ Hi + Hj + 28"逐个检查完全等价，只是不必每次全量重算
    const SP = spiral();
    const allow = new Float64Array(SPIRAL_MAX).fill(Infinity);
    let hMax = 0;
    for (const c of list) hMax = Math.max(hMax, c.h);
    // 螺旋点的均匀网格：放下一个星团后，只有它周围 Hi + 28 + Hmax 以内的点的 allow 会变小
    const gcell = 2 * hMax + CLUSTER_GAP;
    const gkey = (i, j) => (i + 100000) * 200003 + (j + 100000);
    const grid = new Map();
    for (let k = 0; k < SPIRAL_MAX; k++) {
      const key = gkey(Math.floor(SP.x[k] / gcell), Math.floor(SP.y[k] / gcell));
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(k);
    }
    let maxExt = 0;
    for (let ci = 0; ci < list.length; ci++) {
      const c = list[ci];
      let k = 0;
      while (k < SPIRAL_MAX && allow[k] < c.h) k++;
      if (k < SPIRAL_MAX) {
        c.cx = SP.x[k]; c.cy = SP.y[k];
      } else {
        // 外推：放在所有已放置星团最外缘之外，必然不相交
        const ang = ci * GOLDEN * DEG, rr = maxExt + c.h + CLUSTER_GAP;
        c.cx = Math.cos(ang) * rr; c.cy = Math.sin(ang) * rr;
      }
      maxExt = Math.max(maxExt, Math.hypot(c.cx, c.cy) + c.h);
      const gi = Math.floor(c.cx / gcell), gj = Math.floor(c.cy / gcell);
      for (let i = gi - 1; i <= gi + 1; i++) {
        for (let j = gj - 1; j <= gj + 1; j++) {
          const arr = grid.get(gkey(i, j));
          if (!arr) continue;
          for (const q of arr) {
            const v = Math.hypot(SP.x[q] - c.cx, SP.y[q] - c.cy) - c.h - CLUSTER_GAP;
            if (v < allow[q]) allow[q] = v;
          }
        }
      }
    }
    return list;
  }

  // 星的位置：项目内用路径的两个 djb2 在圆盘内均匀分布。每颗星只取决于自己的路径与
  // 所在星团（中心、半径），与其他行无关——新增一篇不会让别的星挪动。
  function layoutStars(rows, clusters) {
    const ci = new Map();
    clusters.forEach((c, i) => ci.set(c.name, i));
    const n = rows.length;
    const x = new Float32Array(n), y = new Float32Array(n), cluster = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const row = rows[i];
      const k = ci.has(row.project || '') ? ci.get(row.project || '') : 0;
      const c = clusters[k];
      const h1 = djb2(row.path, 5381), h2 = djb2(row.path, 52711);
      const th = 2 * Math.PI * (h1 % 3600) / 3600;
      const r = c ? c.r * Math.sqrt((h2 % 1000) / 1000) : 0;
      x[i] = (c ? c.cx : 0) + Math.cos(th) * r;
      y[i] = (c ? c.cy : 0) + Math.sin(th) * r;
      cluster[i] = k;
    }
    return { x, y, cluster };
  }

  // 世界坐标均匀网格（格边 32）
  const cellKey = (i, j) => (i + 100000) * 200003 + (j + 100000);
  function buildSpatialIndex(x, y, n, cell) {
    cell = cell || STAR_CELL;
    const map = new Map();
    for (let k = 0; k < n; k++) {
      const key = cellKey(Math.floor(x[k] / cell), Math.floor(y[k] / cell));
      let arr = map.get(key);
      if (!arr) { arr = []; map.set(key, arr); }
      arr.push(k);
    }
    return { cell, map };
  }
  // 最近的一颗星（世界坐标，半径 r 内，accept(i) 为真才算），没有返回 -1
  function hitTest(index, x, y, wx, wy, r, accept) {
    const c = index.cell;
    const i0 = Math.floor((wx - r) / c), i1 = Math.floor((wx + r) / c);
    const j0 = Math.floor((wy - r) / c), j1 = Math.floor((wy + r) / c);
    let best = -1, bd = r * r;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const arr = index.map.get(cellKey(i, j));
        if (!arr) continue;
        for (const k of arr) {
          if (accept && !accept(k)) continue;
          const dx = x[k] - wx, dy = y[k] - wy, d = dx * dx + dy * dy;
          if (d <= bd) { bd = d; best = k; }
        }
      }
    }
    return best;
  }

  // 屏幕空间标签网格（格边 48）
  function makeLabelGrid() {
    const g = new Map();
    const each = (b, fn) => {
      const i0 = Math.floor(b.x / LABEL_CELL), i1 = Math.floor((b.x + b.w) / LABEL_CELL);
      const j0 = Math.floor(b.y / LABEL_CELL), j1 = Math.floor((b.y + b.h) / LABEL_CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (fn(cellKey(i, j))) return true;
      return false;
    };
    return {
      hit(b) {
        return each(b, (k) => {
          const arr = g.get(k);
          if (!arr) return false;
          for (const o of arr) {
            if (b.x < o.x + o.w && b.x + b.w > o.x && b.y < o.y + o.h && b.y + b.h > o.y) return true;
          }
          return false;
        });
      },
      add(b) {
        each(b, (k) => { let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(b); return false; });
      },
    };
  }

  // 屏幕空间的圆形障碍（星团星盘）：均匀网格存外接框，命中时再做精确的"框 × 圆"判定
  function boxHitsCircle(b, cx, cy, r) {
    const nx = Math.max(b.x, Math.min(cx, b.x + b.w)), ny = Math.max(b.y, Math.min(cy, b.y + b.h));
    const dx = nx - cx, dy = ny - cy;
    return dx * dx + dy * dy < r * r;
  }
  function makeCircleGrid() {
    const g = new Map();
    const cellsOf = (x0, y0, x1, y1, fn) => {
      const i0 = Math.floor(x0 / LABEL_CELL), i1 = Math.floor(x1 / LABEL_CELL);
      const j0 = Math.floor(y0 / LABEL_CELL), j1 = Math.floor(y1 / LABEL_CELL);
      if ((i1 - i0 + 1) * (j1 - j0 + 1) > 4096) return fn(null);   // 超大的圆（放大到很近时）直接进全局表
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (fn(cellKey(i, j))) return true;
      return false;
    };
    const big = [];
    return {
      add(c) {   // { x, y, r, id }
        cellsOf(c.x - c.r, c.y - c.r, c.x + c.r, c.y + c.r, (k) => {
          if (k === null) { big.push(c); return true; }
          let a = g.get(k); if (!a) { a = []; g.set(k, a); } a.push(c); return false;
        });
      },
      hit(b, skipId) {
        for (const c of big) if (c.id !== skipId && boxHitsCircle(b, c.x, c.y, c.r)) return true;
        return cellsOf(b.x, b.y, b.x + b.w, b.y + b.h, (k) => {
          if (k === null) return false;
          const arr = g.get(k);
          if (!arr) return false;
          for (const c of arr) if (c.id !== skipId && boxHitsCircle(b, c.x, c.y, c.r)) return true;
          return false;
        });
      },
    };
  }

  // 首页迷你星图的星团名布局（client-fix §9，纯函数）：
  // items [{ i, x, y, r, w, h, count }]（屏幕坐标；r = 星盘半径），按篇数降序贪心，
  // 依次试星盘外缘的 下 → 上 → 右 → 左；不压任何星团的星盘（含自己的）、不压已放的名字、不出画布。
  // 放不下就不画（悬停 / 进星图再看）。返回 [{ i, x, y, w, h }]
  function placeThumbLabels(items, cw, ch, opts) {
    const gap = (opts && opts.gap) || 3;
    const margin = (opts && opts.margin) || 4;
    const circles = makeCircleGrid();
    for (const it of items) circles.add({ x: it.x, y: it.y, r: it.r + 2, id: -1 });
    const labels = makeLabelGrid();
    const out = [];
    const order = items.slice().sort((a, b) => (b.count - a.count) || (a.i - b.i));
    for (const it of order) {
      const w = it.w, h = it.h;
      const cands = [
        [it.x - w / 2, it.y + it.r + gap],
        [it.x - w / 2, it.y - it.r - gap - h],
        [it.x + it.r + gap + 1, it.y - h / 2],
        [it.x - it.r - gap - 1 - w, it.y - h / 2],
      ];
      for (const [bx, by] of cands) {
        const b = { x: bx, y: by, w, h };
        if (bx < margin || by < margin || bx + w > cw - margin || by + h > ch - margin) continue;
        if (circles.hit(b, null) || labels.hit({ x: bx - 3, y: by - 1, w: w + 6, h: h + 2 })) continue;
        labels.add(b);
        out.push({ i: it.i, x: bx, y: by, w, h });
        break;
      }
    }
    return out;
  }

  // 迷你星图的取景（纯函数）：横竖各自缩放，充分利用宽画布（以前按包围盒等比缩放只用了 31% 的宽度）。
  // 星团中心按 (sx, sy) 映射，星盘与星点按 rs = min(sx, sy) 等比画成圆——
  // 屏幕上两星团中心距 ≥ rs × 世界距离 ≥ rs·(Hi + Hj + 28)，光晕之间仍至少留 28·rs 的空隙。
  // 横竖比例差最多 maxAniso 倍，免得布局被拉得太变形
  function fitThumb(clusters, cw, ch, opts) {
    const pad = (opts && opts.pad) || 22, padB = (opts && opts.padB) || 34;
    const maxAniso = (opts && opts.maxAniso) || 3.5;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of clusters) { x0 = Math.min(x0, c.cx - c.h); y0 = Math.min(y0, c.cy - c.h); x1 = Math.max(x1, c.cx + c.h); y1 = Math.max(y1, c.cy + c.h); }
    if (!clusters.length) { x0 = y0 = 0; x1 = y1 = 1; }
    const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);
    const availW = cw - pad * 2, availH = ch - pad - padB;
    let sx = availW / bw, sy = availH / bh;
    if (sx > sy * maxAniso) sx = sy * maxAniso;
    if (sy > sx * maxAniso) sy = sx * maxAniso;
    sx = Math.min(sx, 6); sy = Math.min(sy, 6);
    const rs = Math.min(sx, sy);
    // 光晕在两侧多占的部分按 rs 计（中心按 sx/sy 映射），重新居中
    const cxs = (v) => v * sx, cys = (v) => v * sy;
    let a0 = Infinity, b0 = Infinity, a1 = -Infinity, b1 = -Infinity;
    for (const c of clusters) {
      a0 = Math.min(a0, cxs(c.cx) - c.h * rs); a1 = Math.max(a1, cxs(c.cx) + c.h * rs);
      b0 = Math.min(b0, cys(c.cy) - c.h * rs); b1 = Math.max(b1, cys(c.cy) + c.h * rs);
    }
    if (!clusters.length) { a0 = b0 = 0; a1 = b1 = 1; }
    const ox = cw / 2 - (a0 + a1) / 2, oy = pad + availH / 2 - (b0 + b1) / 2;
    return { sx, sy, rs, ox, oy, tx: (v) => v * sx + ox, ty: (v) => v * sy + oy };
  }

  // 标签布局（§10.2）。纯函数，每次重绘调用一次。
  // stars: { n, x, y, tier, flags, mtime, hit, labelW, selected, hovered }（labelW = 文档标签文字宽度）
  // clusters: [{ cx, cy, r, count, lw }]（lw = 星团标签宽度）
  // cam: { x, y, s }；viewport: { w, h }；obstacles: 屏幕矩形 [{x,y,w,h}]（HUD 面板，这里外扩 4px）
  // prevPlaced: Set<星下标>（上一帧放上了的，滞回用）
  // 返回 { clusterLabels, docLabels, shown, hidden, candidates, placed }
  function placeLabels(stars, clusters, cam, viewport, obstacles, prevPlaced, opts) {
    const budget = (opts && opts.budgetMs) || LABEL_BUDGET_MS;
    const t0 = nowMs();
    const W = viewport.w, H = viewport.h;
    const L = lodOf(cam.s);
    const sxOf = (wx) => (wx - cam.x) * cam.s + W / 2;
    const syOf = (wy) => (wy - cam.y) * cam.s + H / 2;
    const grid = makeLabelGrid();
    const obstacleBoxes = [];
    for (const o of obstacles || []) {
      const b = { x: o.x - 4, y: o.y - 4, w: o.w + 8, h: o.h + 8 };
      grid.add(b); obstacleBoxes.push(b);
    }
    const sel = stars.selected != null ? stars.selected : -1;
    const hov = stars.hovered != null ? stars.hovered : -1;
    const n = stars.n;
    // 视口内的命中星（远景不放文档标签、也没有星点障碍，不用找）
    const vis = [];
    for (let i = 0; L !== 'far' && i < n; i++) {
      if (stars.hit && !stars.hit[i]) continue;
      const x = sxOf(stars.x[i]), y = syOf(stars.y[i]);
      if (x < -20 || x > W + 20 || y < -20 || y > H + 20) continue;
      vis.push(i);
    }
    // 星点障碍：近景放全部可见星（半径 5），中景只放 1–2 档与未读（半径 3），上限 3000
    if (L !== 'far') {
      const r = L === 'near' ? 5 : 3;
      let k = 0;
      for (const i of vis) {
        if (k >= STAR_OBSTACLE_CAP) break;
        if (L === 'mid' && !(stars.tier[i] <= 2 || (stars.flags[i] & F_UNREAD))) continue;
        const x = sxOf(stars.x[i]), y = syOf(stars.y[i]);
        grid.add({ x: x - r, y: y - r, w: r * 2, h: r * 2 });
        k++;
      }
    }
    const inView = (b) => b.x >= 0 && b.y >= 0 && b.x + b.w <= W && b.y + b.h <= H;

    // ② 星团标签：按篇数降序贪心；远景先试中心（最多 40 个），中 / 近景试外缘 上→下→右→左。
    // 别的星团的星盘也是障碍（client-fix §9）：以前只和别的标签碰撞，远景里一堆小星团的名字
    // 直接压在大星团的星点上。远景放不进中心时退到自己星盘外缘的 下 → 上 → 右 → 左
    const clusterLabels = [];
    let clusterHidden = 0;
    const discs = makeCircleGrid();
    clusters.forEach((c, ci) => {
      const x = sxOf(c.cx), y = syOf(c.cy), r = c.r * cam.s;
      if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) return;
      discs.add({ x, y, r: r + 2, id: ci });
    });
    const order = clusters.map((c, i) => i).sort((a, b) => (clusters[b].count - clusters[a].count) || (a - b));
    for (const ci of order) {
      const c = clusters[ci];
      const w = c.lw || 60, h = CLUSTER_LABEL_H;
      const x = sxOf(c.cx), y = syOf(c.cy), r = c.r * cam.s;
      if (x + r < 0 || x - r > W || y + r < 0 || y - r > H) continue;   // 不在视口里：不计入
      if (L === 'far' && clusterLabels.length >= FAR_CLUSTER_LABELS) { clusterHidden++; continue; }
      const outside = [[x - w / 2, y + r + 7], [x - w / 2, y - r - h - 7], [x + r + 7, y - h / 2], [x - r - 7 - w, y - h / 2]];
      const cands = L === 'far'
        ? [[x - w / 2, y - h / 2]].concat(outside)
        : [outside[1], outside[0], outside[2], outside[3]];
      let ok = false;
      for (const [bx, by] of cands) {
        const b = { x: bx, y: by, w, h };
        if (!inView(b) || grid.hit(b) || discs.hit(b, ci)) continue;
        grid.add(b);
        clusterLabels.push({ i: ci, x: bx, y: by, w, h });
        ok = true;
        break;
      }
      if (!ok) clusterHidden++;
    }

    // ③ 文档标签（只在中 / 近景）
    const docLabels = [];
    const placed = new Set();
    let shown = 0, hidden = 0, candidates = 0;
    if (L !== 'far') {
      let mMin = Infinity, mMax = -Infinity;
      const pool = [];
      for (const i of vis) {
        const f = stars.flags[i];
        const ok = i === sel || i === hov || L === 'near'
          || stars.tier[i] === 1 || (f & F_JUST) || (f & F_FRESH);
        if (!ok) continue;
        pool.push(i);
        const m = stars.mtime[i] || 0;
        if (m < mMin) mMin = m;
        if (m > mMax) mMax = m;
      }
      // 选中星即使不在视口候选里（被筛掉之外的情况）也要保证出现
      if (sel >= 0 && pool.indexOf(sel) < 0 && (!stars.hit || stars.hit[sel])) pool.push(sel);
      const span = mMax > mMin ? mMax - mMin : 1;
      const prio = (i) => {
        const f = stars.flags[i];
        return (i === sel ? 1e8 : 0) + (i === hov ? 5e7 : 0) + ((f & F_JUST) ? 1e7 : 0)
          + ((f & F_FRESH) ? 4e6 : 0) + ((f & F_UNREAD) ? 2e6 : 0) + (5 - stars.tier[i]) * 1e5
          + (prevPlaced && prevPlaced.has(i) ? 5e4 : 0) + ((stars.mtime[i] || 0) - mMin) / span * 1e4;
      };
      const score = new Map();
      for (const i of pool) score.set(i, prio(i));
      pool.sort((a, b) => (score.get(b) - score.get(a)) || (a - b));
      candidates = Math.min(pool.length, CAND_CAP);
      const cand = pool.length > CAND_CAP ? pool.slice(0, CAND_CAP) : pool;
      hidden = pool.length - cand.length;
      const quota = DOC_QUOTA[L];
      const NEAR = [[1, -1], [1, 1], [-1, -1], [-1, 1], [1, 0], [-1, 0], [0, -1], [0, 1]];
      const FAR = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
      for (const i of cand) {
        const forced = i === sel || i === hov;
        if (!forced && (shown >= quota || nowMs() - t0 > budget)) { hidden++; continue; }
        const x = sxOf(stars.x[i]), y = syOf(stars.y[i]);
        const w = (stars.labelW ? stars.labelW[i] : 60) || 60, h = LABEL_H;
        let ok = null;
        for (const [dx, dy] of NEAR) {
          const bx = dx > 0 ? x + 7 : dx < 0 ? x - 7 - w : x - w / 2;
          const by = dy > 0 ? y + 5 : dy < 0 ? y - 5 - h : y - h / 2;
          const b = { x: bx, y: by, w, h };
          if (inView(b) && !grid.hit(b)) { ok = { b, lead: false }; break; }
        }
        if (!ok) {
          for (const [dx, dy] of FAR) {
            const bx = dx > 0 ? x + 26 : x - 26 - w, by = dy > 0 ? y + 18 : y - 18 - h;
            const b = { x: bx, y: by, w, h };
            if (inView(b) && !grid.hit(b)) { ok = { b, lead: true }; break; }
          }
        }
        if (!ok && forced) ok = { b: { x: x + 7, y: y - 5 - h, w, h }, lead: false };
        if (!ok) { hidden++; continue; }
        grid.add(ok.b);
        placed.add(i);
        shown++;
        docLabels.push({ i, x: ok.b.x, y: ok.b.y, w, h, lead: ok.lead, forced, sx: x, sy: y });
      }
    }
    return { clusterLabels, clusterHidden, docLabels, shown, hidden, candidates, placed, obstacles: obstacleBoxes, lod: L };
  }

  // 星团级聚合连线：只统计两端都命中筛选的跨星团边，按引用数降序，最多 limit 对
  // edges：扁平 Int32Array [s0, d0, s1, d1, …]（星下标）或 [[s, d], …]
  function clusterLinks(edges, clusterOf, hit, limit) {
    limit = limit || 100;
    const agg = new Map();
    const flat = !Array.isArray(edges);
    const m = flat ? edges.length / 2 : edges.length;
    for (let k = 0; k < m; k++) {
      const s = flat ? edges[2 * k] : edges[k][0];
      const d = flat ? edges[2 * k + 1] : edges[k][1];
      if (hit && (!hit[s] || !hit[d])) continue;
      const a = clusterOf[s], b = clusterOf[d];
      if (a === b) continue;
      const key = a < b ? a * 1048576 + b : b * 1048576 + a;
      agg.set(key, (agg.get(key) || 0) + 1);
    }
    const out = [];
    for (const [key, n] of agg) out.push({ a: Math.floor(key / 1048576), b: key % 1048576, n });
    out.sort((p, q) => (q.n - p.n) || (p.a - q.a) || (p.b - q.b));
    return out.slice(0, limit);
  }

  const pure = {
    tierOf, lodOf, djb2, pathSignature, layoutClusters, layoutStars, buildSpatialIndex, hitTest,
    placeLabels, clusterLinks, clusterRadius, placeThumbLabels, fitThumb, boxHitsCircle,
    constants: { CLUSTER_GAP, LOD_FAR, LOD_NEAR, DOC_QUOTA, CAND_CAP, STAR_OBSTACLE_CAP, F_UNREAD, F_FRESH, F_JUST, F_CLOUD },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = pure;
  if (typeof document === 'undefined') return;

  // ==================== ② 渲染器 ====================
  const TWINKLE_PERIOD = 1600;
  const TWINKLE_MS = 3 * TWINKLE_PERIOD;
  const FX_INTERVAL = 33;          // 动画层 30fps 节流
  const SETTLE_MS = 120;           // 相机停下多久后重算标签
  const MAX_INTERNAL_LINES = 1500;
  const MAX_ARCS = 100;
  const MAX_STAR_LINKS = 200;

  let opts = {};
  let els = {};
  let ctx = null, fctx = null;
  let canDraw = false;
  let failed = false;
  let warned = false;
  let W = 0, H = 0, DPR = 1;
  const cam = { x: 0, y: 0, s: 1 };
  let camFitted = false;
  let visible = false;
  let dirty = false;
  let rafId = 0;
  let flight = null;
  let movingUntil = 0;
  let settleTimer = null;
  let C = {};                      // 解析后的颜色 / 字体

  // 数据
  let rows = [];
  let sig = '';
  let n = 0;
  let X = new Float32Array(0), Y = new Float32Array(0);
  let TIER = new Uint8Array(0), FLAGS = new Uint8Array(0), CL = new Uint32Array(0);
  let MTIME = new Float64Array(0);
  let HIT = new Uint8Array(0);
  let LABELW = new Float32Array(0);
  let pathIdx = new Map();
  let clusters = [];
  let spatial = null;
  let filterSet = null;
  let hitCount = 0;
  let note = '';
  let now = Date.now();
  // 连线
  let linksRaw = null;             // { paths, edges } | null（null = 不可用）
  let linkEdges = new Int32Array(0);
  let outOff = new Int32Array(1), outTo = new Int32Array(0), inOff = new Int32Array(1), inFrom = new Int32Array(0);
  let intra = [];                  // 每个星团的内部边（边下标）
  let arcs = [];
  // 交互
  let hover = -1, selected = -1, hoverCluster = -1;
  let drag = null;
  let peekTimer = null;
  let peekOurs = false;
  const twinkles = new Map();      // 星下标 → 开始时刻（performance.now）
  let prevJust = new Set();        // 上一次 setData 时刚变更的路径
  // 帧
  let frames = 0;
  let lastLabels = null;
  let labelStats = { shown: 0, hidden: 0 };
  let thumbStats = null;   // 迷你星图最近一次绘制的取景与标签（spec / 诊断用）
  let fxRaf = 0, fxLast = 0;
  let lastHud = '';
  let lastAria = '';

  function reduced() {
    if (document.documentElement.getAttribute('data-motion') === 'reduce') return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  // ---------- 颜色：init、主题 / 皮肤切换、系统深浅变化时读一次 ----------
  function readColors() {
    if (!els.stage) return;
    const probe = document.createElement('span');
    probe.style.display = 'none';
    els.stage.appendChild(probe);
    const col = (v) => { probe.style.color = ''; probe.style.color = `var(${v})`; return getComputedStyle(probe).color; };
    const rs = getComputedStyle(document.documentElement);
    const raw = (v) => rs.getPropertyValue(v).trim();
    C = {
      s1: col('--star-1'), s2: col('--star-2'), s3: col('--star-3'), s4: col('--star-4'),
      halo: col('--star-halo'), link: col('--link-line'), linkHl: col('--link-line-hl'),
      text: col('--text'), dim: col('--text-dim'), faint: col('--text-faint'),
      accent: col('--accent'), unread: col('--unread'), unreadStale: col('--unread-stale'),
      bg: col('--bg'), elev: col('--bg-elev'), border: col('--border-strong'),
      nS: raw('--nebula-s') || '55%', nL: raw('--nebula-l') || '45%', nA: parseFloat(raw('--nebula-a')) || 0.12,
      ui: raw('--font-ui') || 'system-ui, sans-serif', mono: raw('--font-mono') || 'ui-monospace, monospace',
      durMed: parseFloat(raw('--dur-med')) || 280,
    };
    probe.remove();
    const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(C.bg) || [0, 255, 255, 255];
    const lum = (0.2126 * m[1] + 0.7152 * m[2] + 0.0722 * m[3]) / 255;
    C.dark = lum < 0.45;
    C.rgb = (css, a) => {
      const q = /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/.exec(css);
      return q ? `rgba(${q[1]}, ${q[2]}, ${q[3]}, ${a})` : css;
    };
    measureLabels();
    dirtyAll();
  }

  // ---------- 文字宽度 ----------
  let measureCtx = null;
  function textW(font, s) {
    if (!measureCtx) {
      try { measureCtx = document.createElement('canvas').getContext('2d'); } catch { measureCtx = null; }
    }
    if (!measureCtx) return s.length * 7;
    measureCtx.font = font;
    return measureCtx.measureText(s).width;
  }
  function relShort(t) {
    const d = now - (t || 0);
    if (d < HOUR) return Math.max(1, Math.floor(d / 60000)) + '分';
    if (d < DAY) return Math.floor(d / HOUR) + '时';
    return Math.floor(d / DAY) + '天';
  }
  function measureLabels() {
    if (!C.ui) return;
    const fName = `600 11.5px ${C.ui}`, fTime = `11px ${C.mono}`;
    for (let i = 0; i < n; i++) {
      LABELW[i] = textW(fName, rows[i].name || '') + textW(fTime, ' ' + relShort(MTIME[i])) + 12;
    }
    measureClusterLabels();
  }
  function clusterLabelParts(c) {
    const cnt = filterSet ? `${c.hits}/${c.count}` : String(c.count);
    const un = c.unread && (!filterSet || c.hits) ? ` · ${c.unread} 未读` : '';
    return { cnt: ' ' + cnt, un };
  }
  function measureClusterLabels() {
    if (!C.ui) return;
    for (const c of clusters) {
      const p = clusterLabelParts(c);
      c.w1 = textW(`600 12px ${C.ui}`, c.name);
      c.w2 = textW(`500 11px ${C.mono}`, p.cnt);
      c.w3 = p.un ? textW(`500 11px ${C.ui}`, p.un) : 0;
      c.lw = c.w1 + c.w2 + c.w3 + 14;
    }
  }

  // ---------- 数据 ----------
  function computeFlags(_i, row) {
    let f = 0;
    if (row.unread) f |= F_UNREAD;
    if (row.unread && now - (row.mtime || 0) < DAY) f |= F_FRESH;
    if (row.justChanged) f |= F_JUST;
    if (row.cloud) f |= F_CLOUD;
    return f;
  }
  function setData(nextRows) {
    if (failed) return;
    const t = nowMs();
    now = Date.now();
    const nextSig = pathSignature(nextRows);
    const same = nextSig === sig && nextRows.length === n;
    try {
      if (same) {
        // 路径集合没变：原地更新 tier / flags（SSE 一次 change 走这条，O(N) 不分配）。
        // 新数组顺序可能不同：按路径对齐到现有下标；对不上（哈希碰撞）就退回重新布局
        let renamed = false, aligned = true;
        for (let k = 0; k < n && aligned; k++) {
          const row = nextRows[k];
          const j = pathIdx.get(row.path);
          if (j == null) { aligned = false; break; }
          if (rows[j].name !== row.name) renamed = true;
          rows[j] = row;
          MTIME[j] = row.mtime || 0;
          TIER[j] = tierOf(MTIME[j], now);
          FLAGS[j] = computeFlags(j, row);
        }
        if (!aligned) layout(nextRows);
        else {
          if (renamed) measureLabels();
          recountClusters();
        }
      } else {
        layout(nextRows);
      }
    } catch (e) {
      fail('布局', e);
      return;
    }
    noteTwinkles(t);
    applyFilter();
    if (visible && !camFitted && n) fit(false);
    dirtyAll();
  }
  function layout(nextRows) {
    rows = nextRows.slice();
    sig = pathSignature(rows);
    n = rows.length;
    const byProj = new Map();
    for (const r of rows) {
      const p = r.project || '';
      byProj.set(p, (byProj.get(p) || 0) + 1);
    }
    const cl = layoutClusters([...byProj].map(([name, count]) => ({ name, count })));
    const st = layoutStars(rows, cl);
    X = st.x; Y = st.y; CL = st.cluster;
    TIER = new Uint8Array(n); FLAGS = new Uint8Array(n); MTIME = new Float64Array(n);
    HIT = new Uint8Array(n); LABELW = new Float32Array(n);
    pathIdx = new Map();
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      pathIdx.set(r.path, i);
      MTIME[i] = r.mtime || 0;
      TIER[i] = tierOf(MTIME[i], now);
      FLAGS[i] = computeFlags(i, r);
    }
    clusters = cl.map((c) => ({ ...c, idx: [], unread: 0, fresh: 0, latest: 0, hits: c.count, freshestTier: 4 }));
    for (let i = 0; i < n; i++) clusters[CL[i]].idx.push(i);
    spatial = buildSpatialIndex(X, Y, n, STAR_CELL);
    hover = -1; hoverCluster = -1;
    if (selected >= n) selected = -1;
    twinkles.clear();
    recountClusters();
    measureLabels();
    mapLinks();
    // 新数据集：下次显示时重新适配（同一会话里数据集不变时保留相机）
    if (!n) camFitted = false;
  }
  function recountClusters() {
    for (const c of clusters) { c.unread = 0; c.fresh = 0; c.latest = 0; c.freshestTier = 4; }
    for (let i = 0; i < n; i++) {
      const c = clusters[CL[i]];
      if (FLAGS[i] & F_UNREAD) c.unread++;
      if (FLAGS[i] & F_FRESH) c.fresh++;
      if (MTIME[i] > c.latest) c.latest = MTIME[i];
      if (TIER[i] < c.freshestTier) c.freshestTier = TIER[i];
    }
  }
  // 刚变更：路径在这次 setData 里第一次带上 justChanged → 开始 3 次轻闪
  function noteTwinkles(t) {
    const cur = new Set();
    for (let i = 0; i < n; i++) {
      if (!(FLAGS[i] & F_JUST)) continue;
      const p = rows[i].path;
      cur.add(p);
      if (!prevJust.has(p)) twinkles.set(i, t);
    }
    for (const [i] of twinkles) if (!(FLAGS[i] & F_JUST)) twinkles.delete(i);
    prevJust = cur;
    if (twinkles.size) startFx();
  }
  function retier(ts) {
    now = ts || Date.now();
    for (let i = 0; i < n; i++) {
      TIER[i] = tierOf(MTIME[i], now);
      const r = rows[i];
      FLAGS[i] = computeFlags(i, r);
    }
    recountClusters();
    measureLabels();
    updateMeta();
    dirtyAll();
  }
  function setFilter(set) {
    filterSet = set && typeof set.has === 'function' ? set : null;
    applyFilter();
    dirtyAll();
  }
  function applyFilter() {
    hitCount = 0;
    for (const c of clusters) c.hits = 0;
    for (let i = 0; i < n; i++) {
      const h = !filterSet || filterSet.has(rows[i].path) ? 1 : 0;
      HIT[i] = h;
      if (h) { hitCount++; clusters[CL[i]].hits++; }
    }
    if (hover >= 0 && !HIT[hover]) hover = -1;
    arcs = clusterLinks(linkEdges, CL, HIT, MAX_ARCS);
    measureClusterLabels();
    updateMeta();
  }
  function setNote(s) { note = s || ''; lastHud = ''; dirtyAll(); }

  // ---------- 连线 ----------
  function setLinks(payload) {
    if (payload && Array.isArray(payload.edges) && Array.isArray(payload.paths)) {
      linksRaw = { paths: payload.paths, edges: payload.edges };
    } else {
      linksRaw = null;
    }
    mapLinks();
    applyFilter();
    dirtyAll();
  }
  function mapLinks() {
    const pairs = [];
    if (linksRaw) {
      const local = linksRaw.paths.map((p) => (pathIdx.has(p) ? pathIdx.get(p) : -1));
      for (const e of linksRaw.edges) {
        const s = local[e[0]], d = local[e[1]];
        if (s == null || d == null || s < 0 || d < 0 || s === d) continue;
        pairs.push(s, d);
      }
    }
    linkEdges = Int32Array.from(pairs);
    const m = linkEdges.length / 2;
    // CSR 邻接：出链 / 入链
    outOff = new Int32Array(n + 1); inOff = new Int32Array(n + 1);
    for (let k = 0; k < m; k++) { outOff[linkEdges[2 * k] + 1]++; inOff[linkEdges[2 * k + 1] + 1]++; }
    for (let i = 0; i < n; i++) { outOff[i + 1] += outOff[i]; inOff[i + 1] += inOff[i]; }
    outTo = new Int32Array(m); inFrom = new Int32Array(m);
    const oc = outOff.slice(0, n), ic = inOff.slice(0, n);
    for (let k = 0; k < m; k++) {
      const s = linkEdges[2 * k], d = linkEdges[2 * k + 1];
      outTo[oc[s]++] = d; inFrom[ic[d]++] = s;
    }
    intra = clusters.map(() => []);
    for (let k = 0; k < m; k++) {
      const a = CL[linkEdges[2 * k]];
      if (a === CL[linkEdges[2 * k + 1]]) intra[a].push(k);
    }
    arcs = clusterLinks(linkEdges, CL, HIT, MAX_ARCS);
    updateLegend();
  }
  function linkCounts(path) {
    const i = pathIdx.get(path);
    if (i == null || !linksRaw) return { out: 0, in: 0 };
    return { out: outOff[i + 1] - outOff[i], in: inOff[i + 1] - inOff[i] };
  }

  // ---------- 相机 ----------
  const sx = (wx) => (wx - cam.x) * cam.s + W / 2;
  const sy = (wy) => (wy - cam.y) * cam.s + H / 2;
  const wxOf = (px) => (px - W / 2) / cam.s + cam.x;
  const wyOf = (py) => (py - H / 2) / cam.s + cam.y;
  const clampS = (s) => Math.max(S_MIN, Math.min(S_MAX, s));
  function bounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of clusters) {
      x0 = Math.min(x0, c.cx - c.h); y0 = Math.min(y0, c.cy - c.h);
      x1 = Math.max(x1, c.cx + c.h); y1 = Math.max(y1, c.cy + c.h);
    }
    if (!isFinite(x0)) return { x0: -50, y0: -50, x1: 50, y1: 50 };
    return { x0, y0, x1, y1 };
  }
  function fit(animate) {
    if (!W || !H) return;
    const b = bounds();
    const pad = 70;
    const s = clampS(Math.min((W - pad * 2) / Math.max(1, b.x1 - b.x0), (H - pad * 2 - 40) / Math.max(1, b.y1 - b.y0)));
    flyTo((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, s, animate);
    camFitted = true;
  }
  function flyTo(x, y, s, animate) {
    s = clampS(s);
    if (!animate || reduced() || !visible) {
      flight = null;
      cam.x = x; cam.y = y; cam.s = s;
      moved();
      return;
    }
    flight = { from: { x: cam.x, y: cam.y, s: cam.s }, to: { x, y, s }, t0: nowMs(), dur: C.durMed || 280 };
    moved();
  }
  function zoomAt(px, py, k, animate) {
    const ns = clampS(cam.s * k);
    const wx = wxOf(px), wy = wyOf(py);
    flyTo(wx - (px - W / 2) / ns, wy - (py - H / 2) / ns, ns, animate);
    hideTip();
  }
  function flyToCluster(ci) {
    const c = clusters[ci];
    if (!c) return;
    flyTo(c.cx, c.cy, Math.min(S_MAX, Math.min(W, H) * 0.42 / (c.r + 20)), true);
  }
  function moved() {
    movingUntil = nowMs() + SETTLE_MS;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; lastLabels = null; markDirty(); }, SETTLE_MS + 10);
    closeOurPeek();
    markDirty();
    startFx();
  }

  // ---------- 绘制调度 ----------
  function markDirty() {
    dirty = true;
    if (!visible || !canDraw || rafId) return;
    rafId = requestAnimationFrame(frame);
  }
  function dirtyAll() { lastLabels = null; markDirty(); }
  function frame() {
    rafId = 0;
    if (!visible || !canDraw) return;
    if (flight) {
      const p = Math.min(1, (nowMs() - flight.t0) / flight.dur), e = 1 - Math.pow(1 - p, 3);
      cam.x = flight.from.x + (flight.to.x - flight.from.x) * e;
      cam.y = flight.from.y + (flight.to.y - flight.from.y) * e;
      cam.s = flight.from.s * Math.pow(flight.to.s / flight.from.s, e);
      movingUntil = nowMs() + SETTLE_MS;
      if (p >= 1) { flight = null; moved(); }
      dirty = true;
    }
    if (dirty) {
      dirty = false;
      try { draw(); } catch (e) { fail('绘制', e); return; }
      frames++;
    }
    if (flight) rafId = requestAnimationFrame(frame);
  }

  // ---------- 绘制 ----------
  const R_T = [0, 3.5, 2.75, 2, 1.5];
  function starR(t, L) { return L === 'near' ? R_T[t] * Math.min(1.6, 0.7 + cam.s * 0.3) : R_T[t] * 0.62; }
  function inViewXY(x, y, m) { return x >= -m && x <= W + m && y >= -m && y <= H + m; }
  function fxActive() { return visible && canDraw && !reduced() && !document.hidden && twinkles.size > 0; }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const L = lodOf(cam.s);
    if (!n) { updateHud(L); return; }
    drawNebulae(L);
    if (L === 'far') {
      drawFarDensity();
      drawArcs(1);
    } else {
      drawLinks(L);
      drawStars(L);
    }
    drawRings();
    drawLabels(L);
    updateHud(L);
  }

  function drawNebulae(L) {
    for (const c of clusters) {
      const x = sx(c.cx), y = sy(c.cy), hR = c.h * cam.s, r = c.r * cam.s;
      if (x + hR < 0 || x - hR > W || y + hR < 0 || y - hR > H) continue;
      const a = C.nA * (L === 'far' ? 1.8 : 1.15) * (c.freshestTier <= 2 ? 1.25 : 0.8) * (c.hits ? 1 : 0.3);
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, hR));
      g.addColorStop(0, `hsl(240 ${C.nS} ${C.nL} / ${a})`);
      g.addColorStop(0.6, `hsl(240 ${C.nS} ${C.nL} / ${a * 0.45})`);
      g.addColorStop(1, `hsl(240 ${C.nS} ${C.nL} / 0)`);
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(x, y, Math.max(1, hR), 0, Math.PI * 2); ctx.fill();
      // §11.A2：中 / 近景给星团画淡底色 + 发丝轮廓（远景不画）
      if (L !== 'far') {
        ctx.beginPath(); ctx.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
        ctx.fillStyle = C.dark ? 'rgba(141,141,240,.035)' : 'rgba(81,81,207,.035)';
        ctx.fill();
        ctx.strokeStyle = C.dark ? 'rgba(163,171,220,.16)' : 'rgba(81,81,207,.18)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }

  // §11.A3 远景：命中的星投到屏幕 3px 网格，每格一个 1.6px 点；未读 / 1 小时内单独画实心点
  let farCnt = new Uint16Array(0), farTier = new Uint8Array(0);
  function drawFarDensity() {
    const G = 3, cols = Math.ceil(W / G) + 1, rws = Math.ceil(H / G) + 1, size = cols * rws;
    if (farCnt.length < size) { farCnt = new Uint16Array(size); farTier = new Uint8Array(size); }
    else { farCnt.fill(0, 0, size); }
    farTier.fill(9, 0, size);
    for (let i = 0; i < n; i++) {
      if (!HIT[i]) continue;
      const x = sx(X[i]), y = sy(Y[i]);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const k = ((y / G) | 0) * cols + ((x / G) | 0);
      if (farCnt[k] < 65535) farCnt[k]++;
      if (TIER[i] < farTier[k]) farTier[k] = TIER[i];
    }
    // 颜色取格内最新一颗的档位（至少第 2 档亮度），按颜色分三批画，一批只切一次 fillStyle
    const col = [null, C.s2, C.s2, C.s3, C.s4];
    for (let t = 4; t >= 2; t--) {
      ctx.fillStyle = col[t];
      for (let k = 0; k < size; k++) {
        const cnt = farCnt[k];
        if (!cnt || Math.max(2, farTier[k]) !== t) continue;
        ctx.globalAlpha = Math.min(1, 0.35 + 0.18 * cnt);
        ctx.fillRect((k % cols) * G, ((k / cols) | 0) * G, 1.6, 1.6);
      }
    }
    ctx.globalAlpha = 1;
    for (let i = 0; i < n; i++) {
      if (!HIT[i]) continue;
      const f = FLAGS[i];
      if (!(f & F_UNREAD) && TIER[i] > 1) continue;
      const x = sx(X[i]), y = sy(Y[i]);
      if (!inViewXY(x, y, 4)) continue;
      ctx.fillStyle = (f & F_UNREAD) ? C.unread : C.s1;
      ctx.beginPath(); ctx.arc(x, y, (f & F_FRESH) ? 2.2 : 1.6, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawArcs(alphaK) {
    if (!arcs.length) return;
    ctx.strokeStyle = C.linkHl;
    for (const { a, b, n: cnt } of arcs) {
      const p = clusters[a], q = clusters[b];
      const x1 = sx(p.cx), y1 = sy(p.cy), x2 = sx(q.cx), y2 = sy(q.cy);
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1;
      const bend = len * 0.18, cx = mx - dy / len * bend, cy = my + dx / len * bend;
      ctx.globalAlpha = Math.min(0.8, 0.25 + 0.12 * Math.log2(cnt + 1)) * alphaK;
      ctx.lineWidth = Math.min(3, 0.6 + 0.5 * Math.log2(cnt + 1));
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.quadraticCurveTo(cx, cy, x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // §12.4a：中景默认不画星团内部引用，只在悬停 / 选中星或悬停星团时画该星团的；
  // 近景默认淡显（.55）；星团间聚合弧线不变。悬停 / 选中星时完整高亮它的入链与出链
  function drawLinks(L) {
    const t0 = nowMs();
    const sel = hover >= 0 ? hover : selected;
    const focusHas = sel >= 0 && (outOff[sel + 1] - outOff[sel] + inOff[sel + 1] - inOff[sel]) > 0;
    const hc = sel >= 0 ? CL[sel] : hoverCluster;
    const lists = L === 'near' ? intra : (hc >= 0 && intra[hc] ? [intra[hc]] : []);
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.link;
    ctx.globalAlpha = focusHas ? 0.25 : (L === 'near' ? 0.55 : 0.45);
    ctx.beginPath();
    let drawn = 0;
    outer:
    for (const list of lists) {
      for (const k of list) {
        const s = linkEdges[2 * k], d = linkEdges[2 * k + 1];
        if (!HIT[s] || !HIT[d]) continue;
        const x1 = sx(X[s]), y1 = sy(Y[s]), x2 = sx(X[d]), y2 = sy(Y[d]);
        if ((x1 < 0 && x2 < 0) || (x1 > W && x2 > W) || (y1 < 0 && y2 < 0) || (y1 > H && y2 > H)) continue;
        ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        if (++drawn >= MAX_INTERNAL_LINES) break outer;
        // 超出 4ms 预算先丢内部线
        if ((drawn & 63) === 0 && nowMs() - t0 > LABEL_BUDGET_MS) break outer;
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    drawArcs(focusHas ? 0.15 : 0.4);
    if (!focusHas) return;
    ctx.strokeStyle = C.linkHl;
    ctx.fillStyle = C.linkHl;
    ctx.lineWidth = 1.5;
    let cnt = 0;
    const one = (from, to, other) => {
      if (cnt++ >= MAX_STAR_LINKS || !HIT[other]) return;
      const fx = sx(X[from]), fy = sy(Y[from]), tx = sx(X[to]), ty = sy(Y[to]);
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(tx, ty); ctx.stroke();
      const ang = Math.atan2(ty - fy, tx - fx), ax = tx - Math.cos(ang) * 6, ay = ty - Math.sin(ang) * 6;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(ax - Math.cos(ang - 0.45) * 6, ay - Math.sin(ang - 0.45) * 6);
      ctx.moveTo(ax, ay); ctx.lineTo(ax - Math.cos(ang + 0.45) * 6, ay - Math.sin(ang + 0.45) * 6);
      ctx.stroke();
      ctx.beginPath(); ctx.arc(sx(X[other]), sy(Y[other]), 3, 0, Math.PI * 2); ctx.fill();
    };
    for (let k = outOff[sel]; k < outOff[sel + 1]; k++) one(sel, outTo[k], outTo[k]);
    for (let k = inOff[sel]; k < inOff[sel + 1]; k++) one(inFrom[k], sel, inFrom[k]);
  }

  function drawStars(L) {
    const near = L === 'near';
    // 不命中筛选的星：独立编码，先画（--star-4、第 4 档半径、alpha .2、无外晕）
    if (filterSet) {
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = C.s4;
      const d = Math.max(1, starR(4, L) * 1.6);
      for (let i = 0; i < n; i++) {
        if (HIT[i]) continue;
        const x = sx(X[i]), y = sy(Y[i]);
        if (!inViewXY(x, y, 10)) continue;
        ctx.fillRect(x - d / 2, y - d / 2, d, d);
      }
      ctx.globalAlpha = 1;
    }
    const tcol = [null, C.s1, C.s2, C.s3, C.s4];
    for (let t = 4; t >= 1; t--) {
      const r = starR(t, L);
      for (let i = 0; i < n; i++) {
        if (!HIT[i] || TIER[i] !== t) continue;
        const x = sx(X[i]), y = sy(Y[i]);
        if (!inViewXY(x, y, 10)) continue;
        const cloud = FLAGS[i] & F_CLOUD;
        if (cloud) ctx.globalAlpha *= 0.45;
        if (t <= 2) {
          ctx.fillStyle = C.halo;
          ctx.beginPath(); ctx.arc(x, y, r * (near ? 2.6 : 2.4), 0, Math.PI * 2); ctx.fill();
        }
        ctx.fillStyle = tcol[t];
        if (near || t <= 2) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.8, r), 0, Math.PI * 2); ctx.fill(); }
        else { const d = Math.max(1, r * 1.6); ctx.fillRect(x - d / 2, y - d / 2, d, d); }
        if (cloud) ctx.globalAlpha /= 0.45;
      }
    }
    // §11.B4：未读星画实心点（新鲜 3.2px、较早 2.4px）；正在轻闪的交给动画层
    const fxOn = fxActive();
    for (let i = 0; i < n; i++) {
      if (!HIT[i] || !(FLAGS[i] & F_UNREAD)) continue;
      if (fxOn && twinkles.has(i)) continue;
      const x = sx(X[i]), y = sy(Y[i]);
      if (!inViewXY(x, y, 6)) continue;
      const fresh = FLAGS[i] & F_FRESH;
      ctx.fillStyle = fresh ? C.unread : C.unreadStale;
      ctx.beginPath(); ctx.arc(x, y, fresh ? 3.2 : 2.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawRings() {
    const ring = (i, w) => {
      if (i < 0 || i >= n) return;
      ctx.strokeStyle = C.accent; ctx.lineWidth = w;
      ctx.beginPath(); ctx.arc(sx(X[i]), sy(Y[i]), 8, 0, Math.PI * 2); ctx.stroke();
    };
    ring(selected, 2);
    if (hover !== selected) ring(hover, 1.5);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function hudObstacles() {
    const out = [];
    if (!els.stage) return out;
    const sr = els.stage.getBoundingClientRect();
    els.stage.querySelectorAll('.sm-panel').forEach((el) => {
      if (el.classList.contains('hidden') || !el.offsetParent) return;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      out.push({ x: r.left - sr.left, y: r.top - sr.top, w: r.width, h: r.height });
    });
    return out;
  }
  function drawLabels(L) {
    let res;
    const moving = nowMs() < movingUntil;
    if (moving && lastLabels && lastLabels.lod === L) {
      // 相机移动中：复用上一帧的放置结果，只按新相机平移；停下 120ms 后重算
      res = lastLabels;
      for (const d of res.docLabels) {
        const nx = sx(X[d.i]), ny = sy(Y[d.i]);
        d.x += nx - d.sx; d.y += ny - d.sy; d.sx = nx; d.sy = ny;
      }
      for (const c of res.clusterLabels) {
        const cl = clusters[c.i], nx = sx(cl.cx), ny = sy(cl.cy);
        if (c.cx0 != null) { c.x += nx - c.cx0; c.y += ny - c.cy0; }
        c.cx0 = nx; c.cy0 = ny;
      }
    } else {
      res = placeLabels(
        { n, x: X, y: Y, tier: TIER, flags: FLAGS, mtime: MTIME, hit: HIT, labelW: LABELW, selected, hovered: hover },
        clusters, cam, { w: W, h: H }, hudObstacles(), lastLabels ? lastLabels.placed : null);
      for (const c of res.clusterLabels) { c.cx0 = sx(clusters[c.i].cx); c.cy0 = sy(clusters[c.i].cy); }
      lastLabels = res;
      // HUD「标签 n 显示 · m 隐藏」含星团名（远景只有星团名，以前那里永远读作 0 · 0）
      labelStats = { shown: res.shown + res.clusterLabels.length, hidden: res.hidden + (res.clusterHidden || 0) };
    }
    ctx.textBaseline = 'middle';
    const pillA = C.rgb(C.bg, 0.72);
    for (const lb of res.clusterLabels) {
      const c = clusters[lb.i];
      const p = clusterLabelParts(c);
      ctx.fillStyle = pillA; roundRect(lb.x, lb.y, lb.w, lb.h, 6); ctx.fill();
      const ty = lb.y + lb.h / 2 + 0.5;
      ctx.fillStyle = c.hits ? C.text : C.dim; ctx.font = `600 12px ${C.ui}`; ctx.fillText(c.name, lb.x + 7, ty);
      ctx.fillStyle = C.faint; ctx.font = `500 11px ${C.mono}`; ctx.fillText(p.cnt, lb.x + 7 + c.w1, ty);
      if (p.un) { ctx.fillStyle = C.unread; ctx.font = `500 11px ${C.ui}`; ctx.fillText(p.un, lb.x + 7 + c.w1 + c.w2, ty); }
    }
    const docBg = C.rgb(C.elev, 0.88);
    for (const d of res.docLabels) {
      const i = d.i;
      if (d.lead) {
        ctx.strokeStyle = C.border; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(d.sx, d.sy);
        ctx.lineTo(d.x < d.sx ? d.x + d.w : d.x, d.y < d.sy ? d.y + d.h : d.y); ctx.stroke();
      }
      ctx.fillStyle = docBg; roundRect(d.x, d.y, d.w, d.h, 5); ctx.fill();
      ctx.strokeStyle = d.forced ? C.accent : C.border; ctx.lineWidth = 1; ctx.stroke();
      const nm = rows[i].name || '';
      ctx.font = `${TIER[i] === 1 ? 600 : 500} 11.5px ${C.ui}`;
      ctx.fillStyle = C.text; ctx.fillText(nm, d.x + 6, d.y + d.h / 2 + 0.5);
      const tw = ctx.measureText(nm).width;
      ctx.font = `11px ${C.mono}`; ctx.fillStyle = C.faint;
      ctx.fillText(' ' + relShort(MTIME[i]), d.x + 6 + tw, d.y + d.h / 2 + 0.5);
    }
  }

  // ---------- HUD / 图例 / 读屏摘要 ----------
  function counts() {
    let d24 = 0, un = 0;
    for (let i = 0; i < n; i++) { if (TIER[i] <= 2) d24++; if (FLAGS[i] & F_UNREAD) un++; }
    return { d24, un };
  }
  let cachedCounts = { d24: 0, un: 0 };
  function updateMeta() {
    cachedCounts = counts();
    const { d24, un } = cachedCounts;
    const fmt = (v) => v.toLocaleString();
    let aria = `星图：${clusters.length} 个项目、${fmt(n)} 篇文档，24 小时内改动 ${fmt(d24)} 篇，未读 ${fmt(un)} 篇。`;
    if (filterSet) aria += `当前筛选命中 ${fmt(hitCount)} / ${fmt(n)} 篇。`;
    aria += '可在右侧星表中逐项浏览。';
    if (els.canvas && aria !== lastAria) { els.canvas.setAttribute('aria-label', aria); lastAria = aria; }
    updateLegend();
    lastHud = '';
  }
  function updateHud(L) {
    if (els.scale) els.scale.textContent = cam.s.toFixed(2) + '×';
    if (els.lod) {
      els.lod.querySelectorAll('[data-lod]').forEach((e) => e.setAttribute('aria-current', String(e.dataset.lod === L)));
    }
    if (!els.readout) return;
    const { d24, un } = cachedCounts;
    const fmt = (v) => v.toLocaleString();
    const seg = (k, v, extra, cls) => `<span class="hud-seg"><span class="k">${k}</span><b${cls ? ` class="${cls}"` : ''}>${v}</b>${extra || ''}</span>`;
    const html = seg('星团', fmt(clusters.length))
      + (filterSet ? seg('命中', fmt(hitCount), `<span class="t"> / ${fmt(n)}</span>`) : seg('文档', fmt(n)))
      + seg('24 小时内', fmt(d24))
      + seg('未读', fmt(un), '', un ? 'hot' : '')
      + seg('标签', fmt(labelStats.shown), `<span class="t"> 显示 · ${fmt(labelStats.hidden)} 隐藏</span>`)
      + (note ? `<span class="hud-note">${note}</span>` : '');
    if (html !== lastHud) {
      els.readout.innerHTML = html;
      els.readout.dataset.hits = String(filterSet ? hitCount : n);
      els.readout.dataset.total = String(n);
      lastHud = html;
    }
  }
  function updateLegend() {
    const lg = els.legend;
    if (!lg) return;
    const t = [0, 0, 0, 0, 0];
    let fresh = 0, just = 0;
    for (let i = 0; i < n; i++) { t[TIER[i]]++; if (FLAGS[i] & F_UNREAD) fresh++; if (FLAGS[i] & F_JUST) just++; }
    const put = (k, v) => { const e = lg.querySelector(`[data-lg="${k}"]`); if (e) e.textContent = v.toLocaleString(); };
    put('t1', t[1]); put('t2', t[2]); put('t3', t[3]); put('t4', t[4]); put('unread', fresh); put('just', just);
    const m = linkEdges.length / 2;
    let inner = 0;
    for (const list of intra) inner += list.length;
    put('intra', inner); put('inter', m - inner);
    lg.classList.toggle('links-na', !linksRaw);
  }

  // ---------- 动画层：只画视口内刚变更的星（透明度轻闪，30fps） ----------
  function startFx() {
    if (!fxActive() || fxRaf) return;
    fxRaf = requestAnimationFrame(fxLoop);
  }
  function stopFx() {
    if (fxRaf) cancelAnimationFrame(fxRaf);
    fxRaf = 0;
    if (fctx) { fctx.setTransform(DPR, 0, 0, DPR, 0, 0); fctx.clearRect(0, 0, W, H); }
  }
  function fxLoop(t) {
    fxRaf = 0;
    const tn = nowMs();
    for (const [i, st] of twinkles) if (tn - st >= TWINKLE_MS) twinkles.delete(i);
    if (!fxActive()) { stopFx(); markDirty(); return; }
    if (t - fxLast >= FX_INTERVAL) {
      fxLast = t;
      const L = lodOf(cam.s);
      fctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      fctx.clearRect(0, 0, W, H);
      let any = false;
      if (L !== 'far') {
        for (const [i, st] of twinkles) {
          if (!HIT[i]) continue;
          const x = sx(X[i]), y = sy(Y[i]);
          if (!inViewXY(x, y, 6)) continue;
          any = true;
          const el = tn - st;
          fctx.globalAlpha = 0.35 + 0.65 * (Math.cos(el / TWINKLE_PERIOD * Math.PI * 2) + 1) / 2;
          const f = FLAGS[i];
          fctx.fillStyle = (f & F_UNREAD) ? ((f & F_FRESH) ? C.unread : C.unreadStale) : C.s1;
          fctx.beginPath(); fctx.arc(x, y, (f & F_UNREAD) && !(f & F_FRESH) ? 2.4 : 3.2, 0, Math.PI * 2); fctx.fill();
        }
        fctx.globalAlpha = 1;
      }
      frames++;
      // 视口里没有对象：停下（相机移动 / 数据变化时会重新启动）
      if (!any) { stopFx(); return; }
    }
    fxRaf = requestAnimationFrame(fxLoop);
  }

  // ---------- 悬停 / 快速查看 ----------
  function hideTip() { if (els.tip) els.tip.classList.add('hidden'); }
  function closeOurPeek() {
    if (peekTimer) { clearTimeout(peekTimer); peekTimer = null; }
    if (peekOurs) {
      peekOurs = false;
      if (opts.onPeekClose) opts.onPeekClose();
    }
  }
  function showTip(i) {
    if (!els.tip) return;
    const r = rows[i];
    const lc = linkCounts(r.path);
    const rel = opts.fmtRel ? opts.fmtRel(r.mtime) : relShort(r.mtime);
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    els.tip.innerHTML = `<div class="n">${esc(r.name || '')}</div>`
      + `<div class="m">${esc(r.project || '')} · <span class="mono">${esc(rel)}</span>${(FLAGS[i] & F_UNREAD) ? ' · <span class="u">未读</span>' : ''}${(FLAGS[i] & F_JUST) ? ' · 刚变更' : ''}${(FLAGS[i] & F_CLOUD) ? ' · 在 iCloud 中' : ''}</div>`
      + `<div class="m">引用 ${lc.out} · 被引用 ${lc.in}</div>`;
    els.tip.style.left = sx(X[i]) + 'px';
    els.tip.style.top = sy(Y[i]) + 'px';
    els.tip.classList.remove('hidden');
  }
  function anchorFor(i) {
    let a = els.anchor;
    if (!a) {
      a = document.createElement('span');
      a.className = 'starmap-anchor';
      a.setAttribute('aria-hidden', 'true');
      els.stage.appendChild(a);
      els.anchor = a;
    }
    const r = 6;
    a.style.left = (sx(X[i]) - r) + 'px';
    a.style.top = (sy(Y[i]) - r) + 'px';
    a.style.width = a.style.height = (r * 2) + 'px';
    a.dataset.path = rows[i].path;
    return a;
  }
  function setHover(i) {
    if (i === hover) return;
    hover = i;
    els.canvas.classList.toggle('on-star', i >= 0);
    closeOurPeek();
    if (i >= 0) {
      showTip(i);
      const path = rows[i].path;
      peekTimer = setTimeout(() => {
        peekTimer = null;
        if (hover !== i || !opts.onPeek) return;
        hideTip();
        peekOurs = true;
        opts.onPeek(path, anchorFor(i));
      }, 450);
    } else {
      hideTip();
    }
    dirtyAll();
  }
  function starAt(px, py) {
    if (!spatial || lodOf(cam.s) === 'far') return -1;
    return hitTest(spatial, X, Y, wxOf(px), wyOf(py), 10 / cam.s, (k) => HIT[k] === 1);
  }
  function clusterAt(px, py) {
    const wx = wxOf(px), wy = wyOf(py);
    let best = -1, bd = Infinity;
    clusters.forEach((c, i) => {
      const d = Math.hypot(c.cx - wx, c.cy - wy);
      if (d <= c.r + 6 / cam.s && d < bd) { bd = d; best = i; }
    });
    return best;
  }
  function local(e) {
    const r = els.canvas.getBoundingClientRect();
    return { px: e.clientX - r.left, py: e.clientY - r.top };
  }
  function bindPointer() {
    const cv = els.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y, moved: false };
      try { cv.setPointerCapture(e.pointerId); } catch {}
    });
    cv.addEventListener('pointermove', (e) => {
      const { px, py } = local(e);
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; cv.classList.add('panning'); setHover(-1); }
        if (drag.moved) { flight = null; cam.x = drag.cx - dx / cam.s; cam.y = drag.cy - dy / cam.s; moved(); }
        return;
      }
      const i = starAt(px, py);
      setHover(i);
      const hc = i >= 0 ? CL[i] : clusterAt(px, py);
      if (hc !== hoverCluster) {
        hoverCluster = hc;
        dirtyAll();
        if (opts.onClusterHover) opts.onClusterHover(hc >= 0 ? clusters[hc].name : null);
      }
    });
    const end = (e) => {
      cv.classList.remove('panning');
      const wasDrag = drag && drag.moved;
      const had = !!drag;
      drag = null;
      if (!had || wasDrag || e.type === 'pointercancel') return;
      const { px, py } = local(e);
      const i = starAt(px, py);
      if (i >= 0) { if (opts.onOpen) opts.onOpen(rows[i].path); return; }
      const c = clusterAt(px, py);
      if (c >= 0) {
        if (lodOf(cam.s) === 'far') flyToCluster(c);
        if (opts.onClusterActivate) opts.onClusterActivate(clusters[c].name);
      }
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
      if (drag) return;
      setHover(-1);
      if (hoverCluster !== -1) {
        hoverCluster = -1; dirtyAll();
        if (opts.onClusterHover) opts.onClusterHover(null);
      }
    });
    cv.addEventListener('dblclick', (e) => { const { px, py } = local(e); zoomAt(px, py, 1.8, true); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { px, py } = local(e);
      zoomAt(px, py, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), false);
    }, { passive: false });
    // 画布键盘：只在 #starmap-canvas 上处理，不注册到全局
    cv.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = 60 / cam.s;
      const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (pan) { e.preventDefault(); flight = null; cam.x += pan[0]; cam.y += pan[1]; moved(); return; }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(W / 2, H / 2, 1.4, true); return; }
      if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(W / 2, H / 2, 1 / 1.4, true); return; }
      if (e.key === '0') { e.preventDefault(); fit(true); return; }
      if (e.key === 'Enter') { e.preventDefault(); if (opts.onEnterCatalog) opts.onEnterCatalog(); }
    });
  }

  // ---------- 尺寸 ----------
  function resize() {
    if (!els.stage || !canDraw) return;
    const r = els.stage.getBoundingClientRect();
    if (!r.width || !r.height) return;
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    for (const c of [els.canvas, els.fx]) {
      c.width = Math.round(W * DPR);
      c.height = Math.round(H * DPR);
    }
    if (!camFitted && n) fit(false);
    closeOurPeek();
    dirtyAll();
    startFx();
  }

  function fail(where, e) {
    if (where === '绘制' || where === '布局') console.error(`[星图] ${where}失败，已切换为列表`, e);
    failed = true;
    canDraw = false;
    stopFx();
    if (opts.onUnavailable) opts.onUnavailable();
  }

  // ---------- 公开接口 ----------
  function init(o) {
    opts = o || {};
    els = {
      view: document.getElementById('starmap-view'),
      stage: document.getElementById('starmap-stage'),
      canvas: document.getElementById('starmap-canvas'),
      fx: document.getElementById('starmap-fx'),
      readout: document.getElementById('starmap-readout'),
      lod: document.getElementById('starmap-lod'),
      legend: document.getElementById('starmap-legend'),
      scale: document.getElementById('starmap-scale'),
      tip: document.getElementById('starmap-tip'),
      zoomIn: document.getElementById('starmap-zoom-in'),
      zoomOut: document.getElementById('starmap-zoom-out'),
      fitBtn: document.getElementById('starmap-fit'),
    };
    if (!els.canvas || !els.fx) return false;
    try {
      ctx = window.__atlasForceNoCanvas ? null : els.canvas.getContext('2d');
      fctx = ctx ? els.fx.getContext('2d') : null;
    } catch { ctx = null; }
    canDraw = !!(ctx && fctx);
    if (!canDraw) {
      if (!warned) { warned = true; console.warn('[星图] canvas.getContext("2d") 不可用，已切换为列表'); }
      return false;
    }
    readColors();
    bindPointer();
    if (els.zoomIn) els.zoomIn.addEventListener('click', () => zoomAt(W / 2, H / 2, 1.5, true));
    if (els.zoomOut) els.zoomOut.addEventListener('click', () => zoomAt(W / 2, H / 2, 1 / 1.5, true));
    if (els.fitBtn) els.fitBtn.addEventListener('click', () => fit(true));
    if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (visible) resize(); }).observe(els.stage);
    // 主题 / 皮肤切换、系统深浅变化：重新读一次颜色
    new MutationObserver(() => { readColors(); if (opts.onThemeChange) opts.onThemeChange(); })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-skin'] });
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const fn = () => { readColors(); if (opts.onThemeChange) opts.onThemeChange(); };
      if (mq.addEventListener) mq.addEventListener('change', fn); else if (mq.addListener) mq.addListener(fn);
    }
    window.addEventListener('atlas:motion-change', () => { flight = null; if (reduced()) stopFx(); else startFx(); dirtyAll(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopFx(); else { startFx(); markDirty(); } });
    return true;
  }
  function setVisible(v) {
    v = !!v;
    if (v === visible) return;
    visible = v;
    if (v) {
      resize();
      if (!camFitted && n) fit(false);
      dirtyAll();
      startFx();
    } else {
      stopFx();
      setHover(-1);
      closeOurPeek();
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flight = null;
    }
  }
  // 星表聚焦一颗星：相机平移过去（中景以下先放大到近景）并画焦点环
  function focusPath(path) {
    const i = path == null ? -1 : pathIdx.get(path);
    selected = i == null ? -1 : i;
    if (selected >= 0 && visible) {
      const s = cam.s < LOD_NEAR ? 2.2 : cam.s;
      flyTo(X[selected], Y[selected], s, true);
    }
    dirtyAll();
  }
  function clusterIndexOf(name) { return clusters.findIndex((c) => c.name === name); }
  function flyToProject(name) { const i = clusterIndexOf(name); if (i >= 0) flyToCluster(i); }

  // 首页迷你星图：远景路径 + 星团级聚合线，星团名在外缘下方
  function renderThumbnail(canvas, thumbRows) {
    if (!canvas || !canDraw) return false;
    let g;
    try { g = canvas.getContext('2d'); } catch { g = null; }
    if (!g) return false;
    const cw = canvas.clientWidth || 600, ch = canvas.clientHeight || 214;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const list = thumbRows || rows;
    if (!list.length) return true;
    // 与主星图同一套布局（同一数据集直接复用）
    let cl, st;
    if (pathSignature(list) === sig) {
      cl = clusters; st = { x: X, y: Y, cluster: CL };
    } else {
      const byProj = new Map();
      for (const r of list) byProj.set(r.project || '', (byProj.get(r.project || '') || 0) + 1);
      cl = layoutClusters([...byProj].map(([name, count]) => ({ name, count })));
      st = layoutStars(list, cl);
    }
    // 横竖各自取景（fitThumb）：星团中心按 (sx, sy) 映射，星盘 / 星点按 rs 画成圆
    const fit = fitThumb(cl, cw, ch);
    const { rs } = fit;
    const tx = fit.tx, ty = fit.ty;
    // 星点相对所在星团中心按 rs 等比放置，星团整体形状不被拉伸
    const starX = (i) => tx(cl[st.cluster[i]].cx) + (st.x[i] - cl[st.cluster[i]].cx) * rs;
    const starY = (i) => ty(cl[st.cluster[i]].cy) + (st.y[i] - cl[st.cluster[i]].cy) * rs;
    const tnow = Date.now();
    for (const c of cl) {
      const x = tx(c.cx), y = ty(c.cy), r = Math.max(2, c.h * rs);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const a = C.nA * 1.6;
      gr.addColorStop(0, `hsl(240 ${C.nS} ${C.nL} / ${a})`);
      gr.addColorStop(1, `hsl(240 ${C.nS} ${C.nL} / 0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    // 星团级聚合线
    if (linksRaw && cl === clusters) {
      g.strokeStyle = C.linkHl;
      for (const { a, b, n: cnt } of clusterLinks(linkEdges, CL, null, 40)) {
        const p = cl[a], q = cl[b];
        const xa = tx(p.cx), ya = ty(p.cy), xb = tx(q.cx), yb = ty(q.cy);
        const mx = (xa + xb) / 2, my = (ya + yb) / 2, dx = xb - xa, dy = yb - ya, len = Math.hypot(dx, dy) || 1;
        g.globalAlpha = Math.min(0.7, 0.2 + 0.1 * Math.log2(cnt + 1));
        g.lineWidth = Math.min(2.2, 0.6 + 0.4 * Math.log2(cnt + 1));
        g.beginPath(); g.moveTo(xa, ya); g.quadraticCurveTo(mx - dy / len * len * 0.18, my + dx / len * len * 0.18, xb, yb); g.stroke();
      }
      g.globalAlpha = 1;
    }
    const tc = [null, C.s1, C.s2, C.s3, C.s4];
    for (let i = 0; i < list.length; i++) {
      const t = tierOf(list[i].mtime, tnow);
      if (list[i].unread) continue;
      const x = starX(i), y = starY(i);
      g.globalAlpha = t <= 2 ? 0.95 : 0.6;
      g.fillStyle = tc[Math.max(2, t)];
      g.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
    }
    g.globalAlpha = 1;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r.unread) continue;
      const fresh = tnow - (r.mtime || 0) < DAY;
      g.fillStyle = fresh ? C.unread : C.unreadStale;
      g.beginPath(); g.arc(starX(i), starY(i), fresh ? 2.2 : 1.6, 0, Math.PI * 2); g.fill();
    }
    // 星团名：避开所有星团的星盘与已放的名字（placeThumbLabels），放不下就不画
    g.textBaseline = 'top';
    g.font = `500 11px ${C.ui}`;
    const items = cl.map((c, i) => ({
      i, x: tx(c.cx), y: ty(c.cy), r: Math.max(2, c.r * rs), w: g.measureText(c.name).width, h: 13, count: c.count,
    }));
    const placed = placeThumbLabels(items, cw, ch);
    g.fillStyle = C.dim;
    for (const lb of placed) g.fillText(cl[lb.i].name, lb.x, lb.y);
    thumbStats = { clusters: cl.length, labels: placed.length, fit: { sx: fit.sx, sy: fit.sy, rs }, items, placed };
    return true;
  }

  const api = {
    ...pure,
    init,
    setVisible,
    setData,
    retier,
    setFilter,
    setLinks,
    setNote,
    focusPath,
    flyToProject,
    linkCounts,
    renderThumbnail,
    signature: (r) => pathSignature(r),
    canDraw: () => canDraw && !failed,
    fit: () => fit(true),
    debug: {
      get frames() { return frames; },
      get linkCount() { return linkEdges.length / 2; },
      get labels() { return { shown: labelStats.shown, hidden: labelStats.hidden }; },
      get thumb() { return thumbStats; },
      get lod() { return lodOf(cam.s); },
      get cam() { return { x: cam.x, y: cam.y, s: cam.s }; },
      get twinkling() { return twinkles.size; },
      screenPos(path) {
        const i = pathIdx.get(path);
        if (i == null || !els.canvas) return null;
        const r = els.canvas.getBoundingClientRect();
        return { x: r.left + sx(X[i]), y: r.top + sy(Y[i]) };
      },
      hitTest(cx, cy) {
        if (!els.canvas) return null;
        const r = els.canvas.getBoundingClientRect();
        const i = starAt(cx - r.left, cy - r.top);
        return i >= 0 ? rows[i].path : null;
      },
      setCamera(x, y, s) { flyTo(x, y, s, false); },
      clusterCenter(name) {
        const c = clusters[clusterIndexOf(name)];
        return c ? { x: c.cx, y: c.cy, r: c.r, h: c.h } : null;
      },
    },
  };
  root.AtlasStarmap = api;
})(typeof window !== 'undefined' ? window : globalThis);
