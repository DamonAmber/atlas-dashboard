// 围栏代码块的 info string + 渲染健壮性（回归防线）
//
// 为什么要有这一组：AI 生成的技术文档里，代码块常带「语言 + 附加标注」的
// info string，例如 ```ts type-equiv、```ts cordis-catalog、```js {highlight}。
// 旧的围栏正则 `([^\s`~]*)\s*$` 只认单个词的 info string，遇到带空格的就把
// 整行当普通文本 —— 于是围栏里的 JSDoc「 * xxx」被误判成无序列表项，
// parseList 对这堆畸形「嵌套列表」递归，输入不缩小、层层放大，
// String.replace 被调用十几万次，堆内存冲到 4GB，渲染进程直接 OOM 崩溃。
// 表现给用户就是：某些 .md 一打开整个 Atlas 白屏、服务连不上。
//
// 本 spec 钉住的点：
//   ① 带空格 info string 的围栏被识别成代码块，语言取第一个词，
//      块内内容整体转义、绝不被当 markdown 二次解析（不冒出 <ul>/<li>）
//   ② 单词 info string、```mermaid、~~~ 围栏等原有行为不回归
//   ③ 复刻真实事故文档的结构，必须在时限内渲染完，而不是卡死 / 爆内存
//   ④ 极深嵌套（引用 / 列表）走递归深度上限降级，返回而非拖垮进程
// ③④ 用「子进程 + 超时」跑：万一回归成死循环，能超时报失败，
//     而不是让整个测试进程永久挂起。
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const MD_PATH = path.join(ROOT, 'public/vendor/markdown.js');
const markdown = require(MD_PATH);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      期望 ${JSON.stringify(expected)}\n      实际 ${JSON.stringify(actual)}`}`);
}

// 在受限内存 + 超时的子进程里渲染一段 markdown。
// 返回 { ok, ms }；超时 / OOM / 抛异常都归为 ok:false。
function renderInSubprocess(md, { timeout = 6000 } = {}) {
  const tmp = path.join(os.tmpdir(), `atlas-fence-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, md, 'utf8');
  const driver = `const md=require(${JSON.stringify(MD_PATH)});const fs=require('fs');`
    + `const t=Date.now();md.renderPage(fs.readFileSync(process.argv[1],'utf8'),{title:'t'});`
    + `process.stdout.write('OK '+(Date.now()-t));`;
  try {
    const out = execFileSync('node', ['--max-old-space-size=512', '-e', driver, tmp], {
      timeout, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    const m = /OK (\d+)/.exec(out);
    return { ok: true, ms: m ? +m[1] : -1 };
  } catch (e) {
    return { ok: false, ms: -1, reason: e.killed ? 'timeout' : (e.status === 134 ? 'oom' : 'error') };
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
  }
}

console.log('\n[带空格 info string]');
// 复刻事故文档的最小结构：```ts type-equiv 围栏 + 内部 JSDoc 的「 * 」行
const SPACED = [
  '# 标题',
  '',
  '```ts type-equiv',
  '/**',
  ' * Severity of a record, pre-mapped at capture.',
  ' * `error` for events whose own outcome says so.',
  '   * 深一层缩进的续行，历史上正是它触发了递归爆炸',
  ' */',
  "type Severity = 'info' | 'warn' | 'error'",
  '```',
  '',
  '正文段落。',
].join('\n') + '\n';
const spacedHtml = markdown.renderBody(SPACED);
check('带空格 info string 被识别为代码块', /<pre><code class="language-ts">/.test(spacedHtml), true);
check('块内 JSDoc「 * 」行没有被当成列表', /<ul|<li/.test(spacedHtml), false);
check('围栏语言只取第一个词（type-equiv 不进 class）', /language-ts"/.test(spacedHtml) && !/type-equiv/.test(spacedHtml.match(/class="language-[^"]*"/)?.[0] || ''), true);
// 内容进的是代码块的「整体转义」路径（单引号被转成 &#39;），而不是 markdown 二次解析
check('块内内容被转义原样保留', spacedHtml.includes('type Severity = &#39;info&#39; | &#39;warn&#39; | &#39;error&#39;'), true);
check('另一种真实标注 ```ts cordis-catalog 同样识别',
  /<pre><code class="language-ts">/.test(markdown.renderBody('```ts cordis-catalog\nabstract emit(): void\n```\n')), true);
check('```js {highlight} 这类带花括号标注也识别',
  /<pre><code class="language-js">/.test(markdown.renderBody('```js {1,3-5}\nconst a = 1;\n```\n')), true);

console.log('\n[原有行为不回归]');
check('单词 info string ```js 仍是代码块',
  /<pre><code class="language-js">/.test(markdown.renderBody('```js\nconst a = 1;\n```\n')), true);
check('```mermaid 仍走 mermaid 分支',
  /<pre class="md-mermaid">/.test(markdown.renderBody('```mermaid\ngraph TD\nA-->B\n```\n')), true);
check('无 lang 的 ``` 围栏仍是代码块',
  /<pre><code>/.test(markdown.renderBody('```\nplain code\n```\n')), true);
check('~~~ 围栏 + 带空格 info 也识别',
  /<pre><code class="language-py">/.test(markdown.renderBody('~~~py title=foo\nx = 1\n~~~\n')), true);
check('真正的无序列表不受影响（仍渲染成 <ul>）',
  /<ul>[\s\S]*<li>甲<\/li>[\s\S]*<li>乙<\/li>/.test(markdown.renderBody('- 甲\n- 乙\n')), true);

console.log('\n[渲染健壮性 · 子进程超时防挂起]');
// ③ 复刻事故文档规模的结构：多段带空格 info string 的围栏 + JSDoc
let incident = '# 遥测\n\n';
for (let s = 0; s < 8; s++) {
  incident += '```ts type-equiv\n/**\n';
  for (let l = 0; l < 20; l++) {
    incident += (l % 3 === 0 ? '   * ' : ' * ') + '第 ' + l + ' 行 `code` 说明文字，够长以放大任何回溯。\n';
  }
  incident += ' */\ninterface R { a: string; b: number }\n```\n\n段落 ' + s + '。\n\n';
}
const r1 = renderInSubprocess(incident);
check('事故规模文档在时限内渲染完成（不卡死 / 不 OOM）', r1.ok, true);
if (r1.ok) console.log('      （耗时 ' + r1.ms + 'ms）');

// ④ 极深嵌套引用：应命中递归深度上限降级，而不是无限递归
const deepQuote = '> '.repeat(80) + '深层内容\n';
const r2 = renderInSubprocess(deepQuote);
check('极深嵌套引用被深度上限兜住（返回而非拖垮进程）', r2.ok, true);

// 极深嵌套列表：同样必须收敛
let deepList = '';
for (let d = 0; d < 60; d++) deepList += '  '.repeat(d) + '- 层 ' + d + '\n';
const r3 = renderInSubprocess(deepList);
check('极深嵌套列表被深度上限兜住', r3.ok, true);

console.log('\n========================');
console.log(failures === 0 ? '总计 全部通过' : `总计 ${failures} 项未通过`);
if (failures > 0) process.exit(1);
