# 设计文档：预览区轻量所见即所得编辑

## 概览

核心思路一句话：**用「源码锚点」把预览里的可视编辑映射回磁盘源码的精确位置，只对源码里真实存在且安全的元素开放编辑，保存时只重写被改动的最外层子树、其余字节原样不动。**

这避免了「序列化整个运行时 DOM」会带来的两个致命问题：把图表等 JS 动态内容烤进源码、丢失原文件格式。

### 关键设计决策

1. **服务端注入锚点（eid）**：进入编辑模式时不直接用 `/raw/` 的原始文档，而是请求一份**带锚点标注的编辑专用文档**——服务端解析源文件，给每个源码节点分配 eid，对可编辑的**文本节点**用 `<span data-atlas-eid data-atlas-role="text">` 原地包裹、对列表容器/项注入 `data-atlas-eid`/`data-atlas-role`，再喂给 iframe。这样预览里每个可编辑单元都带着指向源码的稳定编号；JS 运行时注入的节点天然没有 eid，因此天然不可编辑。**编辑粒度是「单个文本节点」**，所以混排内容（`<p>前<b>中</b>后</p>`）里的每段文本都能独立编辑。
2. **保存走精确写回**：前端只回传「操作列表」（按 eid 索引的文本节点修改、列表重排），服务端**重新解析原始源文件**、用相同的确定性遍历复原同一套 eid 映射，对**被改动的最外层节点**做精确区间替换（文本节点）或子树重写（含重排的容器），其余字节不动。
3. **冲突检测**：以「进入编辑时记录的内容哈希」为基准，保存时比对磁盘当前内容，变了就拒绝覆盖。
4. **编辑文档是一次性的**：注入了 eid 的编辑文档（含为交互而加的包裹 `<span>`）只用于 iframe 显示与交互，**永不写回磁盘**；写盘永远基于原始源文件、只动文本节点自身的源码字节。

### 为什么用 parse5

需要一个能给出**源码位置信息（offset）**且 HTML 规范兼容的解析器，才能做到「只动改过的字节」。选用 `parse5`（纯 JS、无原生依赖、Node 生态标准 HTML5 解析器，`sourceCodeLocationInfo: true` 提供每个节点的 startOffset/endOffset 以及 startTag/endTag 位置）。新增依赖 `parse5`。

> 备选：`node-html-parser`（更轻，但位置信息与规范兼容性弱于 parse5）。本设计采用 parse5。

---

## 架构

