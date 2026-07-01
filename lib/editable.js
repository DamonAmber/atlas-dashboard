// 预览区轻量编辑：可编辑性规则 + eid 锚点分配（单一事实来源）
//
// eid（编辑锚点）：对 parse5 解析出的文档树做确定性前序遍历，对每个
// element 与 text 节点按出现顺序编号。注入（/api/edit-doc）与保存
// （/api/save-edits）都对同一份磁盘文件做同一套遍历，得到完全一致的
// eid 映射——这是把预览里的可视编辑映射回源码精确位置的基础。
//
// 编辑粒度是「单个文本节点」，所以混排内容（<p>前<b>中</b>后</p>）里的
// 「前/中/后」是三个独立可编辑单元。
//
// 本模块不依赖 parse5 解析（解析在调用方做），只在 node 树上工作，并提供
// 一个动态 import 的 parse5 加载器（parse5 v8 是纯 ESM，本项目是 CommonJS）。

const crypto = require('crypto');

let _parse5 = null;
async function loadParse5() {
  if (!_parse5) _parse5 = await import('parse5');
  return _parse5;
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

// 排除标签：这些标签自身及其后代里的文本一律不可编辑（风险/动态/结构敏感）
// head/title：不可见且 title 只能含纯文本，套 span 会破坏结构
const EXCLUDE_TAGS = new Set([
  'script', 'style', 'svg', 'canvas', 'textarea', 'input', 'select',
  'button', 'iframe', 'object', 'embed', 'video', 'audio', 'pre', 'code',
  'map', 'math', 'template', 'noscript', 'head', 'title',
]);

// 列表容器 → 其可重排直接子项的标签
const LIST_ITEM_TAG = { ul: 'li', ol: 'li', tbody: 'tr' };

// 卡片组（保守启发式）：把「同构重复的卡片 div」也视为可重排列表
const CARD_TAGS = new Set(['div', 'article', 'section', 'li']);
// 这些容器有自身语义，不参与卡片探测
const CARD_CONTAINER_EXCLUDE = new Set([
  'html', 'body', 'head', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'ul', 'ol', 'dl', 'select', 'optgroup', 'picture', 'colgroup',
]);
const MIN_CARD_COUNT = 3;   // 成组的卡片至少 3 个才算（保守）

function isElement(n) {
  return !!(n && typeof n.tagName === 'string');
}
function isText(n) {
  return !!(n && n.nodeName === '#text' && typeof n.value === 'string');
}
function tagOf(n) {
  return isElement(n) ? n.tagName.toLowerCase() : null;
}
function getAttr(el, name) {
  if (!isElement(el) || !Array.isArray(el.attrs)) return null;
  const a = el.attrs.find(x => x.name === name);
  return a ? a.value : null;
}

// ancestors：从根到当前节点父级的 element 链
function hasExcludedAncestor(ancestors) {
  for (const a of ancestors) {
    if (EXCLUDE_TAGS.has(tagOf(a))) return true;
    const ce = getAttr(a, 'contenteditable');
    if (ce !== null && ce.toLowerCase() === 'false') return true;
  }
  return false;
}

// 列表容器是否满足重排条件：有 ≥2 个对应直接子项
function listContainerItems(el) {
  const itemTag = LIST_ITEM_TAG[tagOf(el)];
  if (!itemTag) return null;
  const items = (el.childNodes || []).filter(c => tagOf(c) === itemTag);
  return items.length >= 2 ? items : null;
}

// 元素的「同构签名」：标签 + 排序后的 class 列表
function classSignature(el) {
  const cls = (getAttr(el, 'class') || '').trim().split(/\s+/).filter(Boolean).sort().join('.');
  return tagOf(el) + '|' + cls;
}

// 卡片组探测（保守）：在容器的直接子元素里，找出现最多的「同标签 + 同 class 签名」
// 的一组，满足以下全部条件才认为是可重排卡片组，返回该组元素数组，否则 null：
//   - 容器不在 CARD_CONTAINER_EXCLUDE 中
//   - 直接子元素 ≥ MIN_CARD_COUNT
//   - 主签名成员数 ≥ MIN_CARD_COUNT
//   - 主签名标签 ∈ CARD_TAGS，且 class 非空（裸 div 不算，避免误判布局容器）
//   - 这组成员在子元素序列里连续（中间不夹其它元素，避免散落同类被误聚）
function cardGroup(container) {
  if (!isElement(container)) return null;
  if (CARD_CONTAINER_EXCLUDE.has(tagOf(container))) return null;
  const elemChildren = (container.childNodes || []).filter(isElement);
  if (elemChildren.length < MIN_CARD_COUNT) return null;

  const counts = new Map();
  for (const c of elemChildren) {
    const sig = classSignature(c);
    counts.set(sig, (counts.get(sig) || 0) + 1);
  }
  let bestSig = null, bestN = 0;
  for (const [sig, n] of counts) if (n > bestN) { bestN = n; bestSig = sig; }
  if (bestN < MIN_CARD_COUNT) return null;

  const sepIdx = bestSig.indexOf('|');
  const tag = bestSig.slice(0, sepIdx);
  const cls = bestSig.slice(sepIdx + 1);
  if (!CARD_TAGS.has(tag) || !cls) return null;

  const idxs = [];
  elemChildren.forEach((c, i) => { if (classSignature(c) === bestSig) idxs.push(i); });
  const contiguous = idxs[idxs.length - 1] - idxs[0] + 1 === idxs.length;
  if (!contiguous) return null;

  return idxs.map(i => elemChildren[i]);
}

// 判定单个节点的编辑角色：'text' | 'list' | 'list-item' | null
// parent：该节点的父节点；ancestors：根→父 的 element 链
function classifyRole(node, parent, ancestors) {
  if (isText(node)) {
    if (!node.value || node.value.trim() === '') return null;   // 纯空白不给编辑
    if (hasExcludedAncestor(ancestors)) return null;
    return 'text';
  }
  if (isElement(node)) {
    const tag = tagOf(node);
    if (EXCLUDE_TAGS.has(tag)) return null;
    if (hasExcludedAncestor(ancestors)) return null;            // 列表也不进风险祖先
    if (listContainerItems(node)) return 'list';
    if (cardGroup(node)) return 'list';                         // 同构卡片组容器
    // 列表项：父是满足条件的容器，且自己属于其可重排子项
    if (parent) {
      const ptag = tagOf(parent);
      if (LIST_ITEM_TAG[ptag] === tag && listContainerItems(parent)) return 'list-item';
      const g = cardGroup(parent);
      if (g && g.includes(node)) return 'list-item';            // 卡片组成员
    }
    return null;
  }
  return null;
}

// 一次遍历：分配 eid、判定角色。注入与保存共用，保证 eid 一致。
// 返回：
//   eidToNode  Array     索引即 eid
//   nodeToEid  Map       node → eid（用于查容器子项 eid、祖先 eid）
//   roles      Map       eid → role（只含有角色的节点）
//   parentEid  Map       eid → 父节点 eid（无父或父无 eid 则 -1）
function analyzeDocument(document) {
  const eidToNode = [];
  const nodeToEid = new Map();
  const roles = new Map();
  const parentEid = new Map();
  const links = new Set();   // <a> 且带 href、不在排除祖先内的 eid（可编辑跳转链接）

  function recurse(node, ancestors, parentNode) {
    const children = node.childNodes || [];
    for (const child of children) {
      let eid = -1;
      if (isElement(child) || isText(child)) {
        eid = eidToNode.length;
        eidToNode.push(child);
        nodeToEid.set(child, eid);
        parentEid.set(eid, nodeToEid.has(parentNode) ? nodeToEid.get(parentNode) : -1);
        const role = classifyRole(child, parentNode, ancestors);
        if (role) roles.set(eid, role);
        if (isElement(child) && tagOf(child) === 'a'
            && getAttr(child, 'href') !== null && !hasExcludedAncestor(ancestors)) {
          links.add(eid);
        }
      }
      if (isElement(child)) {
        recurse(child, ancestors.concat(child), child);
      }
    }
  }
  recurse(document, [], document);

  return { eidToNode, nodeToEid, roles, parentEid, links };
}

function sha1(s) {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

// 深度优先找第一个指定标签的元素
function findFirstElement(root, tag) {
  const stack = [...(root.childNodes || [])];
  while (stack.length) {
    const n = stack.shift();
    if (tagOf(n) === tag) return n;
    if (n.childNodes) stack.unshift(...n.childNodes);
  }
  return null;
}

// 构建「带锚点标注的编辑专用文档」：
//   - 可编辑文本节点 → 原地包裹成 <span data-atlas-eid data-atlas-role="text">
//   - 列表容器/项 → 追加 data-atlas-eid / data-atlas-role 属性
//   - head 注入 <meta name="atlas-base-hash">（供保存时冲突检测）
//   - head 注入 <base href>（让相对资源仍按 /raw/ 路径解析；页面已有 base 则不注入）
// 该文档只用于 iframe 显示与交互，绝不写回磁盘。
// 返回 { html, baseHash }
async function buildAnnotatedDoc(rawHtml, { baseHref = null } = {}) {
  const p = await loadParse5();
  const adapter = p.defaultTreeAdapter;
  const doc = p.parse(rawHtml, { sourceCodeLocationInfo: true });
  const { eidToNode, roles, links } = analyzeDocument(doc);

  // 给元素添加 data-atlas-eid（去重）
  const ensureEid = (node, eid) => {
    if (!node.attrs.some(a => a.name === 'data-atlas-eid')) {
      node.attrs.push({ name: 'data-atlas-eid', value: String(eid) });
    }
  };

  for (const [eid, role] of roles) {
    const node = eidToNode[eid];
    if (role === 'text') {
      const parent = node.parentNode;
      if (!parent || !Array.isArray(parent.childNodes)) continue;
      const idx = parent.childNodes.indexOf(node);
      if (idx < 0) continue;
      const span = adapter.createElement('span', HTML_NS, [
        { name: 'data-atlas-eid', value: String(eid) },
        { name: 'data-atlas-role', value: 'text' },
      ]);
      span.parentNode = parent;
      span.childNodes.push(node);
      node.parentNode = span;
      parent.childNodes[idx] = span;
    } else if (isElement(node)) {
      ensureEid(node, eid);
      node.attrs.push({ name: 'data-atlas-role', value: role });
    }
  }

  // 标注可编辑链接：<a> 上加 data-atlas-link 与当前 href（供前端浮出链接编辑条）
  for (const eid of links) {
    const node = eidToNode[eid];
    if (!isElement(node)) continue;
    ensureEid(node, eid);
    node.attrs.push({ name: 'data-atlas-link', value: '1' });
    node.attrs.push({ name: 'data-atlas-href', value: getAttr(node, 'href') || '' });
  }

  const baseHash = sha1(rawHtml);
  const head = findFirstElement(doc, 'head');
  if (head) {
    const meta = adapter.createElement('meta', HTML_NS, [
      { name: 'name', value: 'atlas-base-hash' },
      { name: 'content', value: baseHash },
    ]);
    meta.parentNode = head;
    head.childNodes.unshift(meta);

    // 注入 base（仅当页面自身没有 base 时），且放在最前，确保相对资源正确解析
    if (baseHref && !findFirstElement(doc, 'base')) {
      const base = adapter.createElement('base', HTML_NS, [
        { name: 'href', value: baseHref },
      ]);
      base.parentNode = head;
      head.childNodes.unshift(base);
    }
  }

  return { html: p.serialize(doc), baseHash };
}

module.exports = {
  loadParse5,
  EXCLUDE_TAGS,
  LIST_ITEM_TAG,
  isElement,
  isText,
  tagOf,
  getAttr,
  listContainerItems,
  classifyRole,
  analyzeDocument,
  buildAnnotatedDoc,
  sha1,
};
