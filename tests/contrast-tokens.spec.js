// 令牌对比度护栏（纯 node，不起浏览器）
//
// 防的是"以后有人改一个灰度就悄悄跌破 AA"。做法：从 public/styles.css 读出
// :root{…} 与 :root[data-skin="warm"]{…} 两块里的 --x: light-dark(浅, 深) 声明，
// 合成 冷/暖 × 浅/深 四组合的解析表，按 WCAG 2.x 相对亮度公式逐项断言：
//   - 文字令牌（text / dim / faint / accent / unread / fav / signal / danger）对五种表面 ≥4.5
//   - --unread-stale / --border-input / 四档星色 ≥3.0（承载含义的非文字元素，1.4.11）
//   - --on-accent 对 --accent ≥4.5
//   - var() 引用的令牌（--signal、--fav、--star-pulse …）先解析到被引用值再断言
//   - 合成背景组：--bg-elev 按 --glass-tint 叠在 #fff / #000 上，取较小对比度（毛玻璃面板 / 桌面侧栏）
//   - 英雄区星点组：--hero-stars 里最亮的 alpha × .home-hero::before 的 opacity ≤ .08
//   - 输入框底色组：文本输入框选择器的 background 不得引用 --bg-hover
// 这只覆盖令牌层；完整的 WCAG 合规仍需辅助技术实测与人工评审。
const fs = require('fs');
const path = require('path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '');   // 去注释，免得注释里的示例值被当成声明

let fail = 0, total = 0;
function check(name, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { fail++; console.log(`✗ ${name}\n   期望 ${JSON.stringify(expected)}\n   实际 ${JSON.stringify(actual)}`); }
  else console.log(`✓ ${name}`);
}
function checkMin(name, value, min) {
  total++;
  const ok = Number.isFinite(value) && value >= min;
  if (!ok) { fail++; console.log(`✗ ${name}：${Number.isFinite(value) ? value.toFixed(2) : value} < ${min}`); }
  else console.log(`✓ ${name}：${value.toFixed(2)} ≥ ${min}`);
}

// ---------- 解析 ----------
// 取出某个选择器（精确匹配，如 ':root' / ':root[data-skin="warm"]'）的第一个顶层块体
function blockOf(selector) {
  const re = new RegExp('(^|\\})\\s*' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
  const m = re.exec(CSS);
  if (!m) return null;
  let i = m.index + m[0].length, depth = 1;
  const start = i;
  while (i < CSS.length && depth > 0) {
    if (CSS[i] === '{') depth++;
    else if (CSS[i] === '}') depth--;
    i++;
  }
  return CSS.slice(start, i - 1);
}
function declsOf(body) {
  const out = {};
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}
// 顶层逗号切分（忽略括号内的逗号）
function splitTop(s) {
  const parts = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const rootBody = blockOf(':root');
const warmBody = blockOf(':root[data-skin="warm"]');
check('能找到 :root 令牌块', !!rootBody, true);
check('能找到 :root[data-skin="warm"] 令牌块', !!warmBody, true);
const ROOT = declsOf(rootBody || '');
const WARM = declsOf(warmBody || '');

// 解析某令牌在某组合下的值（返回字符串），light-dark 取对应一侧，var() 递归
function resolve(name, scheme, skin, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  let v = (skin === 'warm' && WARM[name] != null) ? WARM[name] : ROOT[name];
  if (v == null) return null;
  return resolveValue(v, scheme, skin, seen);
}
function resolveValue(v, scheme, skin, seen) {
  v = v.trim();
  let m = /^light-dark\(([\s\S]*)\)$/.exec(v);
  if (m) {
    const [a, b] = splitTop(m[1]);
    return resolveValue(scheme === 'light' ? a : b, scheme, skin, seen);
  }
  m = /^var\(\s*--([\w-]+)\s*\)$/.exec(v);
  if (m) return resolve(m[1], scheme, skin, seen);
  return v;
}
// 颜色字符串 → { r, g, b, a }（只认 #rgb / #rrggbb / rgb[a]()）
function parseColor(s) {
  if (!s) return null;
  s = s.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const [r, g, b] = m[1].split('').map(c => parseInt(c + c, 16));
    return { r, g, b, a: 1 };
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] == null ? 1 : +m[4] };
  return null;
}
function lum({ r, g, b }) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
function over(fg, alpha, bg) {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
    a: 1,
  };
}

const COMBOS = [
  { scheme: 'light', skin: 'cool', label: '冷 · 浅' },
  { scheme: 'dark',  skin: 'cool', label: '冷 · 深' },
  { scheme: 'light', skin: 'warm', label: '暖 · 浅' },
  { scheme: 'dark',  skin: 'warm', label: '暖 · 深' },
];
const SURFACES = ['bg', 'bg-elev', 'bg-elev-2', 'bg-hover', 'bg-active'];
const TEXT_TOKENS = ['text', 'text-dim', 'text-faint', 'accent', 'unread', 'fav', 'signal', 'danger'];
const STALE_SURFACES = ['bg', 'bg-elev', 'bg-hover', 'bg-active'];
const INPUT_SURFACES = ['bg-elev', 'bg-elev-2'];
const STAR_TOKENS = ['star-1', 'star-2', 'star-3', 'star-4'];