```
┌─────────────────────────── 浏览器 (localhost only) ───────────────────────────┐
│  app.js                                                                        │
│   ├─ 工具栏：编辑 / 保存 / 取消 按钮 + 编辑模式视觉态                            │
│   ├─ 进入编辑：iframe.src ← /api/edit-doc?path=...（带 eid 的编辑文档）          │
│   ├─ iframe load 后：注入编辑态样式 + 绑定可编辑区域（contentEditable / Sortable）│
│   ├─ 收集操作：opsByEid（setText / reorder）+ dirty 标记                         │
│   └─ 保存：POST /api/save-edits → 成功后 iframe.src ← /raw/...（回到只读预览）   │
└────────────────────────────────────────────────────────────────────────────┘
                                   │ HTTP（非 /share/，中间件已限 localhost）
┌────────────────────────────────── server.js ─────────────────────────────────┐
│  GET  /api/edit-doc   解析源文件→注入 data-atlas-eid/role→返回标注后的 HTML      │
│  POST /api/save-edits 重解析源文件→映射 eid→应用 ops→子树重写拼接→备份→写盘      │
│        ├─ lib/editable.js     可编辑性规则 + eid 遍历 + 注入                      │
│        ├─ lib/edit-apply.js   ops 应用 + 源码区间拼接 + 序列化                   │
│        └─ lib/edit-backup.js  写盘前备份到 ATLAS_HOME/backups/                   │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## eid 锚点：定义与稳定性

- **eid 定义**：对 parse5 解析出的文档树做**确定性前序遍历**，对每个节点（**element 与 text 节点**）按出现顺序编号 `0,1,2,...`，该序号即 eid。element 用于列表角色与祖先/最外层判定，text 节点用于文案编辑锚点。
- **稳定性保证**：注入阶段与保存阶段都读取**同一份磁盘文件**、用**同一套遍历规则**，因此产生完全一致的 eid 映射。中间用户的可视编辑不改变源文件，故映射不漂移。
- **冲突兜底**：注入时计算源文件内容哈希（如 sha1）随编辑文档一并返回；保存请求带上该 baseHash，服务端保存前重新读盘计算哈希，不一致即 409 冲突（需求 5.4）。

---

## 可编辑性规则（单一事实来源：`lib/editable.js`）

对每个节点判定其编辑角色：

### 文本可编辑（`role="text"`，作用于文本节点）

一个**文本节点**可编辑，当且仅当：
- 其文本去除首尾空白后**非空**（纯空白的缩进/换行文本节点不给编辑标识，避免噪音）。
- 其**祖先链中不含任何排除标签**（见下）。

满足条件的文本节点，在编辑文档里被原地包裹成 `<span data-atlas-eid="<该文本节点 eid>" data-atlas-role="text">原文本</span>`，供前端挂 contentEditable。这样：
- 混排内容天然支持：`<p>前<b>中</b>后</p>` 会被包成 `<p><span …>前</span><b><span …>中</span></b><span …>后</span></p>`，三段独立可编辑。
- 不在安全允许名单内、但仍是普通文本容器的元素（如 `<div>` 直接包着文本）其文本节点同样可编辑——因为判定基于「文本节点 + 排除祖先」，而非元素标签白名单，覆盖更全且更自然。

> 保存时**仅替换该文本节点对应的源码字节区间**，元素结构零改动（需求 2.5 / 2.7）。

### 列表容器（`role="list"`）与列表项（`role="list-item"`）

- 容器：`ul`、`ol`（项为直接子 `li`）；`tbody`（项为直接子 `tr`）。容器需有 ≥2 个对应直接子项才有重排意义。
- **同构卡片组（保守扩展）**：对其它容器（排除 `html/body/head/table/thead/tbody/tfoot/tr/ul/ol/dl/select/...` 等语义容器），统计其直接子元素的「同标签 + 同 class 签名」分布，取出现最多的一组；当该组满足「标签 ∈ {div,article,section,li}、class 非空、数量 ≥3、在子元素序列中连续」时，把容器标 `role="list"`、该组成员标 `role="list-item"`。容器内异质子元素（标题/底部）不标记，从而不可拖动。
- 每个列表项带自己的 eid（其内部文本节点仍按文本规则独立可编辑）。
- 嵌套：`li`/卡片内的列表/卡片组仍是独立容器，独立重排（需求 3.5）。
- **写回按 role 识别项**：`edit-apply` 的重排不依赖标签，而是把「直接子元素中 `role=list-item` 的节点」作为可重排项、在其原槽位间重排，非项节点留在原位 → `ul/li`、`tbody/tr`、卡片组三种容器走同一套写回逻辑，异质子元素与缩进格式都保留。

### 排除（风险/不可编辑，需求 6.3 / 6.4）

- 排除标签及其全部后代文本节点不可编辑：`script, style, svg, canvas, textarea, input, select, button, iframe, object, embed, video, audio, pre, code, map, math`。
- 带 `contenteditable="false"` 的元素及其后代。
- 不在源码中的运行时节点：天然无 eid（eid 只在源码解析阶段分配），前端只对带 `data-atlas-*` 的节点绑定交互，故自动排除（需求 3.6 / 6.4）。

> 注入时：列表容器/项只追加 `data-atlas-*` 数据属性（不加 class、不动既有属性）；文本节点用 `<span data-atlas-*>` 原地包裹。两者都只存在于一次性编辑文档，不写盘。包裹 span 仅带 data-* 属性、无 class/style，把对页面自身 CSS 的干扰降到最低（注：极端情况下页面用 `p > 直接文本`/`:first-child` 等选择器可能受 span 影响，属编辑态临时显示问题，不影响保存结果）。

---

## 服务端接口

### `GET /api/edit-doc?path=<abs>`

1. 校验：`isPathInScanRoots(path)`、`.html/.htm`、存在；否则 400/404。
2. 读源文件 → `parse5.parse(html, { sourceCodeLocationInfo: true })`。
3. 前序遍历分配 eid；用 `editable.js` 判定 role；对命中的元素在其 attrs 上追加 `data-atlas-eid` /（必要时）`data-atlas-role`。
4. `parse5.serialize` 回 HTML 字符串返回（`Content-Type: text/html; no-store`）。
5. 响应头或文档内联一个 `<meta>` 携带 `baseHash`（内容哈希），供前端保存时回传。

> 该文档会重排格式（序列化产物），但它只用于编辑显示，绝不写盘，所以无所谓。

### `POST /api/save-edits`

请求体：
```json
{
  "path": "<abs html path>",
  "baseHash": "<进入编辑时的源文件哈希>",
  "ops": [
    { "eid": 12, "type": "setText", "text": "新的纯文本" },
    { "eid": 30, "type": "reorder", "order": [33, 31, 32] },
    { "eid": 41, "type": "setAttr", "name": "href", "value": "https://new" }
  ]
}
```

> `setAttr`（仅 `<a>` 的 `href`）：`analyzeDocument` 额外收集「带 href、不在排除祖先内的 `<a>`」eid 集合（`links`）；注入时给这些 `<a>` 加 `data-atlas-link`/`data-atlas-href`。保存时校验 op.eid ∈ links 且为 `<a>`、name 为 `href`，改写其 `href` 后把该 `<a>` 作为一次子树重写（被列表重排包含时由「最外层节点」归并到容器统一重写）。前端在 `<a>` 内可编辑文字获得焦点时，浮出注入到 iframe 内的链接编辑条，改动记为 `setAttr` op。

流程：
1. 安全校验：路径在扫描根内、`.html/.htm`、存在；请求体大小上限（如 1MB）。
2. 重新读盘，计算哈希；与 `baseHash` 不符 → `409 { error: 'conflict' }`（需求 5.4）。
3. `parse5.parse(..., sourceCodeLocationInfo)` 复原 eid→node 映射与每个 node 的源码位置。
4. 校验每个 op 的 eid 存在、角色与操作匹配（setText 必须命中**文本节点**；reorder 必须命中 `role=list` 容器且 `order` 是其现有子项 eid 的一个排列）。任一不合法 → 400。
5. **计算「最外层被改动节点」集合**：把所有受影响 eid（setText 的目标文本节点、reorder 容器及被移动的子项）归并，去掉「祖先也在集合里」的项，得到互不嵌套的最外层节点集（保证写回区间不重叠）。
6. 对每个最外层节点：
   - 文本节点 setText（不在任何被重排容器内） → **精确区间替换**：用该文本节点的 `[startOffset, endOffset)` 替换为转义后的新文本（最大限度保留原格式）。
   - 列表容器含 reorder（其作用域内可能还有 setText） → **子树重写**：在解析树上对该容器应用其作用域内的全部 ops（按 order 重排 children、改后代文本节点值），`parse5` 序列化该子树，替换源文件中该节点的整段源码区间。
7. 把所有「(startOffset, endOffset, replacement)」按 startOffset 降序拼接进原始字符串（互不重叠，安全）。
8. 备份原文件到 `ATLAS_HOME/backups/`（`edit-backup.js`），再原子写回（写 `.tmp` 再 rename）。
9. 标记自我写入（见「未读协同」），返回 `{ ok: true, mtime }`。

文本转义：写回文本节点内容时转义 `&` `<`（`>` 保守也转），保证不破坏结构（需求 2.6）。reorder 仅搬运已有源码片段，无注入风险。

### 新增 lib 模块

- `lib/editable.js`：`assignEids(document)` + `classifyRole(node, ctx)`（遍历分配 eid、判定文本节点/列表角色、返回 eid→node 映射）、排除标签集合常量。注入与保存复用同一套逻辑，保证 eid 映射一致。
- `lib/edit-apply.js`：`computeOutermost(eids, map)`、`applyOps(source, doc, eidMap, ops)` → 返回新源码字符串。
- `lib/edit-backup.js`：`backup(path)` → 拷贝到 `ATLAS_HOME/backups/<basename>-<sha1前8>-<ts>.html`，并裁剪到最近 N（如 20）份。

---

## 前端设计（`public/app.js` + `index.html` + `styles.css`）

### 工具栏

`index.html` 在 `.main-actions` 增加：
- `#btn-edit`（编辑，默认 disabled，`setActiveFile` 里启用）。
- `#btn-edit-save`（保存）、`#btn-edit-cancel`（取消），默认 `hidden`，仅编辑模式显示。

