# 实现任务清单：预览区轻量所见即所得编辑

> 增量推进，每个任务尽量自洽可测。括号内为对应需求编号。
> 约定：先后端能力（可独立测）→ 前端交互 → 一致性收尾。

- [ ] 1. 引入 parse5 依赖与可编辑性规则模块
  - 在 `package.json` 增加 `parse5` 依赖（pin 一个稳定版本），`npm install`
  - 新建 `lib/editable.js`：
    - 导出排除标签集合；列表容器/项规则
    - `assignEids(document)`：对 parse5 文档树做确定性前序遍历（element + text 节点），返回 `eid → node` 映射（同时把 eid 记到 node 上便于回查）
    - `classifyRole(node, ctx)`：文本节点 → 非纯空白且祖先链无排除标签则 `'text'`；元素 → `ul/ol/tbody` 容器为 `'list'`、其直接 `li/tr` 为 `'list-item'`；否则 `null`。实现需求 6.3/6.4 的排除逻辑
  - 验证：对含 `p/混排 <b>/li/ul/script/svg/pre` 的样例 HTML，eid 稳定、文本节点角色判定符合预期（混排的「前/中/后」均判为可编辑文本）
  - _需求: 6.3, 6.4, 2.5, 2.7, 3.1_

- [ ] 2. 实现编辑文档注入接口 `GET /api/edit-doc`
  - 在 `server.js` 加路由：校验 `isPathInScanRoots` + `.html/.htm` + 存在（否则 400/404）
  - `parse5.parse(html, { sourceCodeLocationInfo: true })` → `assignEids` + `classifyRole` → 对列表容器/项追加 `data-atlas-eid`/`data-atlas-role`，对可编辑文本节点原地包裹成 `<span data-atlas-eid data-atlas-role="text">…</span>`（只加 data-*）
  - 计算源文件内容哈希，作为内联 `<meta name="atlas-base-hash">` 注入；`parse5.serialize` 返回，响应头 `no-store`
  - 手测：`curl` 该接口，确认混排文本被独立包裹、列表项带 eid/role、脚本/图表区无 eid
  - _需求: 6.1, 6.2, 6.3, 6.4, 5.4_

- [ ] 3. 实现 ops 应用与忠实写回 `lib/edit-apply.js`
  - `computeOutermost(affectedEids, eidMap)`：归并受影响 eid，剔除「祖先已在集合内」者，得互不嵌套的最外层节点集
  - `applyOps(source, document, eidMap, ops)`：
    - 校验每个 op（eid 存在、角色与操作匹配、reorder.order 是容器现有子项 eid 的排列）
    - 文本节点 setText（不在被重排容器内） → 精确区间替换（该文本节点 `[startOffset, endOffset)`），文本转义 `&`/`<`
    - 列表容器含 reorder（作用域内可能含 setText）→ 在树上应用作用域内 ops 后 `parse5` 序列化子树，替换该节点整段源码区间
    - 按 startOffset 降序拼接所有替换，返回新源码字符串
  - 单测：构造 文本节点 setText / 混排文本独立改 / reorder / 嵌套同改 用例，断言只动目标区间、其余字节不变
  - _需求: 5.1, 5.2, 5.3, 2.5, 2.6, 3.5_

- [ ] 4. 实现备份模块 `lib/edit-backup.js`
  - `backup(absPath)`：拷贝原文件到 `ATLAS_HOME/backups/<basename>-<sha1前8>-<ts>.html`，目录不存在则建
  - 保留最近 N（默认 20）份，超出按时间裁剪
  - _需求: 5.5_

- [ ] 5. 实现保存接口 `POST /api/save-edits`
  - 安全校验：路径在扫描根内、`.html/.htm`、存在；ops 数量与单条文本长度上限
  - 重新读盘算哈希，与请求 `baseHash` 不符 → `409 { error: 'conflict' }`
  - 重解析 → `assignEids` 复原映射 → `applyOps` 得新源码
  - `edit-backup.backup()` → 原子写回（`.tmp` + rename） → 返回 `{ ok, mtime }`
  - _需求: 4.1, 4.6, 5.1, 5.4, 5.5, 6.1, 6.2, 6.5_

