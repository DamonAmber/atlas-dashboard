// Atlas 内置 Markdown 渲染器（零依赖，UMD）
// 同一份代码同时给：
//   - 服务端 server.js（require('./public/vendor/markdown.js')）——渲染只读预览页
//   - 浏览器 app.js（<script src="/vendor/markdown.js">）——编辑时的实时预览
// 支持子集：标题 / 粗斜体 / 行内代码 / 围栏代码块 / 链接 / 图片 / 有序无序（可嵌套）列表 /
//          引用 / 分割线 / GFM 表格 / 删除线 / 自动链接。
// 安全：所有文本先做 HTML 转义，只输出已知安全标签，不透传原始 HTML（防 XSS）。
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  if (root) root.AtlasMarkdown = mod;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : this), function () {
  'use strict';

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Markdown URL 白名单：相对路径 / 锚点默认允许；显式 scheme 只开放常见安全协议。
  // 图片额外允许常见位图 data URL，但拒绝 SVG 与任意可执行 / 主动内容协议。
  function safeUrl(url, forImage) {
    var value = String(url == null ? '' : url).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    var match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
    if (!match) return value;
    var scheme = match[1].toLowerCase();
    if (scheme === 'http' || scheme === 'https') return value;
    if (!forImage && (scheme === 'mailto' || scheme === 'tel')) return value;
    if (forImage && /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(value)) return value;
    return '#';
  }

  // ---------- YAML front matter ----------
  // AI 生成的 md 几乎默认带 front matter。不识别的话它会被当成
  // 「分割线 + 段落 + 分割线」，渲染成 `title: xxx author: yyy` 这种乱码。
  // 这里把它抽出来单独渲染成一个安静的元信息块，并用 data-md-raw 记住原始
  // 源码——所见即所得编辑反解析时原样吐回，不会被序列化破坏。
  function splitFrontMatter(src) {
    var s = String(src == null ? '' : src).replace(/^\uFEFF/, '');
    var m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
    if (!m) return { meta: null, raw: '', body: s };
    return { meta: m[1], raw: m[0], body: s.slice(m[0].length) };
  }

  // front matter 在源码里占的行数（raw 结尾通常带一个换行，先剥掉再数）
  function frontMatterLineCount(raw) {
    if (!raw) return 0;
    return String(raw).replace(/\n$/, '').split('\n').length;
  }

  function frontMatterHtml(meta, raw) {
    var rows = [];
    meta.split(/\r?\n/).forEach(function (line) {
      if (!line.trim()) return;
      var mm = /^([A-Za-z0-9_.$-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
      if (mm) rows.push({ k: mm[1], v: mm[2] });
      else rows.push({ k: '', v: line.trim() });
    });
    if (!rows.length) return '';
    var items = rows.map(function (r) {
      return '<div class="md-fm-row">'
        + (r.k ? '<span class="md-fm-key">' + escapeHtml(r.k) + '</span>' : '')
        + '<span class="md-fm-val">' + escapeHtml(r.v) + '</span></div>';
    }).join('');
    var span = frontMatterLineCount(raw);
    return '<div class="md-frontmatter" data-md-raw="' + escapeHtml(raw) + '"'
      + ' data-md-line="1" data-md-endline="' + span + '">'
      + '<div class="md-fm-label">文档信息</div>' + items + '</div>';
  }

  function indentOf(line) {
    var m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }
  function isBlank(s) { return /^\s*$/.test(s); }
  function isMarker(line) { return /^\s*([-*+]|\d+[.)])\s+/.test(line); }
  function isOrdered(line) { return /^\s*\d+[.)]\s+/.test(line); }

  function isSeparatorRow(line) {
    return typeof line === 'string' &&
      /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/.test(line);
  }

  function isBlockStart(line, next) {
    if (line == null) return false;
    return /^\s*(```+|~~~+)/.test(line)
      || /^#{1,6}\s+/.test(line)
      || /^\s*>/.test(line)
      || isMarker(line)
      || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line)
      || (line.indexOf('|') >= 0 && isSeparatorRow(next));
  }

  // ---------- 行内渲染 ----------
  function inline(text) {
    // 1) 先保护行内代码 `code`，避免其内部的 * _ [ ] 被当成标记
    var codes = [];
    text = String(text == null ? '' : text).replace(/`([^`]+?)`/g, function (m, code) {
      codes.push('<code>' + escapeHtml(code) + '</code>');
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });

    // 2) 转义（此后 < > & " ' 已安全；* _ ` [ ] ( ) 保留用于标记匹配）
    text = escapeHtml(text);

    // 3) 图片 ![alt](url "title")
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;([^)]*?)&quot;)?\)/g,
      function (m, alt, url, title) {
        var t = title ? ' title="' + title + '"' : '';
        return '<img src="' + safeUrl(url, true) + '" alt="' + alt + '"' + t + ' />';
      });

    // 4) 链接 [text](url "title")
    // 纯锚点链接（#section）不能加 target="_blank"——否则文档里手写的目录
    // 每点一下都新开一个标签页，而不是在当前文档内跳转。
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^)]*?)&quot;)?\)/g,
      function (m, label, url, title) {
        var t = title ? ' title="' + title + '"' : '';
        var href = safeUrl(url, false);
        var isAnchor = href.charAt(0) === '#';
        var rel = isAnchor ? '' : ' target="_blank" rel="noopener noreferrer"';
        return '<a href="' + href + '"' + t + rel + '>' + label + '</a>';
      });

    // 5) 自动链接 <http...>（转义后为 &lt;http...&gt;）
    text = text.replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, function (m, url) {
      return '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    });

    // 6) 强调
    text = text.replace(/\*\*([^\s*][\s\S]*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^\s_][\s\S]*?)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*])\*([^\s*][\s\S]*?)\*/g, '$1<em>$2</em>');
    text = text.replace(/(^|[^\w_])_([^\s_][\s\S]*?)_/g, '$1<em>$2</em>');
    text = text.replace(/~~([\s\S]+?)~~/g, '<del>$1</del>');

    // 7) 还原行内代码
    text = text.replace(/\u0000C(\d+)\u0000/g, function (m, i) { return codes[+i]; });
    return text;
  }

  // ---------- 表格 ----------
  function splitRow(line) {
    var s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
    return s.split('|');
  }
  function alignAttr(a) { return a ? ' style="text-align:' + a + '"' : ''; }

  // ---------- 列表（支持缩进嵌套）----------
  function parseList(lines, start) {
    var i = start, n = lines.length;
    var baseIndent = indentOf(lines[i]);
    var ordered = isOrdered(lines[i]);
    var items = [];
    var hasTask = false;

    while (i < n) {
      if (isBlank(lines[i])) {
        var j = i + 1;
        while (j < n && isBlank(lines[j])) j++;
        // 同级续行仅当标记类型一致（有序/无序）——否则应另起一个列表
        if (j < n && indentOf(lines[j]) === baseIndent && isMarker(lines[j]) &&
            isOrdered(lines[j]) === ordered) { i = j; continue; }
        if (j < n && indentOf(lines[j]) > baseIndent) { i++; continue; }
        break;
      }
      var ind = indentOf(lines[i]);
      if (ind !== baseIndent || !isMarker(lines[i]) || isOrdered(lines[i]) !== ordered) break;

      var m = lines[i].match(/^\s*([-*+]|\d+[.)])\s+([\s\S]*)$/);
      var head = m[2];
      i++;

      // 收集比 baseIndent 更深缩进的续行 / 嵌套块
      var nested = [];
      while (i < n) {
        if (isBlank(lines[i])) {
          var k = i + 1;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && indentOf(lines[k]) > baseIndent) { nested.push(''); i++; continue; }
          break;
        }
        if (indentOf(lines[i]) > baseIndent) { nested.push(lines[i]); i++; }
        else break;
      }

      // GFM 任务列表：`- [ ] 待办` / `- [x] 已完成` → 真的复选框
      // （只读展示，disabled；要改状态在源码里改，避免给出"点了会保存"的错觉）
      var itemHtml;
      var liClass = '';
      var task = /^\[([ xX])\][ \t]+([\s\S]*)$/.exec(head.trim());
      if (task) {
        hasTask = true;
        var checked = task[1].toLowerCase() === 'x';
        liClass = ' class="md-task-item' + (checked ? ' md-task-done' : '') + '"';
        itemHtml = '<input type="checkbox" class="md-task" disabled'
          + (checked ? ' checked' : '') + ' /><span>' + inline(task[2]) + '</span>';
      } else {
        itemHtml = inline(head.trim());
      }
      if (nested.length) {
        var strip = new RegExp('^\\s{0,' + (baseIndent + 2) + '}');
        var dedented = nested.map(function (l) { return l === '' ? '' : l.replace(strip, ''); });
        itemHtml += '\n' + render(dedented.join('\n'));
      }
      items.push('<li' + liClass + '>' + itemHtml + '</li>');
    }

    var tag = ordered ? 'ol' : 'ul';
    var listClass = (hasTask && !ordered) ? ' class="md-task-list"' : '';
    return { html: '<' + tag + listClass + '>' + items.join('') + '</' + tag + '>', next: i };
  }

  // 给一个块的 HTML 的最外层标签塞上 data-md-raw="原始 Markdown 源码"。
  // 用途：所见即所得编辑保存时，只有被用户真正改过的块才重新序列化，
  // 其余块原样吐回源码——这样表格对齐、段落软换行、脚注等本渲染器
  // 无法完整往返的语法都不会被"改一个字"波及。
  // gap = 本块之前的空行数。也一起记下来，回写时按原样还原块间距——
  // 否则 `## 标题` 紧跟正文（无空行）这种写法每次保存都会被塞进一个空行，
  // 对 git 版本化的文档就是无意义的 diff。
  //
  // line / endLine（1 基，闭区间）= 本块在源码里占的行范围。编辑器靠它做
  // 「左边光标在哪 → 右边高亮哪一块」的双向映射。
  function withRaw(html, raw, gap, line, endLine) {
    if (!raw) return html;
    var attr = ' data-md-raw="' + escapeHtml(raw) + '"'
      + (gap == null ? '' : ' data-md-gap="' + gap + '"')
      + (line == null ? '' : ' data-md-line="' + line + '" data-md-endline="' + endLine + '"');
    return html.replace(/^<([a-zA-Z][a-zA-Z0-9]*)(\s|>|\/>)/, function (m, tag, tail) {
      if (tail === '>') return '<' + tag + attr + '>';
      if (tail === '/>') return '<' + tag + attr + ' />';
      return '<' + tag + attr + ' ';
    });
  }

  // ---------- 块级渲染 ----------
  // opts.annotateRaw：给顶层块标注原始源码（只有最外层这一次调用生效，
  // 引用块 / 列表项的递归调用不标注——脏块跟踪的粒度就是顶层块）
  function render(src, opts) {
    src = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var annotate = !!(opts && opts.annotateRaw);
    // lineOffset：本次 render 的输入在整篇源码里的起始偏移。
    // front matter 被 renderBody 剥掉后，正文的行号要整体后移，否则
    // 编辑器算出来的"这一块对应源码第几行"会全部偏掉。
    var lineOffset = (opts && opts.lineOffset) || 0;
    var lines = src.split('\n');
    var out = [];
    var i = 0, n = lines.length;
    var blockStart = 0;
    var prevEnd = 0;      // 上一个块结束后的行号，用来算块之间的空行数
    // 把刚生成的块推入 out，需要时带上原始源码、块间距与源码行范围
    var push = function (html) {
      if (annotate) {
        out.push(withRaw(
          html,
          lines.slice(blockStart, i).join('\n'),
          blockStart - prevEnd,
          blockStart + 1 + lineOffset,   // 1 基起始行
          i + lineOffset,                // 1 基结束行（闭区间）
        ));
      } else {
        out.push(html);
      }
      prevEnd = i;
    };

    while (i < n) {
      var line = lines[i];

      if (isBlank(line)) { i++; continue; }
      blockStart = i;

      // 围栏代码块
      var fence = line.match(/^\s*(```+|~~~+)\s*([^\s`~]*)\s*$/);
      if (fence) {
        var marker = fence[1][0];
        var minlen = fence[1].length;
        var lang = fence[2] || '';
        var buf = [];
        i++;
        while (i < n) {
          var cm = lines[i].match(/^\s*(```+|~~~+)\s*$/);
          if (cm && cm[1][0] === marker && cm[1].length >= minlen) { i++; break; }
          buf.push(lines[i]);
          i++;
        }
        var cls = lang ? ' class="language-' + escapeHtml(lang) + '"' : '';
        push('<pre><code' + cls + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 标题
      var h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var level = h[1].length;
        i++;
        push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
        continue;
      }

      // 分割线
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        i++;
        push('<hr />');
        continue;
      }

      // 引用
      if (/^\s*>/.test(line)) {
        var qbuf = [];
        while (i < n && /^\s*>/.test(lines[i])) {
          qbuf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        push('<blockquote>' + render(qbuf.join('\n')) + '</blockquote>');
        continue;
      }

      // GFM 表格
      if (line.indexOf('|') >= 0 && isSeparatorRow(lines[i + 1])) {
        var headerCells = splitRow(line);
        var aligns = splitRow(lines[i + 1]).map(function (c) {
          c = c.trim();
          var l = /^:/.test(c), r = /:$/.test(c);
          return (l && r) ? 'center' : r ? 'right' : l ? 'left' : '';
        });
        i += 2;
        var rows = [];
        while (i < n && !isBlank(lines[i]) && lines[i].indexOf('|') >= 0) {
          rows.push(splitRow(lines[i]));
          i++;
        }
        var thead = '<thead><tr>' + headerCells.map(function (c, idx) {
          return '<th' + alignAttr(aligns[idx]) + '>' + inline(c.trim()) + '</th>';
        }).join('') + '</tr></thead>';
        var tbody = '<tbody>' + rows.map(function (r) {
          return '<tr>' + headerCells.map(function (_, idx) {
            return '<td' + alignAttr(aligns[idx]) + '>' + inline((r[idx] || '').trim()) + '</td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody>';
        push('<table>' + thead + tbody + '</table>');
        continue;
      }

      // 列表
      if (isMarker(line)) {
        var lr = parseList(lines, i);
        i = lr.next;
        push(lr.html);
        continue;
      }

      // 段落
      var pbuf = [];
      while (i < n && !isBlank(lines[i]) && !isBlockStart(lines[i], lines[i + 1])) {
        pbuf.push(lines[i]);
        i++;
      }
      // 软换行按空格处理（CommonMark 语义），行尾两个空格转硬换行
      var ptext = inline(pbuf.join('\n'));
      ptext = ptext.replace(/ {2,}\n/g, '<br />\n').replace(/\n/g, ' ');
      push('<p>' + ptext + '</p>');
    }

    return out.join('\n');
  }

  // 整篇文档的渲染入口：front matter + 正文。
  // render() 本身是纯块级渲染器，会被引用块 / 列表项递归调用，所以
  // front matter 只能在顶层这一层识别，不能塞进 render() 内部
  // （否则 `> ---\n> foo\n> ---` 这种引用块会被误判成 front matter）。
  function renderBody(src, opts) {
    var fm = splitFrontMatter(src);
    var head = fm.meta != null ? frontMatterHtml(fm.meta, fm.raw) : '';
    // 正文的行号要跳过 front matter 占掉的那几行
    var bodyOpts = opts || {};
    if (fm.meta != null) {
      bodyOpts = Object.assign({}, bodyOpts, {
        lineOffset: (bodyOpts.lineOffset || 0) + frontMatterLineCount(fm.raw),
      });
    }
    var body = render(fm.body, bodyOpts);
    return head ? head + '\n' + body : body;
  }

  // 预览页的页面底色。深色值与下方 tocVarsDark 的 --toc-bg 保持一致——
  // 同一张页面里 TOC 侧栏和正文共用一个底，靠 border-right 分隔而不是靠色差。
  // 抽成常量是因为它要在两处用到（pageCss 的 @media 和 forcedThemeCss），
  // 之前是两份硬编码的 #12141a，改一处忘另一处就会出现半深半浅。
  var PAGE_BG_LIGHT = '#ffffff';
  var PAGE_BG_DARK = '#0f1013';

  // 页面级样式：只给 /api/render-md 产出的独立预览页用。
  // 之前 html/body 背景是硬编码的 #fff——dashboard 跟随系统进深色模式时，
  // 阅读区就是深色壳子里嵌一块刺眼的白板。
  var pageCss = [
    ':root{color-scheme:light dark;}',
    'html,body{margin:0;background:' + PAGE_BG_LIGHT + ';}',
    '@media (prefers-color-scheme: dark){html,body{background:' + PAGE_BG_DARK + ';}}',
  ].join('');

  // 预览基础样式：以 .md-body 作用域，iframe 与主文档编辑预览面板共用。
  // 全部走 CSS 变量，深色模式只需覆盖变量——iframe 预览页和 dashboard 内
  // 的编辑预览面板因此能自动保持一致。
  // 两套配色变量各自命名，好让「强制主题」复用同一份值——
  // 用户在 Atlas 设置里把主题钉成深色 / 浅色时，iframe 预览页要跟着钉。
  // 取值对齐 styles.css 里的底座 token：灰阶去蓝味、border 淡化、链接跟主 accent
  // 走同一个紫蓝。正文的前景色比 UI 的 #101113 略柔（#1c1d21）——大段阅读时
  // 纯黑偏刺，UI 里的小字才需要那一档最高对比度。
  var mdVarsLight = [
    '--md-fg:#1c1d21;--md-fg-muted:#57606a;--md-fg-faint:#818b98;',
    '--md-border:#e6e8eb;--md-border-strong:#c9cdd4;',
    '--md-code-bg:rgba(140,148,163,.20);--md-pre-bg:#f7f8f9;--md-pre-head:#eff0f2;',
    '--md-link:#5b5bd6;--md-table-alt:#f7f8f9;--md-quote-fg:#57606a;',
    '--md-fm-bg:#f7f8f9;--md-fm-border:#e6e8eb;'
  ].join('');
  var mdVarsDark = [
    '--md-fg:#e7e9ec;--md-fg-muted:#9ea2a8;--md-fg-faint:#6f747c;',
    '--md-border:#1f2023;--md-border-strong:#303136;',
    '--md-code-bg:rgba(130,140,160,.20);--md-pre-bg:#16171a;--md-pre-head:#1e1f23;',
    '--md-link:#8d8df0;--md-table-alt:#16171a;--md-quote-fg:#9ea2a8;',
    '--md-fm-bg:#16171a;--md-fm-border:#1f2023;'
  ].join('');
  var markdownCss = [
    '.md-body{',
    mdVarsLight,
    'color:var(--md-fg);font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;word-wrap:break-word;}',
    '@media (prefers-color-scheme: dark){.md-body{', mdVarsDark, '}}',
    // 标题节奏：上间距远大于下间距（1.7em vs .5em）。标题要"跟着它下面的内容"，
    // 而不是均匀地漂在两段之间——这是长文档能不能扫出结构的关键。
    '.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6{margin:1.7em 0 .5em;font-weight:600;line-height:1.3;position:relative;}',
    // 去掉 h1/h2 的 border-bottom：那是 GitHub README 的长相，一条贯穿全宽的
    // 横线会把文章切成一段段"卡片"。层级交给字号和间距表达就够了。
    '.md-body h1{font-size:1.85em;letter-spacing:-.014em;}',
    '.md-body h2{font-size:1.4em;letter-spacing:-.008em;}',
    // 正文第一个元素不要顶间距（h1 常在最前，但 front matter 之后也可能是别的块）
    '.md-body > :first-child{margin-top:0;}',
    '.md-body h3{font-size:1.16em;}.md-body h4{font-size:1.02em;}.md-body h5{font-size:.95em;}.md-body h6{font-size:.9em;color:var(--md-fg-muted);}',
    '.md-body p{margin:0 0 1em;}',
    '.md-body a{color:var(--md-link);text-decoration:none;}.md-body a:hover{text-decoration:underline;}',
    // 圆角跟着底座收紧一档（行内代码 4px、代码块 6px）：6px 的行内 code
    // 在 .88em 字号下几乎成了胶囊，和正文的方正感不搭
    '.md-body code{background:var(--md-code-bg);border-radius:4px;padding:.2em .4em;font-size:.88em;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;}',
    '.md-body pre{position:relative;background:var(--md-pre-bg);border:1px solid var(--md-border);border-radius:6px;padding:14px 16px;overflow:auto;margin:0 0 1em;}',
    '.md-body pre code{background:none;padding:0;font-size:.85em;line-height:1.5;}',
    '.md-body blockquote{margin:0 0 1em;padding:.2em 1em;color:var(--md-quote-fg);border-left:.28em solid var(--md-border-strong);}',
    '.md-body ul,.md-body ol{margin:0 0 1em;padding-left:1.8em;}',
    '.md-body li{margin:.25em 0;}',
    '.md-body li>ul,.md-body li>ol{margin:.25em 0;}',
    '.md-body hr{height:1px;border:0;background:var(--md-border-strong);margin:1.6em 0;}',
    '.md-body img{max-width:100%;border-radius:6px;}',
    // 表格：外层容器负责横向滚动，table 本身保持 table 布局
    // （原来 table 自己 display:block 会脱离正常流，宽表格的滚动条很难发现）
    '.md-body table{border-collapse:collapse;margin:0 0 1em;max-width:100%;}',
    // 只留横线、去掉竖线和斑马纹（Stripe Docs 的表格就是这样）。
    // 原来每个单元格四面都有 border + 隔行底色，等于用三种手段重复表达
    // "这是一格"，密集表格会变成一张网格纸。横线足够分行，留白负责分列。
    '.md-body table th,.md-body table td{border:0;border-bottom:1px solid var(--md-border);padding:8px 14px 8px 0;}',
    '.md-body table th{background:transparent;font-weight:600;border-bottom:1px solid var(--md-border-strong);',
    'color:var(--md-fg-muted);font-size:.92em;}',
    '.md-body table tr:last-child td{border-bottom:0;}',
    '.md-body del{color:var(--md-fg-faint);}',
    // front matter 元信息块
    '.md-frontmatter{margin:0 0 1.4em;padding:10px 14px;border:1px solid var(--md-fm-border);',
    'border-radius:8px;background:var(--md-fm-bg);font-size:.86em;line-height:1.6;}',
    '.md-fm-label{font-size:.85em;letter-spacing:.08em;text-transform:uppercase;color:var(--md-fg-faint);margin-bottom:4px;}',
    '.md-fm-row{display:flex;gap:8px;}',
    '.md-fm-key{flex:0 0 auto;min-width:5.5em;color:var(--md-fg-muted);}',
    '.md-fm-val{flex:1 1 auto;min-width:0;color:var(--md-fg);word-break:break-word;}',
    // 任务列表
    '.md-body ul.md-task-list{list-style:none;padding-left:1.1em;}',
    '.md-body li.md-task-item{display:flex;align-items:flex-start;gap:.5em;}',
    '.md-body input.md-task{margin:.42em 0 0;flex:0 0 auto;accent-color:var(--md-link);}',
    '.md-body li.md-task-item.md-task-done{color:var(--md-fg-muted);text-decoration:line-through;',
    'text-decoration-color:var(--md-fg-faint);}',
    // 标题锚点：hover 才出现，不干扰正常阅读
    '.md-body .md-anchor{margin-left:.4em;color:var(--md-fg-faint);text-decoration:none;',
    'opacity:0;transition:opacity .12s ease;font-weight:400;}',
    '.md-body h1:hover .md-anchor,.md-body h2:hover .md-anchor,.md-body h3:hover .md-anchor,',
    '.md-body h4:hover .md-anchor,.md-body h5:hover .md-anchor,.md-body h6:hover .md-anchor{opacity:1;}',
    '.md-body .md-anchor:focus-visible{opacity:1;outline:2px solid var(--md-link);outline-offset:2px;}',
    // 代码块头部（语言标签 + 复制按钮），由 enhanceScript 注入
    '.md-body .md-code-head{position:absolute;top:0;right:0;left:0;display:flex;align-items:center;',
    'justify-content:space-between;gap:8px;padding:5px 10px 5px 14px;background:var(--md-pre-head);',
    'border-radius:5px 5px 0 0;font:500 11px/1.4 -apple-system,system-ui,sans-serif;}',
    '.md-body pre:has(.md-code-head){padding-top:38px;}',
    '.md-body .md-code-lang{color:var(--md-fg-muted);letter-spacing:.04em;text-transform:uppercase;}',
    '.md-body .md-code-copy{border:1px solid var(--md-border-strong);border-radius:5px;background:transparent;',
    'color:var(--md-fg-muted);padding:2px 8px;font:inherit;cursor:pointer;transition:color .12s,border-color .12s;}',
    '.md-body .md-code-copy:hover{color:var(--md-fg);border-color:var(--md-fg-muted);}',
    '.md-body .md-code-copy.copied{color:#3fb950;border-color:#3fb950;}',
    // 走浏览器打印对话框时（找不到 Chromium 的降级路径）：纸上点不了的控件都藏掉
    '@media print{',
    '.md-body .md-code-head{display:none;}',
    '.md-body pre{padding-top:14px !important;white-space:pre-wrap;word-break:break-word;}',
    '.md-body .md-anchor{display:none;}',
    '.md-body .md-table-scroll{overflow:visible;}',
    '}',
    // 表格横向滚动包裹层，由 enhanceScript 注入
    '.md-body .md-table-scroll{overflow-x:auto;margin:0 0 1em;}',
    '.md-body .md-table-scroll table{margin:0;}',
  ].join('\n');

  // ---------- HTML → Markdown（反向序列化，仅浏览器端所见即所得编辑用）----------
  // 只处理本渲染器会产出的标签集合 + contentEditable 常见的 div/br。
  function serializeNodeInline(n) {
    if (!n) return '';
    if (n.nodeType === 3) return (n.nodeValue || '').replace(/\s+/g, ' ');
    if (n.nodeType !== 1) return '';
    var tag = n.tagName;
    var inner = function () {
      return Array.prototype.map.call(n.childNodes, serializeNodeInline).join('');
    };
    switch (tag) {
      case 'BR': return '\n';
      case 'STRONG': case 'B': return '**' + inner().trim() + '**';
      case 'EM': case 'I': return '*' + inner().trim() + '*';
      case 'DEL': case 'S': case 'STRIKE': return '~~' + inner().trim() + '~~';
      case 'CODE': return '`' + (n.textContent || '') + '`';
      case 'A': return '[' + inner().trim() + '](' + (n.getAttribute('href') || '') + ')';
      case 'IMG': return '![' + (n.getAttribute('alt') || '') + '](' + (n.getAttribute('src') || '') + ')';
      // 任务列表复选框：还原成 [ ] / [x]，否则回写时勾选状态和方括号一起丢掉
      case 'INPUT':
        if ((n.getAttribute('type') || '').toLowerCase() === 'checkbox') {
          return (n.checked ? '[x] ' : '[ ] ');
        }
        return '';
      default: return inner();
    }
  }
  function serializeInlineChildren(el) {
    return Array.prototype.map.call(el.childNodes, serializeNodeInline).join('');
  }
  var BLOCK_TAGS = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE|THEAD|TBODY|TR)$/;

  function serializeList(listEl, indent, ordered) {
    var lines = [];
    var idx = 1;
    Array.prototype.forEach.call(listEl.children, function (li) {
      if (li.tagName !== 'LI') return;
      var marker = ordered ? (idx++ + '. ') : '- ';
      var inlineParts = [], nested = [];
      Array.prototype.forEach.call(li.childNodes, function (n) {
        if (n.nodeType === 1 && (n.tagName === 'UL' || n.tagName === 'OL')) nested.push(n);
        else inlineParts.push(n);
      });
      var text = inlineParts.map(serializeNodeInline).join('').trim();
      lines.push(indent + marker + text);
      nested.forEach(function (nl) {
        lines.push(serializeList(nl, indent + '  ', nl.tagName === 'OL'));
      });
    });
    return lines.join('\n');
  }

  // 单元格对齐：渲染时写在 style="text-align:..." 里，回写时读回来，
  // 否则 `|:---|--:|` 这类对齐信息会在往返中退化成统一的 `---`
  function cellAlignBar(cell) {
    var style = (cell && cell.getAttribute && cell.getAttribute('style')) || '';
    var m = /text-align:\s*(left|center|right)/i.exec(style);
    var a = m ? m[1].toLowerCase() : '';
    if (a === 'center') return ':---:';
    if (a === 'right') return '---:';
    if (a === 'left') return ':---';
    return '---';
  }

  function serializeTable(tbl) {
    var headCells = Array.prototype.slice.call(tbl.querySelectorAll('thead th, thead td'));
    var head = headCells.map(function (c) { return serializeInlineChildren(c).trim(); });
    if (!head.length) return joinBlocks(serializeBlocksList(tbl));
    var rows = [];
    rows.push('| ' + head.join(' | ') + ' |');
    rows.push('| ' + headCells.map(cellAlignBar).join(' | ') + ' |');
    Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
      var cells = Array.prototype.map.call(tr.children,
        function (c) { return serializeInlineChildren(c).trim(); });
      rows.push('| ' + cells.join(' | ') + ' |');
    });
    return rows.join('\n');
  }

  function serializeBlock(el, indent) {
    // 没被用户碰过的块：直接吐回渲染时记下的原始源码。
    // 这是"改一个字不该重写整篇文档"的关键——表格对齐、段落软换行、
    // front matter、以及本渲染器不完整支持的语法都因此得以原样保留。
    if (el.getAttribute) {
      var raw = el.getAttribute('data-md-raw');
      if (raw != null && el.getAttribute('data-md-dirty') == null) {
        return raw.replace(/[\s]+$/, '');
      }
    }
    var tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return '#'.repeat(+tag[1]) + ' ' + serializeInlineChildren(el).trim();
    if (tag === 'HR') return '---';
    if (tag === 'PRE') {
      var codeEl = el.querySelector('code');
      var code = (codeEl ? codeEl.textContent : el.textContent).replace(/\n$/, '');
      var lang = '';
      if (codeEl) { var m = (codeEl.className || '').match(/language-([\w-]+)/); if (m) lang = m[1]; }
      return '```' + lang + '\n' + code + '\n```';
    }
    if (tag === 'UL' || tag === 'OL') return serializeList(el, indent || '', tag === 'OL');
    if (tag === 'TABLE') return serializeTable(el);
    if (tag === 'BLOCKQUOTE') {
      var inner = joinBlocks(serializeBlocksList(el));
      return inner.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
    }
    // P / DIV / 其它：当作一个段落
    return serializeInlineChildren(el).trim();
  }

  // 返回 [{ text, gap }]，gap = 该块之前原本有几个空行（未知时为 null）
  function serializeBlocksList(container) {
    var blocks = [];
    var inlineBuf = [];
    var flush = function () {
      if (!inlineBuf.length) return;
      var text = inlineBuf.map(serializeNodeInline).join('').trim();
      if (text) blocks.push({ text: text, gap: null });
      inlineBuf = [];
    };
    Array.prototype.forEach.call(container.childNodes, function (n) {
      if (n.nodeType === 1 && BLOCK_TAGS.test(n.tagName)) {
        flush();
        var b = serializeBlock(n, '');
        if (b && b.trim()) {
          var g = n.getAttribute ? n.getAttribute('data-md-gap') : null;
          blocks.push({ text: b, gap: g == null ? null : parseInt(g, 10) });
        }
      } else {
        inlineBuf.push(n);
      }
    });
    flush();
    return blocks;
  }

  // 按各块记录的原始间距拼接；未知间距回落到一个空行（标准 Markdown 写法）
  function joinBlocks(blocks) {
    var out = '';
    blocks.forEach(function (b, idx) {
      if (idx > 0) {
        var gap = (b.gap == null || isNaN(b.gap)) ? 1 : Math.max(0, b.gap);
        out += new Array(gap + 2).join('\n');   // gap 个空行 = gap+1 个换行
      }
      out += b.text;
    });
    return out;
  }

  // 把（本渲染器产出的）DOM 子树转回 Markdown 文本
  function htmlToMarkdown(root) {
    if (!root) return '';
    var md = joinBlocks(serializeBlocksList(root));
    return md.replace(/[ \t]+\n/g, '\n').replace(/\s+$/, '') + '\n';
  }

  // ---------- 目录（TOC）：从渲染后的 HTML 抽取标题，生成锚点导航 ----------
  function stripTags(html) {
    return String(html == null ? '' : html).replace(/<[^>]+>/g, '');
  }

  // 生成锚点 slug：保留字母数字、中日韩、连字符；重复时追加序号去重
  function slugify(text, used) {
    var base = stripTags(text).trim().toLowerCase()
      .replace(/[^\w\u4e00-\u9fff\- ]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!base) base = 'section';
    var slug = base, k = 1;
    while (used[slug]) slug = base + '-' + (k++);
    used[slug] = true;
    return slug;
  }

  // 给渲染后的 HTML 里的标题注入 id + hover 锚点链接，并收集目录项。
  // 只在只读预览页（renderPage）里用，不影响编辑器预览面板的反解析。
  function extractHeadings(html) {
    var used = {};
    var items = [];
    var out = String(html).replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, function (m, lvl, inner) {
      var text = stripTags(inner).trim();
      if (!text) return m;
      var id = slugify(text, used);
      items.push({ level: +lvl, id: id, text: text });
      var anchor = '<a class="md-anchor" href="#' + id + '" aria-label="复制本节链接">#</a>';
      return '<h' + lvl + ' id="' + id + '">' + inner + anchor + '</h' + lvl + '>';
    });
    return { html: out, items: items };
  }

  // 把扁平的标题数组按 level 组织成嵌套树，供折叠使用
  function buildTocTree(items) {
    var root = { children: [] };
    var stack = [{ node: root, level: 0 }];
    items.forEach(function (it) {
      while (stack.length > 1 && stack[stack.length - 1].level >= it.level) stack.pop();
      var node = { item: it, children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ node: node, level: it.level });
    });
    return root.children;
  }

  function tocTreeHtml(nodes) {
    if (!nodes.length) return '';
    var lis = nodes.map(function (n) {
      var hasKids = n.children.length > 0;
      var caret = hasKids
        ? '<button class="toc-caret" type="button" aria-label="折叠 / 展开"></button>'
        : '<span class="toc-caret toc-caret-leaf"></span>';
      return '<li class="toc-li' + (hasKids ? ' has-children' : '') + '">'
        + '<div class="toc-row">' + caret
        + '<a href="#' + n.item.id + '" data-target="' + n.item.id + '" title="' + escapeHtml(n.item.text) + '">'
        + escapeHtml(n.item.text) + '</a></div>'
        + (hasKids ? tocTreeHtml(n.children) : '')
        + '</li>';
    }).join('');
    return '<ul class="toc-ul">' + lis + '</ul>';
  }

  function tocListHtml(items) {
    if (!items.length) return '';
    return tocTreeHtml(buildTocTree(items));
  }

  // 只读预览页里 TOC 侧栏的样式（不影响编辑器分栏预览面板）——克制、极简
  // 取值对齐底座 token；--toc-active 跟主 accent 走同一个紫蓝，
  // --toc-rail 是层级轨道线（比 border 再淡一档，只需"隐约看得出有一列"）
  var tocVarsLight = '--toc-bg:#fff;--toc-border:#e6e8eb;--toc-title:#818b98;--toc-fg:#57606a;'
    + '--toc-fg-strong:#101113;--toc-hover:#f0f1f3;--toc-active:#5b5bd6;--toc-caret:#c9cdd4;'
    + '--toc-rail:rgba(16,24,40,.09);--toc-active-soft:rgba(91,91,214,.09);';
  var tocVarsDark = '--toc-bg:#0f1013;--toc-border:#1f2023;--toc-title:#6f747c;'
    + '--toc-fg:#9ea2a8;--toc-fg-strong:#f7f8f8;--toc-hover:#1f2024;--toc-active:#8d8df0;--toc-caret:#3a3b40;'
    + '--toc-rail:rgba(255,255,255,.10);--toc-active-soft:rgba(141,141,240,.14);';
  var tocCss = [
    'body{', tocVarsLight, '}',
    '@media (prefers-color-scheme: dark){body{', tocVarsDark, '}}',
    '*{scroll-behavior:smooth;}',
    // 目录栏宽度走 CSS 变量，由拖拽条改写并持久化（见 tocScript）。
    // 长文档的标题经常比 250px 长，固定宽度只能靠 ellipsis 截断，
    // "步骤 1: 更新 PUBLISHI…" 这种截断恰好把有用的部分切掉了。
    'body{--toc-w:250px;}',
    '.md-toc{position:fixed;top:0;left:0;width:var(--toc-w);height:100vh;box-sizing:border-box;overflow-y:auto;',
    'padding:46px 10px 32px 14px;border-right:1px solid var(--toc-border);background:var(--toc-bg);z-index:5;transition:transform .2s ease;',
    'font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;}',
    // 拖拽条：贴在目录栏右缘，平时透明，hover / 拖动时才显出一条线
    '.md-toc-resizer{position:fixed;top:0;bottom:0;left:var(--toc-w);width:5px;margin-left:-2px;',
    'z-index:6;cursor:col-resize;background:transparent;border:0;padding:0;}',
    '.md-toc-resizer::before{content:"";position:absolute;top:0;bottom:0;left:2px;width:1px;',
    'background:var(--toc-active);opacity:0;transition:opacity .12s;}',
    '.md-toc-resizer:hover::before,.md-toc-resizer.dragging::before{opacity:1;}',
    '.md-toc-resizer:focus-visible{outline:none;}',
    '.md-toc-resizer:focus-visible::before{opacity:1;width:2px;}',
    'body.toc-resizing{cursor:col-resize;user-select:none;}',
    // 拖动时关掉过渡，否则宽度会追着指针"滑"过去
    'body.toc-resizing .md-toc,body.toc-resizing .md-content{transition:none;}',
    'body.toc-collapsed .md-toc-resizer{display:none;}',
    '.md-toc-title{font-size:11px;letter-spacing:.09em;text-transform:uppercase;color:var(--toc-title);font-weight:600;padding:0 8px 10px;}',
    '.toc-ul{list-style:none;margin:0;padding:0;}',
    // 子层级带一条轨道竖线 + 更大的缩进：原来只有 13px 缩进，三四层标题挤在
    // 一起时层级完全靠猜。轨道线让"这几条属于同一节"变成可见的事实。
    '.toc-ul .toc-ul{padding-left:14px;margin-left:8px;border-left:1px solid var(--toc-rail);}',
    '.toc-row{display:flex;align-items:center;}',
    '.toc-row a{position:relative;flex:1;min-width:0;display:block;padding:4px 8px;color:var(--toc-fg);text-decoration:none;',
    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:5px;transition:color .12s,background .12s;}',
    '.toc-row a:hover{color:var(--toc-fg-strong);background:var(--toc-hover);}',
    '.toc-row a.active{color:var(--toc-active);font-weight:500;background:var(--toc-active-soft);}',
    // 当前章节左侧的 2px 竖条（Stripe Docs 的招牌）。在一屏几十条的长目录里，
    // "我读到第几节"靠一个位置信号比靠文字颜色变化更容易被扫到。
    '.toc-row a.active::before{content:"";position:absolute;left:0;top:4px;bottom:4px;',
    'width:2px;border-radius:0 2px 2px 0;background:var(--toc-active);}',
    // caret：极简三角，仅有子项时可点
    '.toc-caret{flex:0 0 16px;width:16px;height:20px;padding:0;border:0;background:none;cursor:pointer;',
    'display:inline-flex;align-items:center;justify-content:center;color:var(--toc-caret);}',
    '.toc-caret::before{content:"";width:0;height:0;border-left:4px solid currentColor;',
    'border-top:3.5px solid transparent;border-bottom:3.5px solid transparent;transition:transform .15s ease;}',
    '.toc-li.has-children:not(.collapsed)>.toc-row>.toc-caret::before{transform:rotate(90deg);}',
    '.toc-caret:hover{color:var(--toc-fg);}',
    '.toc-caret-leaf{cursor:default;}.toc-caret-leaf::before{display:none;}',
    '.toc-li.collapsed>.toc-ul{display:none;}',
    // 收起 / 展开按钮：无边框图标
    '.md-toc-toggle{position:fixed;top:9px;left:9px;z-index:6;width:30px;height:30px;padding:0;',
    'display:flex;align-items:center;justify-content:center;border:0;border-radius:7px;background:transparent;',
    'color:var(--toc-title);cursor:pointer;transition:background .12s,color .12s;}',
    '.md-toc-toggle:hover{background:var(--toc-hover);color:var(--toc-fg-strong);}',
    '.md-toc-toggle svg{width:17px;height:17px;}',
    '.md-content{margin-left:var(--toc-w);transition:margin-left .2s ease;}',
    // 820px @15px ≈ 每行 54 个汉字，落在长文阅读的舒适区间；上下 padding 加大，
    // 首屏标题不要一上来就贴着顶栏
    '.md-content .md-inner{max-width:820px;margin:0 auto;padding:44px 48px 32px;box-sizing:border-box;}',
    // 底部留白：保证最后几个标题也能滚到视口顶部（锚点跳转不失效）
    '.md-tail-space{height:70vh;}',
    '.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6{scroll-margin-top:20px;}',
    'body.toc-collapsed .md-toc{transform:translateX(-100%);}',
    'body.toc-collapsed .md-content{margin-left:0;}',
    '@media (max-width:900px){.md-content{margin-left:0;}.md-toc{box-shadow:2px 0 14px rgba(0,0,0,.1);}}',
    // 打印时目录侧栏是 fixed 定位，会盖在每一页正文上——直接隐藏，正文铺满纸张
    '@media print{',
    '.md-toc,.md-toc-toggle,.md-toc-resizer,.md-tail-space{display:none !important;}',
    '.md-content{margin-left:0 !important;}',
    '.md-content .md-inner{max-width:none;padding:0;}',
    '@page{margin:16mm 14mm;}',
    '}',
  ].join('');

  // TOC 交互脚本：收起持久化、层级折叠、平滑滚动、滚动高亮当前章节
  var tocScript = '(function(){'
    + 'var KEY="atlas:mdTocCollapsed";var toc=document.getElementById("mdToc");var tg=document.getElementById("mdTocToggle");'
    + 'try{if(localStorage.getItem(KEY)==="1")document.body.classList.add("toc-collapsed");}catch(e){}'
    + 'if(tg)tg.addEventListener("click",function(){var c=document.body.classList.toggle("toc-collapsed");try{localStorage.setItem(KEY,c?"1":"0");}catch(e){}});'
    // ---- 目录栏宽度：拖拽 / 键盘微调 / 双击复位，宽度记在 localStorage ----
    // 目录栏从 left:0 开始，所以指针的 clientX 就是目标宽度，不需要换算偏移量。
    + 'var WKEY="atlas:mdTocWidth",MINW=180,MAXW=520,DEFW=250;'
    + 'var rz=document.getElementById("mdTocResizer");'
    + 'function setW(w,persist){w=Math.max(MINW,Math.min(MAXW,Math.round(w)));'
    + 'document.body.style.setProperty("--toc-w",w+"px");'
    + 'if(persist){try{localStorage.setItem(WKEY,String(w));}catch(e){}}return w;}'
    + 'function curW(){var v=parseInt(getComputedStyle(document.body).getPropertyValue("--toc-w"),10);'
    + 'return isFinite(v)?v:DEFW;}'
    + 'try{var sw=parseInt(localStorage.getItem(WKEY),10);if(isFinite(sw))setW(sw,false);}catch(e){}'
    + 'if(rz){var dragging=false,lastW=DEFW;'
    // setPointerCapture 让指针移出这条 5px 的窄条后事件仍然回到它身上，
    // 不然快速拖动时指针一旦跑进 iframe 正文区就断了
    + 'rz.addEventListener("pointerdown",function(e){dragging=true;lastW=curW();'
    + 'rz.classList.add("dragging");document.body.classList.add("toc-resizing");'
    + 'if(rz.setPointerCapture)rz.setPointerCapture(e.pointerId);e.preventDefault();});'
    + 'rz.addEventListener("pointermove",function(e){if(!dragging)return;lastW=setW(e.clientX,false);});'
    + 'function endDrag(){if(!dragging)return;dragging=false;rz.classList.remove("dragging");'
    + 'document.body.classList.remove("toc-resizing");setW(lastW,true);}'
    + 'rz.addEventListener("pointerup",endDrag);rz.addEventListener("pointercancel",endDrag);'
    + 'rz.addEventListener("dblclick",function(){setW(DEFW,true);});'
    + 'rz.addEventListener("keydown",function(e){var step=e.shiftKey?24:8;'
    + 'if(e.key==="ArrowLeft"){setW(curW()-step,true);e.preventDefault();}'
    + 'else if(e.key==="ArrowRight"){setW(curW()+step,true);e.preventDefault();}'
    + 'else if(e.key==="Home"){setW(DEFW,true);e.preventDefault();}});}'
    + 'if(toc)toc.addEventListener("click",function(e){'
    + 'var caret=e.target.closest?e.target.closest(".toc-caret"):null;'
    + 'if(caret&&caret.tagName==="BUTTON"){var li=caret.closest(".toc-li");if(li)li.classList.toggle("collapsed");return;}'
    + 'var a=e.target.closest?e.target.closest("a[data-target]"):null;if(!a)return;e.preventDefault();'
    // 注意：replaceState 的相对 URL 是按「文档 base URL」解析的，本页注入了
    // <base href="/raw/…/">，直接传 "#id" 会把文档 URL 改写成 /raw/…/#id，
    // 之后刷新 iframe 就变成 GET 目录 → Cannot GET /raw/0/xxx/。必须带上真实路径。
    + 'var el=document.getElementById(a.getAttribute("data-target"));if(el){el.scrollIntoView({behavior:"smooth",block:"start"});'
    + 'try{history.replaceState(null,"",location.pathname+location.search+"#"+a.getAttribute("data-target"));}catch(_){}}'
    + 'if(window.matchMedia&&window.matchMedia("(max-width:900px)").matches)document.body.classList.add("toc-collapsed");});'
    + 'var links={};Array.prototype.forEach.call(document.querySelectorAll(".toc-ul a[data-target]"),function(a){links[a.getAttribute("data-target")]=a;});'
    + 'function expandTo(a){var li=a.closest(".toc-li");while(li){if(li.classList.contains("has-children"))li.classList.remove("collapsed");li=li.parentElement?li.parentElement.closest(".toc-li"):null;}}'
    + 'var heads=Array.prototype.slice.call(document.querySelectorAll(".md-body h1[id],.md-body h2[id],.md-body h3[id],.md-body h4[id],.md-body h5[id],.md-body h6[id]"));'
    + 'var cur=null;function setActive(id){if(cur===id)return;if(cur&&links[cur])links[cur].classList.remove("active");cur=id;if(id&&links[id]){var a=links[id];a.classList.add("active");expandTo(a);'
    + 'var pr=toc.getBoundingClientRect(),ar=a.getBoundingClientRect();if(ar.top<pr.top||ar.bottom>pr.bottom)a.scrollIntoView({block:"nearest"});}}'
    + 'if("IntersectionObserver" in window&&heads.length){var vis={};var io=new IntersectionObserver(function(es){es.forEach(function(en){vis[en.target.id]=en.isIntersecting;});'
    + 'var chosen=null;for(var i=0;i<heads.length;i++){if(vis[heads[i].id]){chosen=heads[i].id;break;}}'
    + 'if(!chosen){for(var j=heads.length-1;j>=0;j--){if(heads[j].getBoundingClientRect().top<80){chosen=heads[j].id;break;}}}'
    + 'if(!chosen&&heads.length)chosen=heads[0].id;setActive(chosen);},{rootMargin:"0px 0px -70% 0px",threshold:0});'
    + 'heads.forEach(function(h){io.observe(h);});}'
    + '})();';

  // 只读预览页的运行时增强：给代码块加「语言标签 + 复制」，给宽表格套横向滚动层。
  // 特意只在 iframe 预览页里做、不写进 render() 的输出——编辑器右侧的所见即所得
  // 预览面板要靠 htmlToMarkdown() 反解析回源码，DOM 里多出按钮会污染结果。
  var enhanceScript = '(function(){'
    // 页内锚点：本页注入了 <base href="/raw/…/">，href="#id" 会被解析成
    // /raw/…/#id —— 点一下标题锚点或 md 里的 [x](#y) 就整页跳走变 404。
    // 统统自己接管：滚动到目标 + 只改 hash（保持文档 URL 不变，刷新才不会 404）。
    + 'function setHash(id){try{history.replaceState(null,"",location.pathname+location.search+(id?"#"+id:""));}catch(_){}}'
    + 'document.addEventListener("click",function(e){'
    + 'var a=(e.target&&e.target.closest)?e.target.closest("a"):null;if(!a)return;'
    + 'if(a.hasAttribute("data-target"))return;'   // TOC 链接由 tocScript 处理
    + 'var raw=a.getAttribute("href")||"";if(raw.charAt(0)!=="#")return;'
    + 'e.preventDefault();'
    + 'var id="";try{id=decodeURIComponent(raw.slice(1));}catch(_){id=raw.slice(1);}'
    + 'if(!id){window.scrollTo({top:0,behavior:"smooth"});setHash("");return;}'
    + 'var el=document.getElementById(id)||document.getElementsByName(id)[0];'
    + 'if(el)el.scrollIntoView({behavior:"smooth",block:"start"});'
    + 'setHash(id);'
    + '});'
    + 'function fallbackCopy(text,done){try{var ta=document.createElement("textarea");ta.value=text;'
    + 'ta.setAttribute("aria-hidden","true");ta.style.position="fixed";ta.style.top="-1000px";ta.style.opacity="0";'
    + 'document.body.appendChild(ta);ta.select();document.execCommand("copy");document.body.removeChild(ta);done();}catch(e){}}'
    + 'Array.prototype.forEach.call(document.querySelectorAll(".md-body pre"),function(pre){'
    + 'var code=pre.querySelector("code");if(!code)return;'
    + 'var lang="";var m=(code.className||"").match(/language-([\\w+#.-]+)/);if(m)lang=m[1];'
    + 'var head=document.createElement("div");head.className="md-code-head";'
    + 'var tag=document.createElement("span");tag.className="md-code-lang";tag.textContent=lang||"text";'
    + 'head.appendChild(tag);'
    + 'var btn=document.createElement("button");btn.type="button";btn.className="md-code-copy";'
    + 'btn.textContent="复制";btn.setAttribute("aria-label","复制这段代码");'
    + 'btn.addEventListener("click",function(){var t=code.textContent;'
    + 'var done=function(){btn.textContent="已复制";btn.classList.add("copied");'
    + 'setTimeout(function(){btn.textContent="复制";btn.classList.remove("copied");},1500);};'
    + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
    + 'navigator.clipboard.writeText(t).then(done,function(){fallbackCopy(t,done);});'
    + '}else{fallbackCopy(t,done);}});'
    + 'head.appendChild(btn);pre.insertBefore(head,pre.firstChild);'
    + '});'
    // 宽表格：套一层可横向滚动的容器，滚动条位置更符合预期
    + 'Array.prototype.forEach.call(document.querySelectorAll(".md-body table"),function(tbl){'
    + 'if(tbl.parentNode&&tbl.parentNode.classList&&tbl.parentNode.classList.contains("md-table-scroll"))return;'
    + 'var wrap=document.createElement("div");wrap.className="md-table-scroll";'
    + 'tbl.parentNode.insertBefore(wrap,tbl);wrap.appendChild(tbl);'
    + '});'
    + '})();';

  // 打印 / PDF 专用样式。
  // 两个关键点：
  //   ① 把配色钉回浅色 —— 否则在深色系统上导出会得到一张整页墨黑的 PDF
  //     （放在 markdownCss 之后，同特异性下后写的规则生效）
  //   ② 页边距交给 @page，正文不再限制 max-width，避免纸张两侧大片留白
  var printCss = [
    '.md-body{',
    '--md-fg:#24292f;--md-fg-muted:#57606a;--md-fg-faint:#8a8f98;',
    '--md-border:#d8dce2;--md-border-strong:#c4cad2;',
    '--md-code-bg:rgba(175,184,193,.28);--md-pre-bg:#f6f8fa;--md-pre-head:#eceff3;',
    '--md-link:#0b5cc4;--md-table-alt:#f6f8fa;--md-quote-fg:#57606a;',
    '--md-fm-bg:#f6f8fa;--md-fm-border:#e3e6ec;}',
    'html,body{margin:0;background:#fff;}',
    'body{padding:0;}',
    '@page{margin:16mm 14mm;}',
    // 分页控制：标题不要吊在页尾，代码块 / 表格 / 图片尽量不被切断
    '.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6{',
    'break-after:avoid;page-break-after:avoid;break-inside:avoid;}',
    '.md-body pre,.md-body table,.md-body blockquote,.md-body img,.md-body .md-frontmatter{',
    'break-inside:avoid;page-break-inside:avoid;}',
    '.md-body pre{white-space:pre-wrap;word-break:break-word;overflow:visible;}',
    '.md-body table{width:100%;}',
    // 链接在纸上点不动，把地址打出来才有意义（锚点链接除外）
    '.md-body a[href^="http"]::after{content:" (" attr(href) ")";font-size:.82em;color:var(--md-fg-faint);',
    'word-break:break-all;}',
  ].join('');

  // 组装完整 HTML 预览页（供服务端 /api/render-md 使用）
  // opts.baseHref：必须传！预览页的 URL 是 /api/render-md?path=...，
  // 没有 <base> 的话文档里 `![](./img/a.png)` 会被解析成 /api/img/a.png → 404，
  // 也就是「md 里的本地图片全裂」。baseHref 指向该 md 所在目录的 /raw/ 前缀。
  // 强制主题：Atlas 设置里把主题钉成 light / dark 时，iframe 里的预览页
  // 不能再跟着系统走，否则会出现「外壳浅色 + 预览深色」的割裂。
  // iframe 里的 prefers-color-scheme 读的是系统设置（不继承父文档的
  // color-scheme），所以只能由服务端把这段覆盖样式一起吐出来。
  // 它排在 @media 块之后，靠顺序取胜，不需要提高选择器优先级。
  function forcedThemeCss(theme) {
    if (theme !== 'light' && theme !== 'dark') return '';
    var dark = theme === 'dark';
    return ':root{color-scheme:' + theme + ';}'
      + 'html,body{background:' + (dark ? PAGE_BG_DARK : PAGE_BG_LIGHT) + ';}'
      + '.md-body{' + (dark ? mdVarsDark : mdVarsLight) + '}'
      + 'body{' + (dark ? tocVarsDark : tocVarsLight) + '}';
  }

  function renderPage(src, opts) {
    opts = opts || {};
    var title = escapeHtml(opts.title || 'Markdown');
    var baseTag = opts.baseHref
      ? '<base href="' + escapeHtml(opts.baseHref) + '" />'
      : '';
    // 打印模式：不要固定定位的目录侧栏（会盖在每页正文上）、不要代码块复制按钮
    // （纸上点不了）、不要标题 hover 锚点。只要干净的正文。
    if (opts.forPrint) {
      return '<!doctype html><html lang="zh"><head><meta charset="utf-8" />'
        + baseTag
        + '<meta name="color-scheme" content="light" />'
        + '<title>' + title + '</title>'
        + '<style>' + markdownCss + printCss + '</style></head>'
        + '<body class="md-body">' + renderBody(src) + '</body></html>';
    }

    var forced = forcedThemeCss(opts.theme);
    var schemeMeta = (opts.theme === 'light' || opts.theme === 'dark') ? opts.theme : 'light dark';
    var extracted = extractHeadings(renderBody(src));
    var body = extracted.html;
    var items = extracted.items;
    var hasToc = items.length >= 2; // 至少两个标题才值得显示导航
    var head = '<!doctype html><html lang="zh"><head><meta charset="utf-8" />'
      + baseTag
      + '<meta name="viewport" content="width=device-width,initial-scale=1" />'
      + '<meta name="color-scheme" content="' + schemeMeta + '" />'
      + '<title>' + title + '</title>';

    if (!hasToc) {
      return head
        // 阅读宽度与有 TOC 的分支（.md-inner）保持一致：同一篇文档因为标题
        // 多了两个就换一种行宽，读起来会明显不适
        + '<style>html,body{margin:0;}body{padding:44px 48px 32px;max-width:820px;margin:0 auto;}'
        + pageCss + markdownCss + forced + '</style></head>'
        + '<body class="md-body">' + body
        + '<script>' + enhanceScript + '</script>'
        + '</body></html>';
    }

    var toggleSvg = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" '
      + 'stroke-linecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>';

    return head
      + '<style>' + pageCss + tocCss + markdownCss + forced + '</style></head>'
      + '<body>'
      + '<button class="md-toc-toggle" id="mdTocToggle" type="button" title="展开 / 收起目录" aria-label="展开或收起目录">' + toggleSvg + '</button>'
      + '<nav class="md-toc" id="mdToc" aria-label="文档目录"><div class="md-toc-title">目录</div>' + tocListHtml(items) + '</nav>'
      + '<div class="md-toc-resizer" id="mdTocResizer" role="separator" aria-orientation="vertical"'
      + ' tabindex="0" aria-label="拖拽调整目录宽度（方向键可微调，双击复位）"'
      + ' title="拖拽调整目录宽度，双击复位"></div>'
      + '<div class="md-content"><div class="md-inner md-body">' + body + '<div class="md-tail-space" aria-hidden="true"></div></div></div>'
      + '<script>' + tocScript + '</script>'
      + '<script>' + enhanceScript + '</script>'
      + '</body></html>';
  }

  return {
    render: render,
    renderBody: renderBody,
    renderPage: renderPage,
    htmlToMarkdown: htmlToMarkdown,
    markdownCss: markdownCss,
    pageCss: pageCss,
    forcedThemeCss: forcedThemeCss,
    printCss: printCss,
    splitFrontMatter: splitFrontMatter,
    escapeHtml: escapeHtml,
  };
});
