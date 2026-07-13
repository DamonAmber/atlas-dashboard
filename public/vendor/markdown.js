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
        return '<img src="' + url + '" alt="' + alt + '"' + t + ' />';
      });

    // 4) 链接 [text](url "title")
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^)]*?)&quot;)?\)/g,
      function (m, label, url, title) {
        var t = title ? ' title="' + title + '"' : '';
        return '<a href="' + url + '"' + t + ' target="_blank" rel="noopener noreferrer">' + label + '</a>';
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

      var itemHtml = inline(head.trim());
      if (nested.length) {
        var strip = new RegExp('^\\s{0,' + (baseIndent + 2) + '}');
        var dedented = nested.map(function (l) { return l === '' ? '' : l.replace(strip, ''); });
        itemHtml += '\n' + render(dedented.join('\n'));
      }
      items.push('<li>' + itemHtml + '</li>');
    }

    var tag = ordered ? 'ol' : 'ul';
    return { html: '<' + tag + '>' + items.join('') + '</' + tag + '>', next: i };
  }

  // ---------- 块级渲染 ----------
  function render(src) {
    src = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var lines = src.split('\n');
    var out = [];
    var i = 0, n = lines.length;

    while (i < n) {
      var line = lines[i];

      if (isBlank(line)) { i++; continue; }

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
        out.push('<pre><code' + cls + '>' + escapeHtml(buf.join('\n')) + '</code></pre>');
        continue;
      }

      // 标题
      var h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) {
        var level = h[1].length;
        out.push('<h' + level + '>' + inline(h[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // 分割线
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr />');
        i++;
        continue;
      }

      // 引用
      if (/^\s*>/.test(line)) {
        var qbuf = [];
        while (i < n && /^\s*>/.test(lines[i])) {
          qbuf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        out.push('<blockquote>' + render(qbuf.join('\n')) + '</blockquote>');
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
        out.push('<table>' + thead + tbody + '</table>');
        continue;
      }

      // 列表
      if (isMarker(line)) {
        var lr = parseList(lines, i);
        out.push(lr.html);
        i = lr.next;
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
      out.push('<p>' + ptext + '</p>');
    }

    return out.join('\n');
  }

  // 预览基础样式：以 .md-body 作用域，iframe 与主文档编辑预览面板共用
  var markdownCss = [
    '.md-body{color:#24292f;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;word-wrap:break-word;}',
    '.md-body h1,.md-body h2,.md-body h3,.md-body h4,.md-body h5,.md-body h6{margin:1.4em 0 .6em;font-weight:600;line-height:1.3;}',
    '.md-body h1{font-size:1.9em;padding-bottom:.3em;border-bottom:1px solid #eaecef;}',
    '.md-body h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid #eaecef;}',
    '.md-body h3{font-size:1.25em;}.md-body h4{font-size:1.05em;}.md-body h5{font-size:.95em;}.md-body h6{font-size:.9em;color:#6a737d;}',
    '.md-body p{margin:0 0 1em;}',
    '.md-body a{color:#0969da;text-decoration:none;}.md-body a:hover{text-decoration:underline;}',
    '.md-body code{background:rgba(175,184,193,.28);border-radius:6px;padding:.2em .4em;font-size:.88em;font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;}',
    '.md-body pre{background:#f6f8fa;border-radius:8px;padding:14px 16px;overflow:auto;margin:0 0 1em;}',
    '.md-body pre code{background:none;padding:0;font-size:.85em;line-height:1.5;}',
    '.md-body blockquote{margin:0 0 1em;padding:.2em 1em;color:#57606a;border-left:.28em solid #d0d7de;}',
    '.md-body ul,.md-body ol{margin:0 0 1em;padding-left:1.8em;}',
    '.md-body li{margin:.25em 0;}',
    '.md-body li>ul,.md-body li>ol{margin:.25em 0;}',
    '.md-body hr{height:1px;border:0;background:#d0d7de;margin:1.6em 0;}',
    '.md-body img{max-width:100%;border-radius:6px;}',
    '.md-body table{border-collapse:collapse;margin:0 0 1em;display:block;overflow:auto;}',
    '.md-body table th,.md-body table td{border:1px solid #d0d7de;padding:6px 13px;}',
    '.md-body table th{background:#f6f8fa;font-weight:600;}',
    '.md-body table tr:nth-child(2n){background:#f6f8fa;}',
    '.md-body del{color:#8a8f98;}',
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

  function serializeTable(tbl) {
    var head = Array.prototype.map.call(tbl.querySelectorAll('thead th, thead td'),
      function (c) { return serializeInlineChildren(c).trim(); });
    if (!head.length) return serializeBlocksList(tbl).join('\n\n');
    var rows = [];
    rows.push('| ' + head.join(' | ') + ' |');
    rows.push('| ' + head.map(function () { return '---'; }).join(' | ') + ' |');
    Array.prototype.forEach.call(tbl.querySelectorAll('tbody tr'), function (tr) {
      var cells = Array.prototype.map.call(tr.children,
        function (c) { return serializeInlineChildren(c).trim(); });
      rows.push('| ' + cells.join(' | ') + ' |');
    });
    return rows.join('\n');
  }

  function serializeBlock(el, indent) {
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
      var inner = serializeBlocksList(el).join('\n\n');
      return inner.split('\n').map(function (l) { return l ? '> ' + l : '>'; }).join('\n');
    }
    // P / DIV / 其它：当作一个段落
    return serializeInlineChildren(el).trim();
  }

  function serializeBlocksList(container) {
    var blocks = [];
    var inlineBuf = [];
    var flush = function () {
      if (!inlineBuf.length) return;
      var text = inlineBuf.map(serializeNodeInline).join('').trim();
      if (text) blocks.push(text);
      inlineBuf = [];
    };
    Array.prototype.forEach.call(container.childNodes, function (n) {
      if (n.nodeType === 1 && BLOCK_TAGS.test(n.tagName)) {
        flush();
        var b = serializeBlock(n, '');
        if (b && b.trim()) blocks.push(b);
      } else {
        inlineBuf.push(n);
      }
    });
    flush();
    return blocks;
  }

  // 把（本渲染器产出的）DOM 子树转回 Markdown 文本
  function htmlToMarkdown(root) {
    if (!root) return '';
    var md = serializeBlocksList(root).join('\n\n');
    return md.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim() + '\n';
  }

  // 组装完整 HTML 预览页（供服务端 /api/render-md 使用）
  function renderPage(src, opts) {
    opts = opts || {};
    var title = escapeHtml(opts.title || 'Markdown');
    var body = render(src);
    return '<!doctype html><html lang="zh"><head><meta charset="utf-8" />'
      + '<meta name="viewport" content="width=device-width,initial-scale=1" />'
      + '<title>' + title + '</title>'
      + '<style>html,body{margin:0;background:#fff;}body{padding:32px 40px;max-width:900px;margin:0 auto;}'
      + markdownCss + '</style></head>'
      + '<body class="md-body">' + body + '</body></html>';
  }

  return {
    render: render,
    renderPage: renderPage,
    htmlToMarkdown: htmlToMarkdown,
    markdownCss: markdownCss,
    escapeHtml: escapeHtml,
  };
});
