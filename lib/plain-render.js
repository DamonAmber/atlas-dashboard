// CSV / JSON / 纯文本 / SVG 的只读预览页渲染。
//
// 这四种格式和 Markdown 走同一套视觉：直接复用 markdown.js 导出的 pageCss 与
// markdownCss，表格因此自动获得那套 data table 排版（表头对齐、斑马纹、
// 数字按位对齐、宽表横向滚动提示），不需要再写一遍。
//
// 安全基线：所有内容都经 escapeHtml 之后才进 HTML，不透传任何原始标记。
// SVG 是唯一的例外情况——它本身就是标记，所以不内联，而是用 <img> 引用
// /raw/ 地址：浏览器加载 <img> 里的 SVG 时不执行其中的脚本，
// 这条路径天然安全，也就不需要沙箱。
const markdown = require('../public/vendor/markdown.js');

const escapeHtml = markdown.escapeHtml;

// 单篇预览的上限。超过就截断显示——把 20 万行 CSV 塞进 DOM 只会让标签页卡死，
// 而 Atlas 的定位是"看 AI 刚生成了什么"，不是数据分析工具。
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_CSV_ROWS = 5000;
const MAX_TEXT_LINES = 20000;

// ---------- CSV / TSV ----------

// 分隔符嗅探。.tsv 直接用 tab；.csv 也可能是分号（欧洲区域设置导出的就是），
// 按首行里各候选符号的出现次数挑最多的那个。
function sniffDelimiter(text, ext) {
  if (ext === '.tsv') return '\t';
  const firstLine = String(text).split(/\r?\n/, 1)[0] || '';
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    // 只数引号外面的：`"a,b";c` 里那个逗号不是分隔符
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i++) {
      const ch = firstLine[i];
      if (ch === '"') inQuotes = !inQuotes;
      else if (!inQuotes && ch === d) count++;
    }
    if (count > bestCount) { best = d; bestCount = count; }
  }
  return best;
}

/**
 * RFC 4180 的 CSV 解析：引号包裹、字段内含分隔符 / 换行、`""` 转义都要处理对。
 * 用手写状态机而不是 split——AI 导出的表格里带引号的长备注非常常见，
 * 按 split 切会把一行拆成好几行，整张表从某一行开始全部错位。
 *
 * @returns {{rows: string[][], truncated: boolean, totalRows: number}}
 */
function parseCsv(text, delimiter, maxRows = MAX_CSV_ROWS) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let truncated = false;
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    // 完全空的行（只有一个空字段）不收：文件末尾的换行会造出一个这样的行
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }   // "" → 一个字面量引号
        else inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\r') {
      if (s[i + 1] === '\n') i++;
      endRow();
      if (rows.length >= maxRows) { truncated = true; break; }
      continue;
    }
    if (ch === '\n') {
      endRow();
      if (rows.length >= maxRows) { truncated = true; break; }
      continue;
    }
    field += ch;
  }
  // 最后一行没有换行结尾时收尾
  if (!truncated && (field !== '' || row.length > 0)) endRow();

  // 截断时估算总行数，好在提示里说清楚"还有多少没显示"
  let totalRows = rows.length;
  if (truncated) {
    let nl = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === '\n') nl++;
    totalRows = Math.max(rows.length, nl);
  }
  return { rows, truncated, totalRows };
}

// 这一列是不是数字列（用来决定右对齐）。允许千分位、货币符号、百分号、正负号。
// 判断按整列来：一列里混着 "128,304" 和 "新机型首发" 时不该右对齐。
const NUMERIC_RE = /^[-+]?[¥$€£]?\s*\d[\d,\s]*(?:\.\d+)?\s*%?$/;
function columnAligns(rows, colCount) {
  const aligns = new Array(colCount).fill('');
  for (let c = 0; c < colCount; c++) {
    let numeric = 0;
    let filled = 0;
    // 跳过表头行
    for (let r = 1; r < rows.length; r++) {
      const v = (rows[r][c] || '').trim();
      if (!v) continue;
      filled++;
      if (NUMERIC_RE.test(v)) numeric++;
    }
    // 有内容的单元格里九成以上是数字才算数字列
    if (filled >= 1 && numeric / filled >= 0.9) aligns[c] = 'right';
  }
  return aligns;
}