`els` 注册这三个按钮；编辑模式下隐藏/禁用 `btn-export-pdf / btn-share / btn-reload-preview / btn-mark-unread` 等冲突操作（需求 1.3）。

### 状态

```js
const editState = {
  active: false,        // 是否在编辑模式
  path: null,           // 正在编辑的文件
  baseHash: null,       // 进入编辑时源文件哈希
  dirty: false,         // 有无未保存改动
  ops: new Map(),       // eid → op（setText 覆盖式；reorder 覆盖式）
  sortables: [],        // 已创建的 Sortable 实例（退出时销毁）
};
```

### 进入编辑（`enterEditMode`）

1. 若有其它未保存编辑 → 先确认。
2. `iframe.src = '/api/edit-doc?path=' + encodeURIComponent(path)`，从返回文档的内联 meta 读取 `baseHash`。
3. iframe `load` 后（复用现有 load 监听分支）：
   - 注入**编辑态样式**（类似 `injectHighlightStyle` 的方式，用 `data-atlas-*` 选择器，不污染页面）。
   - 对每个 `span[data-atlas-role="text"]`（包裹的文本节点）：设 `contentEditable=true`、`spellcheck=false`；监听 `input` → 记 `ops[eid] = {type:'setText', text: el.textContent}`、置 dirty。
   - 对每个 `[data-atlas-role="list"]` 容器：`new Sortable(container, { group: '本容器唯一', animation: 150, ... })`，`onSort` → 读取容器内子项当前 eid 顺序，记 `ops[containerEid] = {type:'reorder', order:[...]}`、置 dirty。用唯一 group + 禁止跨容器，保证「只在同一容器内重排」（需求 3.3）。