function color(name, c) {
  const v = resolve(name, c.scheme, c.skin);
  const col = parseColor(v);
  if (!col) { fail++; total++; console.log(`✗ ${c.label} --${name} 无法解析为颜色：${v}`); }
  return col;
}

// ---------- 映射令牌 ----------
check('--signal 映射到强调色', ROOT['signal'], 'var(--accent)');
check('--fav 映射到 --text-dim', ROOT['fav'], 'var(--text-dim)');
check('--constellation-line 已删除', ROOT['constellation-line'], undefined);
for (const c of COMBOS) {
  check(`${c.label}：--unread 与 --accent 同值（未读 = 品牌强调色）`,
    resolve('unread', c.scheme, c.skin), resolve('accent', c.scheme, c.skin));
}

// ---------- 实底组 ----------
for (const c of COMBOS) {
  for (const fgName of TEXT_TOKENS) {
    const fg = color(fgName, c);
    if (!fg) continue;
    let min = Infinity, worst = '';
    for (const s of SURFACES) {
      const bg = color(s, c);
      if (!bg) continue;
      const r = contrast(fg, bg);
      if (r < min) { min = r; worst = s; }
    }
    checkMin(`${c.label}：--${fgName} 对五种表面（最差 --${worst}）`, min, 4.5);
  }
  for (const [fgName, surfaces] of [['unread-stale', STALE_SURFACES], ['border-input', INPUT_SURFACES]]) {
    const fg = color(fgName, c);
    if (!fg) continue;
    let min = Infinity, worst = '';
    for (const s of surfaces) {
      const bg = color(s, c);
      if (!bg) continue;
      const r = contrast(fg, bg);
      if (r < min) { min = r; worst = s; }
    }
    checkMin(`${c.label}：--${fgName} 对 ${surfaces.map(s => '--' + s).join(' / ')}（最差 --${worst}）`, min, 3.0);
  }
  const bg = color('bg', c);
  for (const st of STAR_TOKENS) {
    const fg = color(st, c);
    if (fg && bg) checkMin(`${c.label}：--${st} 对 --bg`, contrast(fg, bg), 3.0);
  }
  const onAccent = color('on-accent', c), accent = color('accent', c);
  if (onAccent && accent) checkMin(`${c.label}：--on-accent 对 --accent`, contrast(onAccent, accent), 4.5);
}

// ---------- 合成背景组（--glass-tint） ----------
const tintDecl = ROOT['glass-tint'];
const tintM = /^([\d.]+)%$/.exec(tintDecl || '');
check('--glass-tint 是百分比声明', !!tintM, true);
const alpha = tintM ? +tintM[1] / 100 : NaN;
const WHITE = { r: 255, g: 255, b: 255, a: 1 }, BLACK = { r: 0, g: 0, b: 0, a: 1 };
if (Number.isFinite(alpha)) {
  for (const c of COMBOS) {
    const elev = color('bg-elev', c);
    if (!elev) continue;
    const surfaces = [over(elev, alpha, WHITE), over(elev, alpha, BLACK)];
    const minOver = (fg) => Math.min(...surfaces.map(s => contrast(fg, s)));
    for (const fgName of TEXT_TOKENS) {
      const fg = color(fgName, c);
      if (fg) checkMin(`${c.label}：--${fgName} 对 ${Math.round(alpha * 100)}% 毛玻璃面（叠白 / 叠黑取小）`, minOver(fg), 4.5);
    }
    for (const fgName of ['unread-stale', 'border-input']) {
      const fg = color(fgName, c);
      if (fg) checkMin(`${c.label}：--${fgName} 对 ${Math.round(alpha * 100)}% 毛玻璃面（叠白 / 叠黑取小）`, minOver(fg), 3.0);
    }
  }
}