function csvBodyHtml(text, ext) {
  const delimiter = sniffDelimiter(text, ext);
  const { rows, truncated, totalRows } = parseCsv(text, delimiter);
  if (!rows.length) {
    return '<p class="plain-empty">这个文件是空的。</p>';
  }
  const colCount = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const aligns = columnAligns(rows, colCount);
  const alignAttr = (c) => (aligns[c] ? ' style="text-align:' + aligns[c] + '"' : '');

  const header = rows[0];
  const thead = '<thead><tr>' + Array.from({ length: colCount }, (_, c) =>
    '<th' + alignAttr(c) + '>' + escapeHtml(header[c] == null ? '' : header[c]) + '</th>').join('')
    + '</tr></thead>';
  const tbody = '<tbody>' + rows.slice(1).map(r =>
    '<tr>' + Array.from({ length: colCount }, (_, c) =>
      '<td' + alignAttr(c) + '>' + escapeHtml(r[c] == null ? '' : r[c]) + '</td>').join('')
    + '</tr>').join('') + '</tbody>';

  const delimLabel = delimiter === '\t' ? 'Tab' : delimiter;
  const meta = '<div class="plain-meta">'
    + escapeHtml(String(rows.length - 1)) + ' 行 · ' + colCount + ' 列 · 分隔符 '
    + '<code>' + escapeHtml(delimLabel) + '</code>'
    + '</div>';
  const note = truncated
    ? '<div class="plain-note">只显示了前 ' + MAX_CSV_ROWS + ' 行（全文约 '
      + escapeHtml(String(totalRows)) + ' 行）。需要看全部内容请用表格软件打开原文件。</div>'
    : '';
  return meta + note + '<table>' + thead + tbody + '</table>';
}

// ---------- JSON ----------

// 重新序列化成缩进 2 格的形式并逐 token 上色。
// 不用正则去染色原文：原文的缩进可能是压缩过的一整行，那样看不出结构。
// 走 JSON.parse → 自己递归输出，顺便把结构规整了。
function jsonValueHtml(value, indent) {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);
  if (value === null) return '<span class="j-null">null</span>';
  const t = typeof value;
  if (t === 'boolean') return '<span class="j-bool">' + value + '</span>';
  if (t === 'number') return '<span class="j-num">' + escapeHtml(String(value)) + '</span>';
  if (t === 'string') return '<span class="j-str">"' + escapeHtml(value) + '"</span>';
  if (Array.isArray(value)) {
    if (!value.length) return '<span class="j-punct">[]</span>';
    const items = value.map(v => padInner + jsonValueHtml(v, indent + 1));
    return '<span class="j-punct">[</span>\n' + items.join('<span class="j-punct">,</span>\n')
      + '\n' + pad + '<span class="j-punct">]</span>';
  }
  if (t === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '<span class="j-punct">{}</span>';
    const items = keys.map(k =>
      padInner + '<span class="j-key">"' + escapeHtml(k) + '"</span><span class="j-punct">: </span>'
      + jsonValueHtml(value[k], indent + 1));
    return '<span class="j-punct">{</span>\n' + items.join('<span class="j-punct">,</span>\n')
      + '\n' + pad + '<span class="j-punct">}</span>';
  }
  return escapeHtml(String(value));
}

// 从 JSON.parse 的报错里定位出错的行列。
//
// 报错文本的形态随 V8 版本变过好几轮：老版本只给字符偏移（"at position 1234"，
// 对着 3000 行的文件毫无用处），新版本有时直接带 "(line 12 column 5)"，
// 短输入还可能两样都没有。三种都处理，实在拿不到就不提行列
// ——宁可少说一句，也不要印一个"位置未知"的废话。
function jsonErrorLocation(text, err) {
  const msg = String(err && err.message || '');
  const at = (pos) => {
    const p = Math.max(0, Math.min(pos, text.length));
    const before = text.slice(0, p);
    return { line: before.split('\n').length, col: p - (before.lastIndexOf('\n') + 1) + 1 };
  };
  // ① 有些版本直接给行列
  const lc = /line\s+(\d+)\s+column\s+(\d+)/i.exec(msg);
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) };
  // ② 经典形态：字符偏移
  const p = /position\s+(\d+)/i.exec(msg);
  if (p) return at(Number(p[1]));
  // ③ Node 22+ / V8 新格式两样都不给，只在消息里嵌一段原文上下文：
  //      Unexpected token ',', ..."c": [1,2,, ]\n}" is not valid JSON
  //    把那段片段拿回原文里定位。片段自带引号和换行，所以贪婪捕获到
  //    结尾那句固定文案之前为止。
  const snip = /"([\s\S]{3,})"\s+is not valid JSON\s*$/.exec(msg);
  if (snip) {
    const idx = text.indexOf(snip[1]);
    // 片段在原文里必须唯一，否则可能指到别处去——宁可不报位置
    if (idx >= 0 && text.indexOf(snip[1], idx + 1) === -1) return at(idx);
  }
  return null;
}