4. 工具栏切到编辑态。

### Hover 可编辑标识（需求 2.1，优雅但明显）

注入到 iframe 的样式（仅作用于带 role 的元素）：
- `[data-atlas-role="text"]`：hover 时柔和强调色虚线/实线描边（如 `outline: 1.5px solid var(accent)` 等价色，2px 圆角 outline-offset）+ 极轻背景（`rgba(accent, .06)`）+ `cursor: text`；聚焦编辑时描边变实、稍强。
- `[data-atlas-role="list-item"]`：hover 显示 `cursor: grab`、左侧出现一个轻量拖动握把提示（`::before` 小圆点/grip），拖动中 `cursor: grabbing` + 占位高亮（复用 Sortable 的 ghost class 样式）。
- 不可编辑区域：无任何 role → 不命中上述选择器 → 无标识、`cursor` 默认（需求 2.2）。

颜色取 Atlas 既有 accent（蓝紫），明暗主题各给一套，保证「明显但不刺眼」。

### 取消（`cancelEdit`，需求 4.3）

丢弃 `editState`，`iframe.src` 切回 `/raw/` 原 url（因为所有改动只在编辑文档的 DOM 里、未写盘，重载即恢复），退出编辑态。

### 保存（`saveEdit`，需求 4）

1. 无改动 → 直接退出 + 提示「没有改动」（需求 4.4）。
2. 收集 `ops` → `POST /api/save-edits {path, baseHash, ops}`。
3. 成功：toast 成功，`iframe.src` 切回 `/raw/`（展示磁盘结果），退出编辑态，本地把该文件标已读（需求 7）。
4. 409 冲突：提示「文件已被外部修改，请刷新后重试」，保持编辑态。
5. 其它失败：错误 toast，**保持编辑态与改动**（需求 4.6）。

### 离开拦截（需求 4.5）

`dirty` 为真时：切换文件 / 刷新预览 / 关 tab（`beforeunload`）前 confirm 拦截。

---

## 未读协同（需求 7）

保存写盘会触发 chokidar `change` → 现逻辑 `delete store.seen[path]` 把文件标未读。处理：
- 服务端维护一个短期「自我写入抑制表」`selfWrites: Map<path, mtime>`；`save-edits` 写盘后登记。chokidar `change` 回调里若命中（路径匹配且 mtime 接近）→ 跳过删除 seen，并消费该登记。
- 前端保存成功后也对该 path 调 `/api/seen`（已有接口）兜底标已读。