- [ ] 6. 未读协同：自我写入抑制
  - `server.js` 维护 `selfWrites: Map<path, mtime>`，`save-edits` 写盘后登记
  - chokidar `change` 回调命中（path 匹配 + mtime 接近）→ 跳过 `delete store.seen[path]` 并消费登记
  - _需求: 7.1, 7.2_

- [ ] 7. 前端：工具栏编辑/保存/取消按钮与状态机骨架
  - `index.html` 在 `.main-actions` 加 `#btn-edit`（默认 disabled）、`#btn-edit-save`、`#btn-edit-cancel`（默认 hidden）
  - `app.js` 注册 `els`，定义 `editState`，`setActiveFile` 里启用 `#btn-edit`
  - 进入/退出编辑模式时切换工具栏：编辑态显示保存/取消，隐藏/禁用 PDF/分享/刷新/未读 等冲突按钮，并加编辑态视觉标识
  - _需求: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 8. 前端：进入编辑模式与可编辑区域绑定
  - `enterEditMode(path)`：有其它未保存编辑先确认；`iframe.src = /api/edit-doc?path=...`；从文档 meta 读 `baseHash`
  - 复用 iframe `load` 分支：注入编辑态样式（data-* 选择器）；对 `span[data-atlas-role=text]` 设 contentEditable + `input` 监听记 setText op + dirty；对 `[data-atlas-role=list]` 容器 `new Sortable`（唯一 group、禁跨容器、animation），`onSort` 记 reorder op + dirty
  - 退出时销毁全部 Sortable 实例、清理监听
  - 空文档（无可编辑区域）→ 进入但提示「没有可编辑的文案或列表」
  - _需求: 1.6, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.6_

- [ ] 9. 前端：hover 可编辑标识样式
  - 注入到 iframe 的样式字符串：`[data-atlas-role=text]:hover` 柔和强调描边 + 轻背景 + text 光标；编辑聚焦态加强；`[data-atlas-role=list-item]` grab 光标 + 拖动握把提示 + 拖动 ghost 高亮；不可编辑区无标识
  - 明暗主题各一套配色，取 Atlas accent
  - _需求: 2.1, 2.2, 3.2_

- [ ] 10. 前端：保存、取消、离开拦截
  - `saveEdit`：无改动→直接退出+提示；否则收集 ops POST；成功→toast+切回 `/raw/`+退出+标已读；409→冲突提示保持编辑态；其它失败→错误 toast 保持改动
  - `cancelEdit`：丢弃 editState，`iframe.src` 切回 `/raw/` 原 url，退出编辑态
  - dirty 时：切换文件 / 刷新预览 / `beforeunload` 确认拦截
  - _需求: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1_

- [ ] 11. 测试：新增 Playwright spec
  - `tests/preview-live-edit.spec.js`：覆盖进入编辑/hover 标识、文案编辑+保存（验磁盘其余字节不变）、**混排内容（`<p>前<b>中</b>后</p>` 的「前/中/后」独立编辑）+保存**、列表重排+保存、取消恢复、不可编辑区域、特殊字符转义、冲突拒绝、未读协同、安全拒绝
  - 用临时 fixture HTML 写入扫描根、跑断言、清理
  - _需求: 全部，验证用_

- [ ] 12. 一致性收尾（项目硬规则）
  - `package.json` test 脚本追加新 spec
  - PUBLISHING.md：步骤 0 spec 清单加一行、底部「已发布版本」预留（发版时填）
  - `.github/workflows/test.yml`：把新 spec 纳入（按其依赖 fixture 的方式）
  - `docs/index.html`：`#features` 加「预览区轻量编辑」特性卡
  - `README.md`：用户视角补一段功能说明
  - _需求: 8.1, 8.2, 8.3_

- [ ] 13. 联调与验收走查
  - 本地 `node bin/atlas.js` 启动，按需求逐条手测；跑全套 spec 确保 0 失败
  - 走查 5.1（其余字节不变）与 5.2（图表不被烤死）这两个关键安全项
  - _需求: 4, 5, 验收_