// ---------- 桌面版侧栏着色组（--sidebar-tint-light / -dark） ----------
// 侧栏叠在 macOS 原生 vibrancy 材质上，材质不是纯白 / 纯黑。实测（macOS 26，sidebar 材质，
// 背后分别放纯黑 / 纯白 / 纯红 / 纯蓝窗口，见 .agents/tasks/ui-starmap/client-fix/verification.md §3）：
//   浅色材质每通道 201–227，深色材质 38–84。这里各放宽一段余量取区间端点，叠上着色层后取最差对比度
const MATERIAL = {
  light: [{ r: 195, g: 195, b: 195, a: 1 }, WHITE],
  dark: [BLACK, { r: 88, g: 88, b: 88, a: 1 }],
};
// 桌面侧栏块里对前景令牌的 var() 重映射（如 --text-faint: var(--text-dim)）先代入再算
const SB = declsOf(blockOf('html[data-desktop="darwin"] .sidebar') || '');
check('找到桌面侧栏块并重映射 --text-faint', /^var\(--[\w-]+\)$/.test(SB['text-faint'] || ''), true);
const sbColor = (name, c) => {
  const m = /^var\(\s*--([\w-]+)\s*\)$/.exec(SB[name] || '');
  return color(m ? m[1] : name, c);
};
for (const scheme of ['light', 'dark']) {
  const decl = ROOT['sidebar-tint-' + scheme];
  const m = /^([\d.]+)%$/.exec(decl || '');
  check(`--sidebar-tint-${scheme} 是百分比声明`, !!m, true);
  if (!m) continue;
  const a = +m[1] / 100;
  check(`--sidebar-tint-${scheme} ≤ 70%（材质要透得出来）`, a <= 0.7, true);
  for (const c of COMBOS.filter(x => x.scheme === scheme)) {
    const elev = color('bg-elev', c);
    if (!elev) continue;
    const surfaces = MATERIAL[scheme].map(mat => over(elev, a, mat));
    const minOver = (fg) => Math.min(...surfaces.map(s => contrast(fg, s)));
    for (const fgName of TEXT_TOKENS) {
      const fg = sbColor(fgName, c);
      if (fg) checkMin(`${c.label}：--${fgName} 对 ${Math.round(a * 100)}% 桌面侧栏（材质区间两端取小）`, minOver(fg), 4.5);
    }
    for (const fgName of ['unread-stale', 'border-input']) {
      const fg = sbColor(fgName, c);
      if (fg) checkMin(`${c.label}：--${fgName} 对 ${Math.round(a * 100)}% 桌面侧栏（材质区间两端取小）`, minOver(fg), 3.0);
    }
  }
}

// ---------- 英雄区星点组 ----------
// 所有 --hero-stars 声明（浅色点阵 / 深色星点，三处覆盖各一份）里的每个 rgba alpha
const heroDecls = [...CSS.matchAll(/--hero-stars\s*:\s*([^;]+);/g)].map(m => m[1]);
check('找到 --hero-stars 声明（浅 / 深 / 跟随系统三处）', heroDecls.length >= 3, true);
const heroAlphas = heroDecls.flatMap(d => [...d.matchAll(/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/g)].map(m => +m[1]));
const maxStar = heroAlphas.length ? Math.max(...heroAlphas) : NaN;
const beforeBody = blockOf('.home-hero::before') || '';
const opM = /(?:^|;|\s)opacity\s*:\s*([\d.]+)/.exec(beforeBody);
check('.home-hero::before 声明了统一不透明度', !!opM, true);
check('.home-hero::before 的背景取自 --hero-stars', /background\s*:\s*var\(--hero-stars\)/.test(beforeBody), true);
const heroOpacity = opM ? +opM[1] : NaN;
total++;
const effective = maxStar * heroOpacity;
if (!(effective <= 0.08 + 1e-9)) { fail++; console.log(`✗ 英雄区最亮星点有效 alpha ${maxStar} × ${heroOpacity} = ${effective} > .08`); }
else console.log(`✓ 英雄区最亮星点有效 alpha ${maxStar} × ${heroOpacity} = ${effective.toFixed(3)} ≤ .08`);

// ---------- 输入框底色组 ----------
// 文本输入框的背景只能是 --bg-elev / --bg-elev-2（或毛玻璃面）：--border-input 对 --bg-hover 余量太小
const INPUT_SELECTORS = ['#search', '.filter input[type="search"]', '#quickopen-input', '#find-input',
  '.find-bar input', '.dialog-input', '#root-input', '.modal-section input', '.dir-current', '.share-options select'];
const offenders = [];
let inputRules = 0;
for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selectors = m[1].split(',').map(s => s.trim());
  if (!selectors.some(sel => INPUT_SELECTORS.some(t => sel.includes(t)))) continue;
  inputRules++;
  for (const d of m[2].matchAll(/background(?:-color)?\s*:\s*([^;]+)/g)) {
    if (/--bg-hover/.test(d[1])) offenders.push(m[1].trim());
  }
}
check('找到文本输入框的样式规则', inputRules > 0, true);
check('文本输入框背景不引用 --bg-hover', offenders, []);
// --border-input 真的接到了输入框上
for (const sel of ['.filter input[type="search"] {', '.modal-section input[type="text"] {', '.dialog-input {']) {
  const i = CSS.indexOf(sel);
  const body = i >= 0 ? CSS.slice(i, CSS.indexOf('}', i)) : '';
  check(`${sel.replace(' {', '')} 的边框用 --border-input`, /border\s*:[^;]*var\(--border-input\)/.test(body), true);
}

console.log(`\n总计 ${total} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