---

## 安全（需求 6）

- `/api/edit-doc` 与 `/api/save-edits` 不在 `/share/` 前缀下 → 现有按来源 IP 分流的中间件**自动只允许 localhost**，LAN 直接 403。
- 双重校验路径：`isPathInScanRoots` + 扩展名 + 存在性。
- 请求体 `express.json({ limit })` 已有 4mb；`save-edits` 内再对 ops 数量/单条文本长度设上限。
- 写回只做「文本转义替换」与「已有源码片段搬运」，无任意 HTML 注入面。
- 备份在 `ATLAS_HOME` 下，不污染扫描根。

---

## 边界与已知限制（v1）

- **编辑粒度是文本节点**：`<p>前<b>中</b>后</p>` 的「前」「中」「后」是三个独立可编辑单元，分别就地编辑、分别写回各自的源码区间。不支持「跨文本节点的连续选区编辑」（如同时把「前…后」当一段改），但实际改文案场景里逐段改即可。
- **列表重排支持 `ul/ol/li`、`tbody/tr` 与「同构卡片组」**（同标签+同 class、≥3、连续）；更松散的「重复 div」（无 class、不足 3 个、被异质元素打断）有意不识别，避免误判布局容器。拖拽从可编辑文本上按下不触发（Sortable `filter`），保证卡片内文字仍可正常选择编辑。
- **子树重写会规整被重排容器的内部缩进**：仅限被 reorder 的容器其内部格式可能规整化；纯文本节点 setText 用精确区间替换不影响格式；未触及区域永远原样字节不变。
- **同一保存批次内的嵌套同改**由「最外层节点」归并处理，区间不重叠，安全。
- **编辑态包裹 span 的 CSS 影响**：极端情况下页面若用 `p > 直接文本节点` 相关或 `:first-child`/`:nth-child` 选择器，包裹 span 可能令编辑态显示略有偏差；这是一次性编辑文档的临时现象，不影响保存到磁盘的结果（保存基于原始源文件）。

---

## 测试策略（需求 8）

新增 `tests/preview-live-edit.spec.js`（Playwright，依赖本地 :4321 + 临时 fixture HTML 写入某扫描根）：

1. 进入编辑模式：工具栏出现保存/取消、编辑态视觉；可编辑文本 hover 有标识。
2. 文案编辑 + 保存：磁盘文件内容里对应文本被更新，且 `<head>`/脚本等其它字节不变。
3. 列表重排 + 保存：磁盘里 `<li>` 顺序按拖动结果更新。
4. 取消恢复：改了不保存点取消，磁盘文件零变化、预览回到原状。
5. 不可编辑：`<pre>`/`<code>`/含 `<script>` 的图表节点等无 role、无 hover 标识、不可编辑。
6. 特殊字符：输入含 `<`/`&` 的文本保存后文件结构不坏、转义正确。
7. 冲突：进入编辑后从外部改文件再保存 → 收到冲突拒绝、文件未被覆盖。
8. 未读协同：保存后该文件不被标未读。
9. 安全：`save-edits` 对扫描根外路径/非 html 拒绝。

落地后同步：`package.json` test 脚本、PUBLISHING.md 步骤 0 spec 清单、`.github/workflows/test.yml`、`docs/index.html` 特性卡、README（用户视角）。

---

## 涉及文件清单

新增：
- `lib/editable.js`、`lib/edit-apply.js`、`lib/edit-backup.js`
- `tests/preview-live-edit.spec.js`

修改：
- `server.js`（两个新路由、自我写入抑制、引入新 lib）
- `public/index.html`（编辑/保存/取消按钮）
- `public/app.js`（编辑模式状态机、注入、Sortable、保存/取消/拦截）
- `public/styles.css`（工具栏编辑态 + 注入到 iframe 的编辑样式字符串）
- `package.json`（新增 `parse5` 依赖 + test 脚本追加）
- `docs/index.html`、`README.md`、`PUBLISHING.md`、`.github/workflows/test.yml`（文档/测试一致性）