function jsonBodyHtml(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const loc = jsonErrorLocation(text, err);
    const where = loc ? `（第 ${loc.line} 行第 ${loc.col} 列）` : '';
    return '<div class="plain-note plain-note-error">这不是合法的 JSON' + escapeHtml(where) + '：'
      + escapeHtml(String(err && err.message || err)) + '<br />下面按纯文本显示原文。</div>'
      + '<pre class="plain-pre">' + escapeHtml(text) + '</pre>';
  }
  const kind = Array.isArray(parsed) ? `数组 · ${parsed.length} 项`
    : (parsed && typeof parsed === 'object') ? `对象 · ${Object.keys(parsed).length} 个键`
      : typeof parsed;
  return '<div class="plain-meta">' + escapeHtml(kind) + '</div>'
    + '<pre class="plain-pre plain-json">' + jsonValueHtml(parsed, 0) + '</pre>';
}

// ---------- 纯文本 ----------

function textBodyHtml(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  const truncated = lines.length > MAX_TEXT_LINES;
  const shown = truncated ? lines.slice(0, MAX_TEXT_LINES) : lines;
  const meta = '<div class="plain-meta">' + lines.length + ' 行</div>';
  const note = truncated
    ? '<div class="plain-note">只显示了前 ' + MAX_TEXT_LINES + ' 行。</div>'
    : '';
  return meta + note + '<pre class="plain-pre">' + escapeHtml(shown.join('\n')) + '</pre>';
}

// ---------- SVG ----------

// 用 <img> 而不是内联：<img> 里的 SVG 不执行脚本、不加载外部引用，
// 是浏览器提供的现成隔离。代价是 SVG 里的 CSS 动画仍然能跑（无害），
// 而 <use href="外部文件"> 之类会失效（这在 AI 产出的图里几乎不会出现）。
function svgBodyHtml(rawUrl, sizeText) {
  const src = escapeHtml(rawUrl || '');
  return '<div class="plain-meta">SVG 图形' + (sizeText ? ' · ' + escapeHtml(sizeText) : '') + '</div>'
    + '<div class="plain-svg-stage"><img src="' + src + '" alt="SVG 预览" /></div>'
    + '<div class="plain-note">以图片方式加载：SVG 里的脚本不会执行。'
    + '需要看源码请用「在访达中显示」打开原文件。</div>';
}

// ---------- 页面外壳 ----------

const plainCss = [
  '.plain-wrap{max-width:1180px;margin:0 auto;padding:34px 30px 60px;}',
  // 数据表格要尽量宽，正文类（txt/json）保持易读的行宽
  '.plain-wrap.plain-narrow{max-width:860px;}',
  '.plain-title{margin:0 0 14px;font:600 17px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;',
  'color:var(--md-fg);word-break:break-all;}',
  '.plain-meta{margin:0 0 14px;font-size:12px;color:var(--md-fg-faint);}',
  '.plain-meta code{background:var(--md-code-bg);border-radius:4px;padding:.1em .35em;font-size:.95em;}',
  '.plain-note{margin:12px 0 0;padding:9px 12px;border-radius:8px;font-size:12.5px;line-height:1.6;',
  'color:var(--md-fg-muted);background:var(--md-fm-bg);border:1px solid var(--md-fm-border);}',
  '.plain-note-error{color:var(--md-alert-caution);',
  'background:color-mix(in srgb,var(--md-alert-caution) 8%,transparent);',
  'border-color:color-mix(in srgb,var(--md-alert-caution) 30%,var(--md-fm-border));margin:0 0 14px;}',
  '.plain-empty{color:var(--md-fg-faint);font-size:13px;}',
  // 纯文本 / JSON：等宽 + 保留空白，长行软换行（不然一行 5000 字符的日志要横着拉）
  '.plain-pre{margin:0;padding:16px 18px;border:1px solid var(--md-border);border-radius:8px;',
  'background:var(--md-pre-bg);overflow-x:auto;font:12.5px/1.65 ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;',
  'white-space:pre-wrap;word-break:break-word;color:var(--md-fg);}',
  // JSON 语法配色：跟 alert 用同一组语义色，深浅主题自动切换
  '.plain-json .j-key{color:var(--md-alert-note);}',
  '.plain-json .j-str{color:var(--md-alert-tip);}',
  '.plain-json .j-num{color:var(--md-alert-important);}',
  '.plain-json .j-bool{color:var(--md-alert-warning);}',
  '.plain-json .j-null{color:var(--md-fg-faint);}',
  '.plain-json .j-punct{color:var(--md-fg-faint);}',
  // SVG 舞台：棋盘底纹，透明背景的图形才看得清边界
  '.plain-svg-stage{display:flex;align-items:center;justify-content:center;padding:24px;',
  'border:1px solid var(--md-border);border-radius:8px;background-color:var(--md-pre-bg);',
  'background-image:linear-gradient(45deg,var(--md-table-alt) 25%,transparent 25%,transparent 75%,var(--md-table-alt) 75%),',
  'linear-gradient(45deg,var(--md-table-alt) 25%,transparent 25%,transparent 75%,var(--md-table-alt) 75%);',
  'background-size:18px 18px;background-position:0 0,9px 9px;}',
  '.plain-svg-stage img{max-width:100%;max-height:70vh;}',
  '@media print{',
  '.plain-wrap{max-width:none;padding:0;}',
  '.plain-pre{white-space:pre-wrap;word-break:break-word;}',
  '.plain-note{display:none;}',
  '}',
].join('\n');

