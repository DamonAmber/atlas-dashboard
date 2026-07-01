// 把前端回传的编辑操作（ops）忠实写回源码字符串。
//
// 核心策略：在 parse5 解析树上就地应用 ops（改文本节点值、重排列表子项），
// 然后只对「被改动的最外层、且有源码位置的节点」做 outerHTML 序列化并按源码
// 区间拼接，其余字节原样不动。这样：
//   - 不序列化整个运行时 DOM（用的是磁盘源文件解析树，无 JS 注入内容）
//   - 未触及区域保持原字节
//   - 嵌套同改由「区间包含」归并到最外层，替换区间互不重叠
//
// ops:
//   { eid, type:'setText', text:'新文本' }
//   { eid, type:'reorder', order:[childEid, ...] }   // order 是容器现有子项 eid 的一个排列

const { isElement, isText, tagOf } = require('./editable');

// 自身或最近的、带有效 sourceCodeLocation 的祖先（tbody 合成节点 → 提升到 table）
function nearestLocated(node) {
  let n = node;
  while (n) {
    const loc = n.sourceCodeLocation;
    if (loc && Number.isInteger(loc.startOffset) && Number.isInteger(loc.endOffset)) return n;
    n = n.parentNode;
  }
  return null;
}

class InvalidOpsError extends Error {
  constructor(msg) { super(msg); this.code = 'INVALID_OPS'; }
}

// 在树上应用一个 reorder：仅把「列表项」（role=list-item 的直接子元素）在其原有
// 「槽位」间重排，非列表项节点（标题/底部元素、缩进文本、注释）留在原位 →
// 最大限度保留缩进与异质子节点。items 由 role 判定，故 ul/li、tbody/tr、卡片组通用。
function applyReorder(container, order, nodeToEid, roles) {
  const children = container.childNodes || [];
  const slotIdx = [];
  const itemByEid = new Map();
  children.forEach((c, i) => {
    const eid = nodeToEid.get(c);
    if (eid !== undefined && roles.get(eid) === 'list-item') {
      slotIdx.push(i);
      itemByEid.set(eid, c);
    }
  });
  const curEids = [...itemByEid.keys()];
  const valid = Array.isArray(order)
    && order.length === curEids.length
    && new Set(order).size === order.length
    && order.every(e => itemByEid.has(e));
  if (!valid) {
    throw new InvalidOpsError('reorder.order 不是该列表子项的合法排列');
  }
  const newItems = order.map(e => itemByEid.get(e));
  slotIdx.forEach((idx, k) => { children[idx] = newItems[k]; });
}

// 主入口：返回新的源码字符串。doc 为对 source 解析（sourceCodeLocationInfo）得到的树，
// analysis 为 editable.analyzeDocument(doc) 的结果，parse5 为已加载的 parse5 模块。
function applyOps(source, doc, analysis, ops, parse5) {
  const { eidToNode, nodeToEid, roles, links } = analysis;
  if (!Array.isArray(ops)) throw new InvalidOpsError('ops 必须是数组');

  const changedNodes = [];

  for (const op of ops) {
    if (!op || typeof op.eid !== 'number') throw new InvalidOpsError('op.eid 非法');
    const node = eidToNode[op.eid];
    if (!node) throw new InvalidOpsError(`eid ${op.eid} 不存在`);

    if (op.type === 'setText') {
      if (!isText(node) || roles.get(op.eid) !== 'text') {
        throw new InvalidOpsError(`eid ${op.eid} 不是可编辑文本节点`);
      }
      if (typeof op.text !== 'string') {
        throw new InvalidOpsError(`eid ${op.eid} 的 text 非字符串`);
      }
      node.value = op.text;
      changedNodes.push(node);
    } else if (op.type === 'reorder') {
      if (!isElement(node) || roles.get(op.eid) !== 'list') {
        throw new InvalidOpsError(`eid ${op.eid} 不是可重排列表容器`);
      }
      applyReorder(node, op.order, nodeToEid, roles);
      changedNodes.push(node);
    } else if (op.type === 'setAttr') {
      // 仅支持编辑 <a> 的 href（可编辑跳转链接）
      if (op.name !== 'href') {
        throw new InvalidOpsError(`不支持编辑属性 ${op && op.name}`);
      }
      if (!isElement(node) || tagOf(node) !== 'a' || !(links && links.has(op.eid))) {
        throw new InvalidOpsError(`eid ${op.eid} 不是可编辑链接`);
      }
      if (typeof op.value !== 'string') {
        throw new InvalidOpsError(`eid ${op.eid} 的 href 非字符串`);
      }
      const existing = node.attrs.find(a => a.name === 'href');
      if (existing) existing.value = op.value;
      else node.attrs.push({ name: 'href', value: op.value });
      changedNodes.push(node);
    } else {
      throw new InvalidOpsError(`未知 op.type: ${op && op.type}`);
    }
  }

  if (changedNodes.length === 0) return source;

  // 每个被改节点 → 最近的可定位节点
  const located = [];
  for (const n of changedNodes) {
    const r = nearestLocated(n);
    if (!r) throw new InvalidOpsError('改动节点找不到源码位置');
    located.push(r);
  }

  // 去重 + 丢弃「区间被另一节点区间包含」者，得到互不重叠的最外层重写根
  const uniq = [...new Set(located)];
  const roots = uniq.filter((n) => {
    const a = n.sourceCodeLocation;
    return !uniq.some((m) => {
      if (m === n) return false;
      const b = m.sourceCodeLocation;
      return b.startOffset <= a.startOffset && a.endOffset <= b.endOffset;
    });
  });

  // 生成替换区间，按 startOffset 降序拼接（互不重叠，安全）
  const repls = roots.map((n) => ({
    start: n.sourceCodeLocation.startOffset,
    end: n.sourceCodeLocation.endOffset,
    rep: parse5.serializeOuter(n),
  }));
  repls.sort((a, b) => b.start - a.start);

  let out = source;
  for (const r of repls) {
    out = out.slice(0, r.start) + r.rep + out.slice(r.end);
  }
  return out;
}

module.exports = { applyOps, nearestLocated, InvalidOpsError };