const KIND_LABEL = { csv: 'CSV', json: 'JSON', txt: '文本', svg: 'SVG' };

/**
 * 渲染一份完整的预览页。
 *
 * @param {object} opts
 * @param {'csv'|'json'|'txt'|'svg'} opts.kind
 * @param {string} [opts.text]     文件内容（svg 不需要）
 * @param {string} opts.title      文件名
 * @param {string} [opts.ext]      扩展名（.csv / .tsv，用于分隔符嗅探）
 * @param {string} [opts.rawUrl]   svg 的 /raw/ 地址
 * @param {string} [opts.sizeText] svg 的尺寸描述
 * @param {'light'|'dark'} [opts.theme] 钉死主题（跟 Markdown 预览页一致）
 * @param {boolean} [opts.forPrint] 打印版（配色钉浅色、去掉交互提示）
 */
function renderPage(opts = {}) {
  const kind = opts.kind;
  const title = escapeHtml(opts.title || KIND_LABEL[kind] || '预览');
  let body;
  if (kind === 'csv') body = csvBodyHtml(opts.text || '', opts.ext || '.csv');
  else if (kind === 'json') body = jsonBodyHtml(opts.text || '');
  else if (kind === 'svg') body = svgBodyHtml(opts.rawUrl, opts.sizeText);
  else body = textBodyHtml(opts.text || '');

  // CSV 用宽版（十几列的表要摊开），其余用易读行宽
  const narrow = kind !== 'csv' ? ' plain-narrow' : '';

  if (opts.forPrint) {
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8" />'
      + '<meta name="color-scheme" content="light" />'
      + '<title>' + title + '</title>'
      + '<style>' + markdown.markdownCss + markdown.printCss + plainCss + '</style></head>'
      + '<body class="md-body"><div class="plain-wrap' + narrow + '">'
      + '<h1 class="plain-title">' + title + '</h1>' + body
      + '</div></body></html>';
  }

  const forced = markdown.forcedThemeCss(opts.theme);
  const schemeMeta = (opts.theme === 'light' || opts.theme === 'dark') ? opts.theme : 'light dark';
  return '<!doctype html><html lang="zh"><head><meta charset="utf-8" />'
    + '<meta name="viewport" content="width=device-width,initial-scale=1" />'
    + '<meta name="color-scheme" content="' + schemeMeta + '" />'
    + '<title>' + title + '</title>'
    + '<style>' + markdown.pageCss + markdown.markdownCss + plainCss + forced + '</style></head>'
    + '<body class="md-body"><div class="plain-wrap' + narrow + '">'
    + '<h1 class="plain-title">' + title + '</h1>' + body
    + '</div>'
    // 表格的横向滚动提示复用 Markdown 预览页那套（宽表右缘的渐变遮罩）
    + '<script>' + markdown.tableOverflowScript + '</script>'
    + '</body></html>';
}

// 把内容抽成可搜索的纯文本。全文搜索要用：CSV 直接给原文，
// JSON 也给原文（键名同样值得被搜到），SVG 只取 <text> 与标题里的文字。
function toSearchText(kind, text) {
  const s = String(text == null ? '' : text);
  if (kind === 'svg') {
    const out = [];
    const re = /<(?:text|title|desc)\b[^>]*>([\s\S]*?)<\/(?:text|title|desc)>/gi;
    let m;
    while ((m = re.exec(s)) !== null) out.push(m[1].replace(/<[^>]*>/g, ' '));
    return out.join(' ');
  }
  return s;
}

module.exports = {
  renderPage,
  parseCsv,
  sniffDelimiter,
  toSearchText,
  plainCss,
  MAX_BYTES,
  MAX_CSV_ROWS,
  MAX_TEXT_LINES,
};
