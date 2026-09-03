# Atlas 发版流程

> ⚠️ **这是 AI 与人类共同维护的标准流程文档**。
>
> - 任何流程变更（新工具、新步骤、新自动化、新 hook）**必须同步更新本文档**。
> - 下次发版时如果发现本文档与实际不符，**先修文档再发版**。
> - 这是约束，不是建议。

> 📌 **「发版」的口径（用户约定，2026-09-03 起）**：当用户说"发版 / 发布"，默认指
> **npm + macOS DMG + 官网 三者一起同步更新**，不是只发 npm。一次完整发版 =
> `npm publish` + 打 tag（触发 GitHub Release）+ 出 **DMG / zip / latest-mac.yml** 传到 Release
> （见[桌面 App 章节](#桌面-appmacos-dmg发版)）+ landing page 随 `docs/` push 自动部署。
> 三条渠道缺任一条都算没发完。（唯一例外：用户明确说"只发 npm / 先不出 DMG"时才拆开。）

仓库：https://github.com/DamonAmber/atlas-dashboard
npm：https://www.npmjs.com/package/atlas-dashboard

---

## 目录

- [TL;DR — 标准发版命令序列](#tldr--标准发版命令序列)
- [前置检查（每次发版前）](#前置检查每次发版前)
- [决定版本号](#决定版本号)
- [详细发版步骤](#详细发版步骤)
- [自动化（你不用管）](#自动化你不用管)
- [验证发版成功](#验证发版成功)
- [故障排查](#故障排查)
- [紧急回滚](#紧急回滚)
- [一次性环境配置](#一次性环境配置)
- [给未来 AI / 自己的话](#给未来-ai--自己的话)
- [已发布版本](#已发布版本)

---

## TL;DR — 标准发版命令序列

适用：你已经做完代码改动 + 跑过测试 + 改过 `PUBLISHING.md` 加了新版描述。

```bash
cd ~/Documents/AIProjects/Atlas

# 1. 升版本号（手动改 package.json，或用下面的 node 一行）
NEW_VERSION="0.x.y"   # 替换成实际新版本号
node -e "const p=require('./package.json'); p.version='$NEW_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n');"

# 2. 看清单（不真发）
npm publish --dry-run

# 3. commit + push 到 GitHub（CI 自动跑测试）
git add <改动的文件>          # 别用 -A，避免把 tgz / 临时脚本带进去
git commit -m "feat/fix: <一句话描述本版改动>"
git push

# 4. 等 CI 绿（publish 是不可逆的，绿灯之后再发）
gh run watch                  # 或 gh run list --limit 1

# 5. 真发布到 npm（已配 token，免 OTP）
npm publish

# 6. 验证 registry 同步
npm view atlas-dashboard version

# 7. 创建并推送 tag → 自动触发 GitHub Release workflow
git tag "v$NEW_VERSION"
git push origin "v$NEW_VERSION"

# 8. 升级本机的全局 atlas（让未来发版时 update-check 基准是新版）
npm install -g atlas-dashboard@latest
atlas --version   # 应显示新版本号
atlas restart     # 让本机服务也用新版
```

发完之后**必看**：[验证发版成功](#验证发版成功) 章节确认 4 项绿。

> **为什么是「先 push，再 publish，最后 tag」**（0.14.0 起改成这个顺序）：
> 三步里只有 `npm publish` 不可逆（24h 外只能 deprecate，版本号永久占用），
> 所以要把它排在能反悔的步骤之后、并且拿到 CI 绿灯再按。
> 早先的顺序是 publish 在 push 之前，风险是**发完包才发现推不上去**
> （git 凭据过期、CI 红、本地有没提交干净的东西）——那时 npm 上就有了一个
> GitHub 上找不到对应代码的版本，只能靠再发一个补丁号收场。
> 唯一的硬约束是 **tag 必须在 publish 之后**：tag 触发的 Release 说明里带
> `npmjs.com/package/atlas-dashboard/v/<版本>` 链接，包还没上架就是一条坏链。

---

## 前置检查（每次发版前）

```bash
# 你必须能给出"是"的几个问题：
git status                          # 工作区干净？
git rev-parse --abbrev-ref HEAD     # 当前在 main 分支？
gh auth status                      # gh CLI 已登录？
npm whoami                          # npm 已登录？(应输出 d4monwang)
grep authToken ~/.npmrc             # token 已配置？(应输出 1 行)
atlas status                        # atlas 服务在跑？(测试需要)
```

如果任意一项不对，停下来修，不要发版。**唯一的例外是 `gh auth status`**：
`gh` 只用来看 CI 状态和验证 Release，本仓库是 public，这两件事都能用匿名
`api.github.com` 替代（见[步骤 4](#步骤-4commit--push) 与[验证发版成功](#验证发版成功)），
所以它失效不阻塞发版——但**发完要提醒用户重新 `gh auth login`**。

注意 `gh` 和 `git push` 用的是**两套凭据**：`gh` 存在系统 keyring，`git push` 走
`credential.helper`（本机是 `osxkeychain`）。所以 `gh` 红了不代表推不上去，
反之亦然。想在 publish 之前确认 push 权限，最可靠的就是先把 commit 推上去
（这也正是[步骤 4](#步骤-4commit--push) 排在 publish 之前的原因）。

---

## 决定版本号

按 [SemVer](https://semver.org/) 严格执行：

| 类别 | 当前 → 目标 | 触发条件 |
|---|---|---|
| **patch** | `0.3.0` → `0.3.1` | 仅 bug 修复、文案微调、CSS 微调 |
| **minor** | `0.3.x` → `0.4.0` | 新功能、新 CLI 子命令、新 API 端点（向后兼容） |
| **major** | `0.x.x` → `1.0.0` | 破坏性变更（配置 schema / CLI 参数 / 默认行为） |

**有疑问就升 minor**——多发一个版本号比留下混乱便宜。

> 当前版本：见 [已发布版本](#已发布版本) 第一行；或 `node -p "require('./package.json').version"`

---

## 详细发版步骤

### 步骤 0：跑全套测试

**所有 spec 都自起隔离实例，不需要预先起服务，也不会碰你真实的 `~/.atlas` 与文档。**
直接跑即可（跑之前不用 `atlas stop`，跑的时候你正在用的 Atlas 也不受影响）：

```bash
for spec in tests/*.spec.js; do
  echo "=== $spec ==="
  node "$spec" 2>&1 | tail -3
done
```

> 验证过：把本机 Atlas 完全停掉，全套 46 个 spec 依然全绿，且 `~/.atlas/config.json`
> 与 `store.json` 校验和逐字节未变。若将来某个 spec 在服务停止时失败，说明它偷偷依赖了
> 你的真实实例，按下面的约定改掉。

**要求所有 spec 都"失败 0 项"**。任意一个失败必须先修才能发版。

> ⚠️ 两个"假绿"陷阱，看到这两行输出别当成通过：
> - **跑测试前先确认 4400-4799 没有别的 Atlas 在跑**（比如自己开着的调试实例）。
>   隔离实例在这个区间随机取端口，撞上了 `server.js` 会自动切到别的端口，
>   而 helper 探原端口就探到了那个别人的实例 —— 它是健康的，于是 spec 会对着
>   几百篇真实文档跑只有几篇 fixture 的断言，失败信息极具误导性
>   （`空查询时列出全部文档 期望 4 实际 50`）。
>   helper 现在会先探端口是否空闲、再用 `/api/config` 的 `scanRoots` 验明身份，
>   撞上时直接报「端口 N 上应答的不是本实例」而不是让 spec 跑错。
>   调试实例建议监听这个区间之外的端口。
> - `e2e-install.spec.js` 打印 `没有 tgz，先运行 npm pack` 就退出（**exit code 仍是 0**，循环里看不出来）。它需要项目根有 `atlas-dashboard-*.tgz`。跑法：
>   ```bash
>   npm pack >/dev/null && node tests/e2e-install.spec.js | tail -5 && rm -f atlas-dashboard-*.tgz
>   ```
>   期望末行 `总计 10 项，失败 0 项`。**记得删掉 tgz**，否则会被 `git add -A` 带进 commit。
> - `scroll-after-toggle.spec.js` 在 iframe 还没加载出内容时打印 `!! HTML 不够长，没法测试` 并跳过（也是 exit 0）。这是它长期的既有行为，不是本次改动引入的；判断是否回归的办法是 `git stash` 后对比同一行输出。

当前 spec 清单（46 个）。除 `landing-demo`（`file://`）、`diff-algorithm`（纯函数单测）
与 `fs-watcher`（直接对着临时目录测监听器，不起服务、不用浏览器）外，其余都通过
`tests/helpers/isolated-atlas.js` 的 `startAtlas()` 起独立实例：临时 `ATLAS_HOME`
（自带 config/store）+ 临时扫描根 + 临时 fixture + 随机端口，结束即删。
需要"有规模的文档树"的用例（帧率 / 滚动 / 拖拽）用 `makeTreeFixtures()` 现造，
不再依赖你本机那几百篇真实文档。

> - `fs-watcher.spec.js` — 目录树监听器（0.19.0 新增，纯 Node、不需要浏览器）：**造 600+ 个目录后 fd 净增 ≤ 2 且此时仍能 spawn**（这是整个模块存在的理由——旧版逐目录挂 watch 会吃掉上万个 fd，越过 Node 的 10240 上限后进程里所有 spawn 都报 EBADF）/ add·change·unlink 三种事件（macOS 上 eventType 永远是 rename，判定全靠 stat）/ **改动盘点期就存在的文件必须报 change 而不是 add**（报错了未读红点就不亮）/ 新建只报一次（父目录事件与文件事件必须合并，否则推两条桌面通知）/ 分段写入只报一次且报出来时内容完整 / depth 与 ignored 过滤（口径与 `walk()` 对齐）/ 整目录 mv 进来要补偿出里面的文档、整目录删除要逐个报 unlink / close 后无事件且 fd 归位（20 项）
> - `rich-render.spec.js` — Mermaid 图表与数学公式（0.18.0 新增）：解析边界（价格 `$5` / `$100 到 $200` 不被当公式、句中 `$$…$$` 不留孤立的 `$`、代码里的 `$` 不算、`\(…\)` 也认）/ 图表渲染成 SVG 且语法错误显示 mermaid 原始报错并保留源码 / 行内与块级公式渲染成 KaTeX / 图表块不再被套代码块头部 / **按需加载**（没有图表公式的文档不下载那 3.5MB）/ 编辑器实时预览同样出图 / **往返保真**（改标题后图表与公式源码逐字节不变）/ 打印版挂上渲染器且主题钉浅色 / 局域网分享页能渲染且 `/vendor/` 对访客放行（39 项）
> - `sandbox-trust.spec.js` — HTML 预览沙箱与信任分级（0.18.0 新增）：默认带 sandbox 且不含 `allow-same-origin`、保留 `allow-scripts`（文档自己的脚本要能跑）/ **沙箱里的文档确实读不到父页面、读不到也写不了 Atlas 接口** / Atlas 自渲染的预览页（md / csv）不被沙箱化 / 点信任后切同源、编辑按钮可用、落盘、刷新后仍有效、可收回 / **写类接口的 Origin 校验**（`null` 与别的站点、本机其它端口一律 403，不带 Origin 的 CLI 放行）（33 项）
> - `plain-formats.spec.js` — CSV / JSON / 纯文本 / SVG（0.18.0 新增）：默认只扫 html+md、勾选后才出现 / **CSV 解析**（引号内的分隔符与换行、`""` 转义、空字段、分号 / Tab 嗅探）/ 数字列右对齐而文本列不、宽表横向滚动层 / JSON 缩进与语法高亮、非法 JSON 报出行列并按原文显示 / SVG 用 `<img>` 引入且里面的脚本不执行 / 只读（编辑禁用）与 SVG 不支持导出 PDF / 全文搜索命中四种格式（svg 只索引标签文字）/ 分享 CSV 返回渲染好的网页而不是让浏览器下载（44 项）
> - `folder-rename-persistence.spec.js` — 一级分组重命名的持久性（0.16.0 新增）：服务端按 `autoFor` 身份键认领而非按名字（改名后 reconcile 仍认得、新文件归进改名后的分组、分组临时变空不丢名字、未改名的自动空壳照旧回收、手工建的空分组不被当空壳清掉、改过名的分组能归档且取消归档后名字回来）；前端两条 race（改名后紧接一次 `fetchState` 不把改动冲掉——直接读 `store.json` 验证落盘的真实内容；编辑进行中不被 `render()` 的 `innerHTML=''` 打断）（24 项）
> - `diff-versions-and-revert.spec.js` — 底本版本历史与回退（0.16.0 新增）：同内容重写不报"有改动"（内容核对，不只看 mtime）/ 内容真变了才报 / 打开文档不再吃掉想看的那次差异 / 只有内容变化才追加版本、反复打开不追加 / 指定版本对比与不存在版本的 404 / 回退（参数校验、磁盘内容、备份里是回退前的内容、不把自我写入标成未读）/ 站内编辑保存后不把自己的改动算成变更 / **`ack` 分界的两个方向**（打开时自动记的底本不当基准，用户点过「标记为已看过」之后就干净了，之后的新改动又能看到）（37 项）
> - `folder-reveal-and-toc-resize.spec.js` — 分组「在访达中显示」+ Markdown 目录栏调宽（0.16.0 新增）：按钮只渲染给带 `autoFor` 的自动分组、`/api/reveal-folder` 的 4 条校验分支（缺参数 / 路径穿越 / 含分隔符 / 目录不存在——**成功路径会真的 spawn `open -R` 弹出文件管理器窗口，故意不进自动化**）；目录栏拖拽与 180~520px 钳制、双击复位、方向键 ±8 与 Shift ±24、`localStorage` 持久化与跨文档保持、收起目录时拖拽条隐藏且正文占满（26 项）
> - `archive-and-collapse-all.spec.js` — 归档口径一致性：归档后 `files` / `tree` / `scannedCount` 同口径、「全部标为已读」一篇不剩（含 mtime 落在未来的文档）、正文搜索不捞归档文档、取消归档后原样回来且仍是未读、底栏统计与首页待看空态；以及「全部折叠 / 全部展开」按钮的两个状态与图标翻转、localStorage 持久化、刷新后保持、筛选态禁用（34 项）
> - `preview-live-edit.spec.js` — 预览区轻量编辑：edit-doc 标注 / 进入编辑 / 文案改+保存 / 列表重排 / 取消恢复 / 冲突 / 安全（32 项）
> - `favorites-and-tags.spec.js` — 收藏与标签：星标点击不误触"打开文档"、不被 SortableJS 当拖拽把手；收藏夹跨文件夹聚合、按收藏时间倒序、可取消、折叠态持久化；顶栏收藏按钮联动；标签去重与大小写合并、超量截断、行上最多 2 个 +N、"取消"不会清标签、清空即删 key；标签筛选条按用量倒序、多选为 AND、与搜索/仅未读正确叠加；重命名后收藏与标签跟随新路径（72 项）
> - `md-render-and-roundtrip.spec.js` — Markdown 渲染与往返保真：`<base href>`（相对图片能加载）/ front matter / 锚点链接不新开标签页 / 任务列表复选框 / 代码块语言标签+复制 / 标题锚点 / 表格横向滚动 / 深色模式；以及所见即所得改一处后源码逐字节保真（表格对齐、段落软换行、块间距都不被顺手改掉）（28 项）
> - `md-editor-ux.spec.js` — Markdown 编辑器交互：`/` 键不再被全局快捷键抢走（设置里能手输绝对路径）/ ⌘B ⌘I ⌘E ⌘K ⌘S / 回车续列表（无序·有序·任务）/ Tab 多行缩进与反缩进 / 格式工具条 / 分栏拖拽与持久化 / 大纲 / 未保存草稿恢复（41 项）
> - `quickopen-a11y-rename.spec.js` — ⌘K 快速打开（模糊匹配 + 键盘导航）/ 弹窗可访问性（Esc 关闭 · role=dialog · 焦点陷阱 · 焦点归还 · 嵌套只关最上层）/ 重命名磁盘文件与 store 状态迁移 + 输入校验（30 项）
> - `md-pdf-export.spec.js` — Markdown 导出 PDF：打印版形态（无目录侧栏 / 无复制按钮 / 配色钉回浅色 / `@page` 页边距）+ 端到端产出非空 PDF + 临时目录清理（21 项，本机没有 Chromium 系浏览器时自动跳过端到端部分）
> - `index-perf-and-search.spec.js` — 文件索引与搜索：索引与磁盘一致 / watcher 增量维护（增·改·删·改名）/ 配置变更重建 / `/api/state` 不再每次重写 store.json / 切换文档类型不重扫 / 多关键词 AND 与引号短语 / 耗时门槛（25 项）
> - `share-security.spec.js` — 局域网分享的安全边界：默认只放行文档引用到的资源、同目录未引用文件 403、显式 `scope=dir` 逃生口、路径穿越、有效期到期 410 与过期条目清理（42 项）
> - `diff-algorithm.spec.js` — 行级 diff 算法单测：上限必须卡在编辑距离而非 N+M、trace 切片边界、大文件性能（33 项，纯函数，不起服务）
> - `diff-view.spec.js` — 和上次已读版本对比：底本生命周期（打开即记录·内容相同去重·数量上限·删文件即清理）/ hunk 与统计 / 上下文行数 / 标记为已看过 / 改名后底本迁移 / 前端面板与编辑态互斥（41 项）
> - `md-sync-highlight.spec.js` — 源码 ↔ 预览的对应区域高亮：行号映射（含 front matter 偏移）、光标所在块标 active、跨块选区把覆盖到的块全标 selected、预览侧点/选时源码画出对齐到行的色带（含软换行折行）、色带随滚动移动、内容变化后映射更新、退出编辑清干净（24 项）
> - `shortcuts-panel.spec.js` — 快捷键速查表：三个入口（? 键 / 侧栏底部按钮 / 首页「全部快捷键」）、打开文档后仍可查、焦点在预览 iframe 内按 ? 也能唤出（经快捷键桥转发）、清单覆盖 7 个场景分组且抽查的键位与代码里注册的一致、输入框里 ? 是输入字符不开面板、Esc 关闭并把焦点还给触发按钮（33 项）
> - `quickopen-content-search.spec.js` — ⌘K 正文搜索：名称命中在前 / 正文命中作为第二组追加且不与名称组重复 / 摘要保留原始大小写并标出关键词 / 命中处数 / 打开后在预览里高亮并滚到第一处、顶栏 n/m 可继续跳 / 换文档后高亮自动失效 / 全程不写侧栏搜索框（不误过滤目录树）/ 单个 ASCII 字符不发请求、中文单字照搜（24 项）
> - `preview-shortcut-bridge.spec.js` — 预览 iframe 内的 app 级快捷键：焦点在文档正文时 ⌘K / ⌘B 仍生效（键盘事件不跨 iframe 冒泡，靠注入桥转发）、编辑态 ⌘S 被拦下并真的触发保存、文档内打字时不抢 ⌘K/⌘B、非编辑态不抢 ⌘S、单键 `/` 一律不转发、iframe 换文档后桥自动重建（18 项）
> - `multi-tab.spec.js` — 多 Tab 文档浏览（0.22 新增）：打开多篇 → 标签栏出现、每篇一枚常驻帧、只有活动帧可见且独占 `id="preview"` / 已开文件再点只切回不重复开 / **切走再切回滚动位置保留**（帧不重载）/ 键盘 Ctrl+Tab 前后切、⌘数字跳转 / 关非活动标签不换视图、关活动标签切到邻居、关到最后一个回首页 / **刷新后恢复标签与活动项**（localStorage）/ 全程无 JS 报错（32 项）
> - `find-in-page.spec.js` — 文档内查找 & 就地退出搜索（0.22 新增）：⌘K 正文命中打开文档后，顶栏命中条的 ✕ 就地清高亮且不弹回首页 / Esc 两级（先清文档内高亮、仍停在文档，再按一次才回首页）/ ⌘F 查找栏 open→输入即高亮+显示 n/m+Enter 跳转+Esc 关闭清高亮、查找打开时顶栏命中条让位（21 项）
> - `modal-close.spec.js` — 每个弹窗的每条关闭路径：✕ 按钮（含精确点在图标 span 上）、遮罩、Esc、关闭后焦点归还、以及"点弹窗内部不会误关"（22 项）
> - `misc-hardening.spec.js` — 杂项加固：编辑备份扩展名跟随源文件 / 请求体上限与可读错误 / `/raw` 路由不依赖 `app._router.stack`（扫描根运行时增删后序号重排仍正确）（26 项）
> - `toast.spec.js` — 扫描根增删与反馈 toast（12 项，含隔离性断言）
> - `inline-edit.spec.js` — 编辑文件名 / 备注（18 项，含隔离性断言）
> - `v0.2-features.spec.js` — 键盘导航 / 最近打开 / 全文搜索（17 项，含隔离性断言）
> - `sse-leak-and-retry.spec.js` — SSE 连接不泄漏（含反向验证）+ `/api/state` 挂起时超时中止并自动重试恢复（13 项）
> - `search-cn-and-highlight.spec.js` — 中文单字搜索 + iframe 内高亮跳转（13 项，fixture 自带含"灯"的长文档）
> - `click-with-jitter.spec.js` — file 点击带抖动仍能打开（5 项）
> - `folder-toggle-with-jitter.spec.js` — folder 头点击带抖动仍能折叠/展开（4 项）
> - `no-sortable-leak.spec.js` — Sortable 实例不累积（5 项）
> - `drag-hover-expand.spec.js` — 拖到折叠 folder 头上 600ms 自动展开（6 项）
> - `drag-stress.spec.js` — 连续随机拖拽不死循环
> - `drag-to-root.spec.js` — 文件拖到根目录不卡
> - `sidebar.spec.js` — 侧边栏开关、宽度、动画（5 项）
> - `scroll-stuck.spec.js` — 拖 resizer 不卡死（8 项，fixture 用长文档）
> - `scroll-after-toggle.spec.js` — 滚动到中间后切侧栏不卡（fixture 用长文档）
> - `sidebar-perf.spec.js` — 帧率门槛（p95 ≤ 25ms / max ≤ 50ms，fixture 造 250 篇。CI 上共享 runner 帧率波动大，设为非阻塞观测）
> - `dir-picker.spec.js` — 浏览器内目录选择器（15 项。`/api/browse` 本身就是列真实文件系统目录的接口，用例会只读地浏览 home 与 `~/Documents`；因 CI runner 的 home 结构不保证，不放进 CI）
> - `landing-demo.spec.js` — landing page demo 交互（28 项，`file://`，连服务都不需要）
> - `e2e-install.spec.js` — npm pack + 模拟陌生用户安装（10 项，自建临时 home 与端口）

> ⚠️ **新写 spec 一律用 `startAtlas()`，不要直连 `:4321`。** 哪怕自认为"只读"也不要——
> 点开一篇文档就会写 store 的 recent 与已读状态，折叠一个分组就会写 tree。
>
> 历史教训：`toast.spec.js` 原先直接改真实 `~/.atlas/config.json`，中断时残留临时扫描根，
> 堆积后让服务重挂 watcher 越来越慢，进而让测试更容易超时失败 —— 恶性循环，
> 最终它长期红着没人当真，而它本该守护的功能（扫描根增删反馈）悄悄退化到 0.7.3 才被发现。
> 另一个例子：`landing-demo` 的拖拽用例曾间歇性失败，真因是 demo 区域在长页面靠下位置
> （y≈1650）而视口只有 900 高，拖拽目标不在视口内、鼠标事件打不到元素，
> 偶尔能过是因为前面的用例碰巧把页面滚到了合适位置 —— 现在拖拽前强制
> `scrollIntoViewIfNeeded()` 并加了"源与目标都在视口内"的前置断言。

### 步骤 1：更新 PUBLISHING.md

在本文档底部 [已发布版本](#已发布版本) 列表**最上方**加一条新版本描述。格式严格匹配：

```markdown
- **<版本号>** (<YYYY-MM-DD>) — <一段 fix/feat 类描述，可含①②③ 编号。具体到改了什么文件、为什么、对用户的影响>。
```

**重要**：必须用 `- **<X.Y.Z>**` 这种格式（前面短横线、版本号用双星号包裹），因为 GitHub Release workflow 用 awk 按这个 pattern 抽取本版变更日志。

### 步骤 1.5：同步 landing page（`docs/index.html`）

**这是约束，不是建议**。任何用户可见的功能改动都必须更新 landing page，否则就是"网页和实际功能不一致"——用户会困惑、抱怨。

按本版改动逐项检查：

- [ ] **加了新功能** → 在 `docs/index.html` 的 `#features` grid 加一张 `.feat` 卡片，或扩充已有卡片的描述
- [ ] **改了 UI 交互**（如新键盘快捷键、新按钮、新视觉态）→ 改对应卡片的 `<p>` 描述
- [ ] **加了新 CLI 子命令** → 改 `#commands` 表格里的命令清单
- [ ] **改了截图相关的 mockup**（`.demo` 区）→ 同步 `docs/index.html` 里 demo 的 mock 数据 / 交互
- [ ] **改了 README 用户视角部分** → 多半 landing page 也要同步
- [ ] **每次发版都要改**：`docs/index.html` 里 `<span id="cur-version">` 的静态兜底版本号。
      页面加载后有段脚本会 fetch npm registry 覆盖它，所以访客看到的是实时版本、很难发现它落后；
      但 [验证发版成功](#验证发版成功) 的第 ④ 项是 `curl | grep` 读 HTML 源码，漏改就会判失败。
      （0.12.0 发版时就漏了这处，发完才由验证 ④ 兜住。）

改完 push 即可（不需要发 npm 新版），GitHub Pages 自动重新部署到 https://damonamber.github.io/atlas-dashboard/

> 这一步**不是事后补**。发版前就要做完。如果发完版才发现网页落后于功能，立即 commit + push 修，并在下次发版的 PUBLISHING.md 描述里说明（"② 同步遗漏的 landing page 文档"）。

### 步骤 2：升 package.json 版本号

```bash
NEW_VERSION="0.x.y"
node -e "const p=require('./package.json'); p.version='$NEW_VERSION'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n');"
node -p "require('./package.json').version"   # 确认
```

> 不用 `npm version patch`，因为它会自动 git commit + tag。我们要分开做，让流程更可控。

### 步骤 3：dry-run 预览

```bash
npm publish --dry-run
```

检查输出：
- `name: atlas-dashboard`
- `version: <新版本>`
- `total files:` 应在 45~50 之间（当前为 48；bin/lib/public/server/README/LICENSE，包含 vendored 前端依赖）。
  0.18.0 起这个数从 23 跳到 47、unpacked 从约 300KB 跳到 5.0MB —— mermaid 与 KaTeX
  （含 20 个 woff2 字体）进了 `public/vendor/`。**这是预期的**，看到 47 不要以为打包出了错。
- 不应含 `tests/`、`data/`、`*.tgz`、`config.json`（这些在 `package.json` 的 `files` 白名单外）

### 步骤 4：commit + push

```bash
git add <改动的文件>   # 逐个列出，别用 -A —— npm pack 留下的 tgz、临时验证脚本
                       # 都可能还在工作区，被顺手带进 commit
git status -s          # 确认改动范围
git commit -m "$(cat <<'EOF'
feat/fix(<scope>): <概括，不超过 72 字符>

<空行>

<主体段，详细说明动机、做法、测试覆盖>
EOF
)"
git push
```

GitHub Actions `tests` workflow 会自动跑（push 触发）。**必须等它绿再进下一步**——
下一步 `npm publish` 是整个流程里唯一不可逆的动作。看状态：

```bash
gh run list --limit 1
gh run watch   # 实时跟随最新 run（可选）
```

> `gh` 登录失效时的替代（本仓库是 public，Actions 与 Release 状态匿名可读）：
> ```bash
> curl -s "https://api.github.com/repos/DamonAmber/atlas-dashboard/actions/runs?per_page=3" \
>   | grep -E '"(name|status|conclusion|head_sha)"' | head -12
> ```

### 步骤 5：真实发布

```bash
npm publish
npm view atlas-dashboard version   # 确认 registry 已同步
```

期望 publish 最后一行是 `+ atlas-dashboard@<新版本>`。

> 当前账号配置了 **Granular Access Token with bypass 2FA**（写到 `~/.npmrc`），所以**不需要 OTP**。如果 token 失效（403）或被撤销，去 https://www.npmjs.com/settings/d4monwang/tokens 重新生成。

### 步骤 6：打 tag → 自动创建 GitHub Release

> **必须在步骤 5 成功之后**：Release 说明里带 npm 版本页链接，包没上架就是坏链。

```bash
git tag "v$NEW_VERSION"
git push origin "v$NEW_VERSION"
```

`release` workflow 在 ~10 秒内自动：
1. 从 `PUBLISHING.md` 用 awk 抽取该版本的描述段
2. 调 `gh release create` 创建 Release
3. body 含变更日志 + npm 链接 + 网站链接 + 安装命令

> ⚠️ **Release body 是推 tag 那一刻 `PUBLISHING.md` 的快照，之后不会自动跟着变。**
> 所以「发完版才想起来补一句本版描述」（比如流程变更、事后发现的遗漏）时，
> 改完 `PUBLISHING.md` 还得手动把 Release 同步一遍，否则两处永久不一致：
> ```bash
> awk -v ver="$NEW_VERSION" '/^- \*\*[0-9]+\.[0-9]+\.[0-9]+\*\*/ { if (found) exit; if ($0 ~ "\\*\\*" ver "\\*\\*") found = 1 } found { print }' PUBLISHING.md > /tmp/notes.md
> # 再按上面 release.yml 的模板补上 npm / 介绍页 / 安装命令那几行尾部
> gh release edit "v$NEW_VERSION" --notes-file /tmp/notes.md
> ```
> 0.14.0 就是这么补的（⑧ 段是发完才加的）。
> 更省事的办法当然是**发版前把描述写完整**。

验证：

```bash
sleep 10
gh release view "v$NEW_VERSION"   # 看 body 是否正确
```

### 步骤 7：本机升级到新版

```bash
npm install -g atlas-dashboard@latest
atlas --version    # 应显示新版本号
atlas restart      # 让本机服务也用新版
```

---

## 自动化（你不用管）

每次发版自动发生的事，列在这里方便调试：

| 触发 | Workflow | 做什么 |
|---|---|---|
| `git push` 到 main | `.github/workflows/test.yml` | CLI smoke + landing demo + e2e install + 21 个隔离 spec（各自起实例，无需预置 fixture 与共享服务）+ 帧率非阻塞观测 |
| `git push origin v*` (tag) | `.github/workflows/release.yml` | 抽取 PUBLISHING.md 该版本段落 → 创建 GitHub Release |
| 任何 push 到 main | GitHub Pages（仓库设置） | 自动重新部署 `docs/` 到 https://damonamber.github.io/atlas-dashboard/ |
| `npm publish` | npm registry | 包上架 + CDN 同步（约 1-2 分钟） |
| 任意时刻已安装的用户 `atlas start/status` | （客户端逻辑 v0.3.0+） | 后台查 npm registry，发现新版即在终端框格提示 |
| 已安装的用户访问 dashboard | （客户端逻辑 v0.3.0+） | 顶栏右侧脉动小标签 + 点击复制升级命令 |

---

## 验证发版成功

发版后必须 4 项都绿才算完成：

```bash
# ① npm registry 已同步
test "$(npm view atlas-dashboard version)" = "$NEW_VERSION" && echo "✓ npm"

# ② GitHub Release 已自动创建
gh release view "v$NEW_VERSION" >/dev/null 2>&1 && echo "✓ GitHub Release"

# ③ tests workflow 通过
LATEST_RUN=$(gh run list --limit 1 --json conclusion --jq '.[0].conclusion')
test "$LATEST_RUN" = "success" && echo "✓ CI tests"

# ④ landing page 已更新（curl 看版本号）
curl -sL "https://damonamber.github.io/atlas-dashboard/?_=$(date +%s)" | grep -q "$NEW_VERSION" && echo "✓ landing page"
```

注意 ④ 需要等 GitHub Pages 重新部署（约 1-2 分钟）。

`gh` 登录失效时，②③ 换成匿名 API（public 仓库可读）：

```bash
# ② Release
curl -s "https://api.github.com/repos/DamonAmber/atlas-dashboard/releases/tags/v$NEW_VERSION" \
  | grep -q "\"tag_name\": \"v$NEW_VERSION\"" && echo "✓ GitHub Release"

# ③ tests workflow
curl -s "https://api.github.com/repos/DamonAmber/atlas-dashboard/actions/runs?per_page=5" \
  | grep -B3 '"name": "tests"' | head -20   # 看最近一条 tests 的 conclusion
```

> ⚠️ **GitHub API 会间歇性返回空响应**，`grep` 不到就会误判成"未创建 / 未通过"。
> 这不限于上面的匿名 curl —— `gh` 自己也会（0.14.0 发版时 `gh run list` 报过
> `Get "https://api.github.com/...": EOF`，`gh run list --json` 也返回过空串）。
> 同一次发版里验证 ② 和 ③ 各误红了一次，重试即绿。
> **判失败前一定要重试 2~3 次**，别急着去查根本不存在的问题。

---

## 桌面 App（macOS DMG）发版

从 0.20.0 起，除 npm 外还分发一个签名 + 公证的 macOS App。npm 流程照旧；DMG 作为 GitHub Release 的资产附上。

**本地出包（推荐，凭据在本机最省事）：**

```bash
# 首次：把签名/公证凭据写进本机 gitignored 文件（模板见 electron/build/notarize.env.example）
#   APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
source electron/build/notarize.env && npm run app:build
# 产物：dist-app/ 下 Atlas-mac-arm64.dmg（人工下载）+ .zip + latest-mac.yml（自动更新）
# ⚠️ electron-builder 只公证并 staple 了 .app，DMG 容器本身没被公证/staple —— 要手动补，见下方「DMG 单独公证」
```

- 需要钥匙串里有 **Developer ID Application** 证书（`security find-identity -v -p codesigning` 能看到）。
- `build.artifactName` 固定为 `Atlas-mac-${arch}.dmg`（不带版本号），所以官网可以用稳定链接
  `https://github.com/DamonAmber/atlas-dashboard/releases/latest/download/Atlas-mac-arm64.dmg`。
- `asar: false` 是刻意的：App 用 `ELECTRON_RUN_AS_NODE` 派生 `server.js`，纯 Node 读不了 asar。
- 验证 App：`spctl -a -vvv --type exec dist-app/mac-arm64/Atlas.app`（应 `accepted / source=Notarized Developer ID`）+
  `xcrun stapler validate dist-app/mac-arm64/Atlas.app`（`The validate action worked!`）。

**DMG 单独公证 + staple（构建之后、上传之前）：** `build.mac.notarize: true` 只会公证 **`.app`**——DMG
是拿已公证的 app 打出来的容器，**它自己没有公证记录**，此时 `xcrun stapler validate <dmg>` 会报
`does not have a ticket stapled to it`、`stapler staple <dmg>` 会报 `Record not found`（因为压根没提交过）。
所以要把 DMG 也提交一次公证再 staple，下载的 DMG 才能离线过 Gatekeeper（app 本身已 stapled，这步是让容器也干净、并对齐本节验收）：

```bash
source electron/build/notarize.env
xcrun notarytool submit dist-app/Atlas-mac-arm64.dmg \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait
# 等到 status: Accepted（约 1-3 分钟）后再 staple
xcrun stapler staple dist-app/Atlas-mac-arm64.dmg
xcrun stapler validate dist-app/Atlas-mac-arm64.dmg   # 应 The validate action worked!
```

> staple 会改写 dmg 文件，`Atlas-mac-arm64.dmg.blockmap` 随之失效——但自动更新走的是 **zip**（不是 dmg），
> dmg.blockmap 只用于 dmg 的差量下载，失配无害，也不需要上传它。zip 没被改动，`latest-mac.yml` 里的 sha512 仍然有效。

**挂到 Release：** 在 npm publish + 打 tag（release workflow 会先建好 Release）之后，把 dmg（人工下载）
以及自动更新要用的 **zip + latest-mac.yml** 传上去（0.21.0 起自动更新依赖后两个，缺了 App 就查不到更新）：

```bash
# ⚠️ 别把两个 ~124MB 的大文件塞进同一条命令：合计 ~248MB，gh release upload 常在 5 分钟超时中断，
#    只留下先传完的小文件（latest-mac.yml）。分开单独传，各自给足时间。
gh release upload "v$NEW_VERSION" dist-app/Atlas-mac-arm64.zip --clobber
gh release upload "v$NEW_VERSION" dist-app/Atlas-mac-arm64.dmg --clobber
gh release upload "v$NEW_VERSION" dist-app/latest-mac.yml --clobber
# 确认三件都在、大小与本地一致：
gh release view "v$NEW_VERSION" --json assets --jq '.assets[] | "\(.name)  \(.size)  \(.state)"'
```

> `latest-mac.yml` 是 electron-updater 的更新清单（列出 zip 名字、大小、sha512）。发版后可跑
> 打包好的 App 验证更新源连通：应对最新 Release 报 `update-not-available`（版本相同即最新）。

**CI（可选）：** `.github/workflows/release-app.yml` 手动触发即可在 GitHub 上出包，
需先配好 mac 签名/公证 secrets（`MAC_CSC_LINK` = base64 的 .p12、`MAC_CSC_KEY_PASSWORD`、
`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`）。导出 .p12：钥匙串里选中
Developer ID Application 证书 → 导出为 .p12 → `base64 -i cert.p12 | pbcopy`。

> 目前只出 arm64（Apple Silicon）。Intel / 通用二进制、Windows、以及 App 自动更新（electron-updater）待后续。

## 故障排查

| 现象 | 原因 / 修复 |
|---|---|
| `npm publish` → 401 Unauthorized | token 过期或被 revoke。重新生成 Granular Token（勾 bypass 2FA），写回 `~/.npmrc`：`npm config set //registry.npmjs.org/:_authToken <new_token>` |
| `npm publish` → **E404 `PUT https://registry.npmjs.org/atlas-dashboard - Not found`** | **同样是 token 失效**，不是包不存在。npm 对无效凭据的 publish 会返回 404 而不是 401（避免泄漏包是否存在）。先跑 `npm whoami` 确认：401 就是 token 问题，按上一行重新生成。注意 `npm publish --dry-run` **不校验凭据**，dry-run 通过不代表能发。<br>快速判定（不打印 token）：<br>`TOKEN=$(node -e "process.stdout.write(require('fs').readFileSync(process.env.HOME+'/.npmrc','utf8').match(/_authToken=(.+)/)[1].trim())")`<br>`curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" https://registry.npmjs.org/-/whoami`<br>200 = token 有效，401 = 该换了。<br>**此时不要 push tag**：Release 说明里会带 npm 链接，npm 上没有对应版本就是坏链。先修 token → publish 成功 → 再 commit/push/tag。 |
| `npm publish` → 403 Two-factor authentication | token 没勾 bypass-2FA。重生成时确保勾上 **"Bypass two-factor authentication when publishing packages"** |
| `npm publish` → `You cannot publish over the previously published versions` | 同一版本号重复发。`npm version` 已经升过版本号，你忘了改 `package.json`。重新 step 2 |
| `gh auth status` → **The token in keyring is invalid** | gh 的 token 过期（和 `git push` 用的 `osxkeychain` 凭据是两套，所以 push 照样能成）。**不阻塞发版**：CI 状态与 Release 验证都能用匿名 `api.github.com` 替代（见[步骤 4](#步骤-4commit--push)、[验证发版成功](#验证发版成功)）。发完让用户自己跑 `gh auth login -h github.com`——OAuth 要开浏览器，AI 代不了。0.14.0 发版时遇到过。 |
| `git push origin v*` 后 release workflow 失败 | 看 `gh run view <run-id> --log-failed`。最常见：PUBLISHING.md 格式不对，awk 抽不到内容。确保版本行格式严格是 `- **X.Y.Z** (...)` |
| 打 tag 前想确认 awk 能抽到本版变更日志 | 本地预演一遍，避免 Release body 落到 fallback 的那一行：<br>`awk -v ver="$NEW_VERSION" '/^- \*\*[0-9]+\.[0-9]+\.[0-9]+\*\*/ { if (found) exit; if ($0 ~ "\\*\\*" ver "\\*\\*") found = 1 } found { print }' PUBLISHING.md \| wc -c`<br>输出远大于 200 字节就说明抽到了正文。 |
| 发完别人 `npm i -g` 装不到 | 等 1-2 分钟 CDN 同步。`npm view atlas-dashboard versions` 看是否已在 registry |
| 发完发现 bug | 见 [紧急回滚](#紧急回滚) |
| tests workflow 失败但本地通过 | 多半是 fixture HTML 不够长 / 不含某关键字。看 `.github/workflows/test.yml` 里 `Prepare fixture HTML files` 那一步，按需调整 |
| `npm pack` → **`EACCES: permission denied, rename '.../_cacache/tmp/...'`**（或 `EEXIST`） | `~/.npm/_cacache` 里有目录属主是 `root`，历史上某次 `sudo npm` 留下的，跟本仓库无关。**不要 `sudo chown` 用户的 npm 缓存**（影响面比这个问题大得多）。用一次性缓存目录绕开就行：`npm pack --cache /tmp/atlas-npmcache`。步骤 0 里给 `e2e-install.spec.js` 备 tgz 时会撞到这个。0.17.1 发版时遇到过。 |
| `xcrun stapler validate <dmg>` → **`does not have a ticket stapled to it`**；`stapler staple <dmg>` → **`Record not found` / `Could not find ... ticket`** | 不是构建坏了。`build.mac.notarize: true` 只公证 `.app`，**DMG 容器没被公证**，所以 staple 找不到票。按「[DMG 单独公证 + staple](#桌面-appmacos-dmg发版)」把 dmg 也 `notarytool submit --wait` 一次再 staple。app 本身其实已 notarized+stapled（`spctl` 显示 accepted），这步是让下载的 dmg 容器离线也干净。0.22.0 发版时遇到并补流程。 |
| `gh release upload` **卡住 / 5 分钟超时中断**，Release 上只挂了 `latest-mac.yml` | 一条命令里塞了两个 ~124MB 的 zip+dmg（合计 ~248MB），超过默认超时。**分开单独上传**（各给足时间），传完用 `gh release view --json assets` 核对三件都在、`size` 与本地 `stat -f %z` 一致。0.22.0 发版时遇到。 |

---

## 紧急回滚

### 24 小时内：直接 unpublish

```bash
npm unpublish atlas-dashboard@<bad-version>
# 这个版本号会被永久占用，不能再 publish 同一个号
# 立即发一个 patch（升号）修复
```

### 超过 24 小时：deprecate + 升号

```bash
npm deprecate atlas-dashboard@<bad-version> "请升级到 X.Y.Z，本版本有 <bug>"
# 然后立即 patch 修复并发新版
```

### GitHub Release 删除

```bash
gh release delete "v<bad-version>" --yes
git push --delete origin "v<bad-version>"
git tag -d "v<bad-version>"
```

---

## 一次性环境配置

只在第一次发版前做一次。

### 1. npm 登录

```bash
npm login --auth-type=web
npm whoami   # 应输出 d4monwang
```

### 2. 配置 Granular Access Token（绕开 2FA，免每次输 OTP）

1. 浏览器打开 https://www.npmjs.com/settings/d4monwang/tokens
2. **Generate New Token → Granular Access Token**
3. 填：
   - **Token name**: `atlas-publish-<machine>`
   - **Expiration**: `365 days`
   - **Permissions → Packages and scopes**: `Read and write`
   - **Select packages and scopes**: 选 `Only select packages I choose`，输入 `atlas-dashboard` 选中
   - ⚡ **关键**：勾选 **"Bypass two-factor authentication when publishing packages"**
4. **Generate Token** → 立刻复制
5. **不要把 token 粘到任何聊天 / 笔记 / 截图里**。直接终端：
   ```bash
   npm config set //registry.npmjs.org/:_authToken <粘贴 token>
   ```
6. 验证：
   ```bash
   grep authToken ~/.npmrc      # 应输出 1 行
   npm publish --dry-run        # 应不报 401/403
   ```

### 3. gh CLI 登录

```bash
gh auth login   # 选 GitHub.com → HTTPS → 浏览器登录
gh auth status  # 应输出 "Logged in to github.com account DamonAmber"
```

token 至少要 `repo`、`workflow` 权限。

### 4. （可选）配 GitHub Repo 启用 Pages

已经做过。如果 fork 此仓库或迁移：

```bash
gh api -X POST repos/<owner>/atlas-dashboard/pages \
  -f 'source[branch]=main' \
  -f 'source[path]=/docs'
```

---

## 给未来 AI / 自己的话

如果你（Claude / 其他 AI / 失忆的我）受用户委托发版：

1. **先读这份文档**，特别是 [TL;DR](#tldr--标准发版命令序列) 和 [前置检查](#前置检查每次发版前)。
2. **不确定时不要发**——问用户具体期望、版本号要不要 patch 还是 minor。
3. **publish 前必须 dry-run** 确认包内容，并且**必须先 commit + push 拿到 CI 绿灯**。
   `npm publish` 是整个流程里唯一不可逆的一步（24h 外只能 deprecate，版本号永久占用），
   把它排在所有能反悔的动作之后。tag 则必须排在 publish 之后。
4. **凭据类东西从不在聊天里贴**：npm token、access token、recovery codes、密码——一律让用户在他自己终端粘贴到 `~/.npmrc` 或环境变量。
5. **发布后必须验证**（[验证发版成功](#验证发版成功) 4 项）。
6. **流程有变化？发完最后必须做的事**：
   - 把新版本加到本文档底部 [已发布版本](#已发布版本)
   - 如果改了发版步骤（新增工具、改了命令、新增自动化等）→ 改对应章节
   - 如果加了新的 spec 文件 → 加到 [步骤 0](#步骤-0跑全套测试) 的 spec 清单（会写状态的必须走 `startAtlas()` 隔离实例，归到 A 类）
   - 如果改了 token / 凭据机制 → 改 [一次性环境配置](#一次性环境配置)
7. **流程出错的话留痕**：在故障排查章节加一行"现象 → 修复"，让下次少踩坑。
8. **不要主动用破坏性命令**（unpublish 24h 外、git tag -d、git push --force 之类）—— 必须先和用户确认。

---

## 已发布版本

> ⚠️ 每次发版**必须**在此列表最上方加一行。GitHub Release workflow 依赖此格式抽取变更日志。
> 格式：`- **X.Y.Z** (YYYY-MM-DD) — <描述>`

- **0.23.0** (2026-09-03) — 一次**整体 UI / 交互升级**（纯前端，`public/` 三件套 + landing/README，未动 `server.js` / `lib` / `electron`）。动机：旧界面是典型的"后台管理系统"骨架——首页四个 KPI 数字方块 + 列表卡、通篇冷灰无彩、几乎无动效，显得死板、模板化。这一版按"有温度的编辑感"方向重做。① **首页重构**（`public/index.html` 的 `#empty-state` + `public/app.js` `renderHome`）：把四个 KPI 方块换成**「今日」英雄区**——一句大标题"今天 AI 改了 N 篇文档"（数字喷品牌渐变、是句子的一部分），配一条**过去 24h 的活动脉冲**（每小时改动数的小竖条）+ 三枚统计 chip；**待看队列铺成彩色封面墙**，最近打开 / 收藏降为底部两条紧凑轨道。旧的 `home-metrics/home-cards/home-unread` 结构与 els 引用一并替换为 `home-hero/home-feed/home-grid/home-rails`。② **生成式封面**（`coverCard`/`hueFor`/`hashStr`）：给每篇文档一张按**项目名哈希出色相**的渐变封面卡（同项目同色系 + 按路径 ±15° 微扰、类型角标、24h 内新鲜的带呼吸红点），不截图、零后端成本；封面 S/L 走 `--cover-*` 令牌按主题两套（⚠️ 踩坑：`light-dark()` 只接受 `<color>`，不能用它切百分比 S/L，否则整条 `hsl()` 失效、封面透明——改用 `prefers-color-scheme` + `[data-theme]` 显式切）。③ **动效系统**（`public/styles.css` 追加）：卡片 `stagger` 错峰浮起入场、封面/按钮弹簧 hover、新鲜未读呼吸、回首页走 `View Transitions` 柔和转场；全部在 `prefers-reduced-motion` 下归零。④ **暖中性皮肤**：⚙ 设置 → 外观与通知 新增「界面色调（冷灰 / 暖灰）」，`[data-skin="warm"]` 只覆盖中性色令牌（浅/深各一套，与主题正交），主色/封面/文档内容不动；`applySkin` + `localStorage` + 顶部内联防闪脚本（同主题机制）。⑤ **图标 hover 重做**：给侧栏头加了品牌渐变后，旧的不透明中性灰 hover 盖在紫调上发脏、突兀——统一改成**半透明品牌色晕染 + 图标转品牌色 + 弹簧微放大**（品牌按钮、侧栏头图标、收侧栏、顶栏工具按钮、更多触发器一致）；logo hover 微微一顶（放大 + 侧倾）。**顶栏收敛**：把低频的"在浏览器打开 / 访达 / 复制路径"收进一个 ⋯「更多」下拉（复用原按钮 id 与监听，点外/Esc 关闭且不误回首页；复制路径改弹 toast）。⑥ **Tab 标签重做**：从"描边 + 单边 accent 线的浏览器 tab"改成 **iOS/macOS 分段控件式胶囊**——未选中纯 ghost 文本、选中是 accent 淡填充的圆角胶囊、无描边；并加一枚**常驻的滑动指示层**（`.tab-indicator`），切换标签时用弹簧曲线从旧标签平滑滑到新标签、宽度一起过渡；`ResizeObserver` 让它在窗口/侧栏改宽时即时跟随。⑦ **设计令牌扩展**：品牌渐变（`--brand-1/2/grad/glow`）、弹簧曲线 `--ease-spring`、封面色相体系、`--fs-hero` 抽成统一来源。⑧ **同步 landing page（步骤 1.5）**：`docs/index.html` 的「首页概览」「深浅色主题」两张特性卡改描述、`#cur-version` 升到 0.23.0；README 的「首页概览」段重写、新增「界面色调」条。⑨ **测试**：全套 spec 全绿；`multi-tab.spec.js` 因滑动指示层做了兼容（指示层放末尾子元素、`position:absolute` + z-index 垫底，`.tab:nth-child` 定位不受影响）；`archive-and-collapse-all.spec.js` 的"首页待看空态"断言从旧的 `#home-unread`/"没有未读文档"更新为 `#home-grid`/"收件箱清空了"（庆祝态）。⑩ **npm 与 App**：纯 `public/` 前端，npm 与 App 都拿得到，但已装的 App 需重新出 **DMG + zip + latest-mac.yml** 才能看到（否则要等自动更新或手动下载）。

- **0.22.0** (2026-09-02) — **App 内多 Tab 浏览文档** + **⌘F 文档内查找**，并修掉 **⌘K 正文搜索"退不出"**。① **多 Tab（核心）**：过去打开第二篇会顶掉第一篇——整个前端围绕单个 `#preview` iframe + 单个 `state.activeFilePath` 构建。现在每篇打开的文档拥有**自己常驻的预览 iframe**，顶部标签栏切换，**切换不重载**（滚动位置、图表、页面内部状态都留得住）。做法：新增 `state.tabs` / `activeTabId` 与一整套 Tab 管理（`public/app.js` 的 openInTab/activateTab/closeTab/removeTab/pruneDeadTabs/renderTabs/reloadTab/persistTabs/restoreTabs 等），让 `els.preview` 始终指向当前活动 Tab 的帧——因此沙箱、快捷键桥、滚动恢复、正文高亮、编辑态等几十处既有代码原样作用到正确的帧上；`state.activeFilePath` 保留为"活动 Tab 的 path"镜像，读它的旧代码不改。**当前活动帧独占 `id="preview"`**（其余帧无 id）作为兼容层，`document.getElementById('preview')` / `#preview` 选择器 / `activeElement.id` 依旧指向"正在看的那篇"。`setActiveFile` 拆成 `markSidebarActive` + `applyActiveDocUI`；`goHome` 改为**非破坏性**（隐藏各帧、不卸载，回首页只是不选中任何 Tab）；`fetchState` 用 `pruneDeadTabs` 关掉文件已消失的 Tab（活动的自动切邻居）；顶层 iframe `load` 监听改为按帧绑定的 `onPreviewFrameLoad`。**持久化**：关掉再开恢复上次的标签与当前项（localStorage，过滤已不存在的文件）。**键盘**：`⌘W` 关、`Ctrl+Tab`/`Ctrl+Shift+Tab` 前后切、`⌘⌥←/→` 切、`⌘1–9` 跳转（`⌘9`=最后一个）。桌面 App 里 `⌘W` 会被默认菜单的"关闭窗口"抢走，故 `electron/main.js` 新增应用菜单接管 `⌘W→close-tab`（IPC 转发前端）、`⇧⌘W` 关窗、`⌃Tab`/`⌃⇧Tab` 菜单项；`electron/preload.js` 暴露 `onMenuCommand`/`closeWindow`。② **⌘F 文档内查找**：预览区右上浮出查找栏（输入+`n/m`+▲▼+✕），只在**当前这一篇**里逐词高亮，`Enter`/`Shift+Enter`/`↑↓` 在命中处间跳，`Esc`/✕ 关闭并清高亮。复用既有 iframe 高亮/导航（`highlightInIframe`/`gotoMatch`）；查找栏打开时命中计数显示在查找栏、工具栏那枚命中条让位隐藏。桌面 App 用自定义"编辑"菜单接管 `⌘F`（默认 Electron 编辑菜单没有 Find，`⌘F` 因此什么都不做），转发 `find-in-page`；浏览器走前端 keydown。沙箱 HTML 读不到内容，提示先点盾牌信任。③ **修 ⌘K "退不出"**：`⌘K` 从"正文命中"进入某篇后会高亮命中并在顶栏显示 `n/m` 命中条，但命中条没有出口、`Esc` 又直接弹回首页——想清掉高亮却留在文档里没有办法。现在给命中条加 **✕**（`clearIframeSearch` 就地清除、不离开文档），`Esc` 改为**分级退出**：关查找栏 → 清空搜索框 → 就地清文档内高亮（`state.search` 为空时）→ 关对比 → 回首页。切 Tab / 回首页会自动关闭查找栏。④ **同步 landing page**（按步骤 1.5）：`docs/index.html` 新增"多 Tab 浏览""⌘F 文档内查找"两张特性卡、"全键盘操作"卡补上 `⌘F`、`#cur-version` 升到 0.22.0；README 同步一句话特性 / Dashboard 功能 / 快捷键表。⑤ **注意 npm 与 App 的差异**：`electron/` 不在 npm 包 `files` 白名单里——多 Tab 与 ⌘F 的**前端**部分（`public/`）npm 与 App 都拿得到，但 `⌘W`/`⌘F` 的**应用菜单接管**只在桌面 App 生效，所以本版**必须重新出 DMG + zip + latest-mac.yml 并传到 Release**，否则客户端用户（以及自动更新）拿不到菜单侧能力。⑥ **测试**：新增 `multi-tab.spec.js`（32 项：打开/去重/切换保留滚动/键盘/关闭切邻居/刷新恢复/回首页）与 `find-in-page.spec.js`（21 项：⌘K 命中后 ✕/Esc 两级退出、⌘F 全流程），均加入 `npm test`；`preview-shortcut-bridge.spec.js` 的取帧改为按 `#preview` 取活动帧（多帧兼容）；`scroll-after-toggle.spec.js` 从"合成 click 打不开文件→静态 #preview 掩盖→静默跳过"改成**真实点击 + 信任 HTML**，现在真正在多 Tab 下验证"切侧栏后滚动不卡"（此前是长期空跑）。全套 44 个 spec 全绿。

- **0.21.2** (2026-09-02) — 重做 **App 图标 / favicon / 菜单栏托盘图 / 应用内品牌 logo**，从原来只有字母「A」的方块换成能一眼看出用途的图形：**一叠汇聚在一起的文档卡片 + 右上未读红点**——正对应 Atlas「把散落各处、AI 生成的文档聚到一处，更新过的标红」这两个核心卖点。① **产物**：`electron/build/icon.icns` 与 `icon-1024.png`（macOS 应用图标，随 DMG 分发，用 `rsvg-convert` 出全尺寸后 `iconutil` 打包）；`electron/build/trayTemplate.png` / `@2x`（菜单栏单色 template 图——单独做的黑白轮廓版，用遮罩把文字行与两卡间隙挖成透明，`setTemplateImage` 下 16px 仍能认出是一叠文档）；`public/favicon.svg`（浏览器标签）。② **应用内品牌标**：`public/index.html` 侧栏 `.brand-mark` 与首页 `.home-logo` 里的字母「A」换成同款内联 SVG（白色堆叠文档 + 红点），`public/styles.css` 加一条 `.brand-glyph { display:block; width:100%; height:100% }` 让图形填满原渐变方块——**渐变底、尺寸、hover/回到首页交互全部不变**。③ **同步 landing page**（`docs/index.html`，按步骤 1.5 的硬性要求）：导航品牌标、产品截图 mockup 的侧栏标、内联 data-URI 兜底 favicon 三处的「A」换成新标识，`docs/favicon.svg` 一并替换，`#cur-version` 兜底版本号升到 0.21.2。④ **纯视觉资源更新**，不涉及任何功能 / API / CLI / 打包行为，全套 spec 全绿（图标不在测试断言范围内，`landing-demo` 也只测 demo 交互不测品牌标文本）。⑤ 所有矢量母版留在 `design/icon/`（`atlas-icon.svg` / `favicon.svg` / `tray.svg` 三个源文件 + 当初的三个概念稿 A/B/C），方便日后调整；旧图标已备份在 `design/icon/_old-backup/`。

- **0.21.1** (2026-09-01) — 在界面里补上**版本号显示**。① 此前 App / Dashboard 里没有直观查看当前版本的地方（只有 npm 的 `atlas --version` 和 macOS 菜单栏「关于」）。现在 **设置面板左侧导航底部常驻一行版本号**（`设置 → 左下角`），桌面版还标注「· 桌面版（自动更新）」。② 实现：`/api/config` 响应加 `version: pkg.version`（前端 `openSettings` 已经在拉这个接口，顺手读出来填进 `#settings-version`，不新增请求）；桌面 App 额外用 `app.setAboutPanelOptions` 让原生「Atlas → 关于 Atlas」也显示版本 + 版权行。③ 纯增量、跨渠道（npm 与 App 都能看到），不影响任何既有行为；全套 spec 全绿。④ 这也是发布后**第一个能被 0.21.0 App 自动更新命中的版本**——装了 0.21.0 的用户会收到"已下载新版本、重启更新"的提示，正好实地验证自动更新链路。

- **0.21.0** (2026-09-01) — 桌面 App 加**自动更新**（`electron-updater` + GitHub Releases）。① **为什么**：桌面用户装了就不该再回终端 `npm i -g`；自升级要在 App 内闭环。② **机制**：`electron-updater` 读本仓库 Release 里的 `latest-mac.yml`，比对版本后**后台下载** zip 更新包，`update-downloaded` 时弹框「立即重启更新 / 稍后」——选稍后则退出 App 时自动装（`autoInstallOnAppQuit`）。启动查一次、之后每 3 小时查一次。只在 `app.isPackaged` 时启用（dev / `npm run app` 没有 `app-update.yml`，直接跳过），任何错误只记日志、不影响使用。③ **产物变化**：mac 目标新增 **zip**（Squirrel.Mac 自动更新走 zip，不是 dmg）——electron-builder 因此会生成 `latest-mac.yml`；**发版时必须把 `Atlas-mac-arm64.zip` 和 `latest-mac.yml` 一并传到 Release**（连同给人手动下载的 dmg）。`electron-updater` 落在 `dependencies`（electron-builder 只打包生产依赖才装得进 App）——npm CLI 用户会多装它但从不加载，属可接受的小体积代价。`build.publish` 显式声明 github 源，`app:build` 改为 `electron-builder --mac --publish never`（本地出全部 mac 目标、不自动上传，上传由发版流程手动做）。④ **App 内屏蔽 npm 升级横幅**：`showUpdateUI` 在 `window.atlasDesktop` 下直接 no-op——那条"复制 npm 命令升级"的提示对 App 用户是错的，改由更新器接管；浏览器 / npm 用户不受影响。⑤ **自动更新的启用时机**：从**本版（0.21.0，第一个带更新器的版本）起**才开始生效——0.21.0 及以后的 App 才会自己检查并升到更新版本；已装 0.20.0 的用户需手动下载一次 0.21.0（或之后任意带更新器的版本），此后即可自动更新。⑥ **验证**：无签名构建确认产出 dmg + zip + `latest-mac.yml` + 内嵌 `app-update.yml`；打包 `--smoke` 启动正常（更新器在旧 Release 缺 yml 时出错但被吞掉、不影响窗口加载）；全套 spec 全绿；发布后跑打包 App 确认对最新 Release 报 `update-not-available`（更新源连通、解析正确）。⑦ 目前仍只 arm64；Intel / 通用二进制、Windows 待后续。

- **0.20.0** (2026-09-01) — 新增**桌面 App（macOS）**这条面向非技术用户的分发渠道，并同步官网。npm 渠道（`atlas` CLI）完全不变，只是多了一种"下载 DMG 双击装"的选择。① **为什么**：`npm i -g` 对不熟悉终端的用户门槛太高（要先装 Node、全程命令行、首次配置也是问答式）。桌面 App 自带运行时、图形化启动，且以独立窗口取代浏览器 tab——顺带绕开了"tab 开多了打不开文档"那个同源连接上限问题。② **架构（`electron/`，不动 `server.js` 与现有测试）**：Electron 外壳复用现有 Node 服务——用 `ELECTRON_RUN_AS_NODE` 以纯 Node 模式派生 `server.js`（不额外打包 Node 运行时），窗口加载 `http://127.0.0.1:<随机端口>`；与 CLI 共用 `~/.atlas` 配置与 store，若已有 `atlas start` 守护进程在跑则直接复用、不起第二个 server（避免两个进程抢写 store.json）。因为派生走纯 Node、读不了 asar，构建刻意设 `asar: false` 让 `server.js`/`lib`/`public`/`node_modules` 以普通文件躺在包里。③ **菜单栏托盘**：单色模板图标（自动适配浅/深色菜单栏）+「打开 / 退出」菜单；mac 习惯——关窗留 dock+托盘、Cmd+Q 才真正退出并收掉自起的 server。④ **PDF 导出改用内置 Chromium 的 `printToPDF`**：不再依赖用户本机装没装 Chrome/Edge。做法是**新增** `POST /api/export-pdf-html`（只复用现有渲染逻辑产出打印版 HTML、不 spawn 浏览器），主进程用隐藏窗口加载后 `printToPDF` 存到 Downloads；**刻意不动**老的 `/api/export-pdf` SSE + `lib/pdf-export.js` 路径——浏览器与 npm 用户照旧走系统 Chromium，`md-pdf-export.spec.js` 零回归。前端 `btnExportPdf` 仅在 `window.atlasDesktop`（preload 暴露的极小桥）存在时才走桌面路径。⑤ **签名 + 公证**：electron-builder 用 Developer ID Application 证书签名、硬化运行时（`entitlements.mac.plist` 放开 `allow-dyld-environment-variables`，否则硬化运行时会拦掉带 `ELECTRON_RUN_AS_NODE` 的子进程）、`notarytool` 公证并 staple，App 与 DMG 都过。产出 `Atlas-mac-arm64.dmg`（固定名，配合 GitHub Release 的 `/latest/download/` 稳定链接）。⑥ **官网 `docs/index.html`**：新增下载区，讲清两种安装方式（下载 DMG / `npm i -g`），DMG 按钮指向 Release 的 latest 下载链接。⑦ **验证**：全套 spec 全绿（未动已发布文件的行为）；桌面侧另验了 `--smoke` 启动、隔离 spawn、签名+硬化运行时下的 spawn、以及 PDF 全链路（合法 `%PDF-`、含 mermaid 图与表格）。⑧ **本版只有 arm64（Apple Silicon）DMG**；Intel/通用二进制与 Windows、以及桌面 App 的自动更新（electron-updater）留待后续。⑨ **发版流程新增**：签名公证凭据放在本机 gitignored 的 `electron/build/notarize.env`（`source` 后 `npm run app:build`），Team ID/证书从钥匙串读；CI 见 `.github/workflows/release-app.yml`（需在仓库配好 mac 签名/公证 secrets）。

- **0.19.2** (2026-09-01) — 修一个反复出现的连接耗尽 bug：**Atlas 开的 tab 一多，新 tab 就打不开文档**（`public/app.js` 的 SSE 生命周期）。① **根因是浏览器的 6 连接上限撞上"每个 tab 一条常驻 SSE"**：每个 Atlas 页面都会向 `/api/events` 开一条长连接接收文件系统事件与升级推送，而浏览器对同源 HTTP/1.1 只给 6 条并发连接。后台开着的 tab 会一直占着各自那条 SSE 不放，于是开到第 6 个 tab 时连接池就满了——新 tab（乃至任何 tab）想拉 `/api/state` 或加载预览 iframe 都排不进队、永久 pending，表现就是"点文档没反应"。代码里其实早有一段注释记着这个 6 连接天花板，之前修的是"一个 tab 内 SSE 重连泄漏多条"（见 `sse-leak-and-retry.spec.js`），这次是不同的另一面：**多个 tab 各自合法地占着一条，加起来照样打满**。② **修法：只让当前可见的 tab 持有 SSE**。新增 `disconnectSSE()`，在 `visibilitychange` 切到后台（`document.hidden`）时主动 `close()` 掉这条连接并作废待重连的 timer，把连接槽还给浏览器；回到前台时若没有连接就重连，并补拉一次 `fetchState()`——补上后台断连期间漏掉的文件系统事件。`onerror` 的重连排程也加了后台守卫：`document.hidden` 时不排重连，统一等回前台由 `visibilitychange` 拉起。这样同一时刻占用连接的 tab 数≈当前可见 tab 数，单窗口下任一时刻只有一个 tab 可见，于是常驻 SSE 永远≈1 条，tab 开再多也打不满连接池，等于没有上限。③ **为什么不改成 SharedWorker 共享一条连接**：那需要把整套重连 / 超时 / 重试逻辑搬进 worker，且会让 `sse-leak-and-retry.spec.js` 里"页面直接 new EventSource、稳态恰好 1 条"这组回归断言全部失效——收益（覆盖"6+ 个窗口拖到不同显示器上同时可见"这种极端场景）远不抵改动面与回归风险。可见 tab 释放连接已经覆盖了正常的单窗口多 tab 使用，那才是用户真正踩到的场景。④ **验证**：全套 44 个 spec 全绿（唯一一次 `preview-live-edit` 的失败是 PUBLISHING.md 记过的满负荷串联偶发、单独连跑两次 32/32，与本版无关）。其中 `sse-leak-and-retry.spec.js` 13 项原封不动通过——前台稳态仍 1 条、error 风暴无泄漏、`/api/state` 挂起超时重试等行为都没变，证明"可见时的连接管理"和以前逐字节一致。另写临时脚本端到端验了新行为：前台 1 条 → 切后台释放为 0 条 → 回前台重连为 1 条 → 反复前后台切换 5 次仍只有 1 条无泄漏，验证后即删。⑤ 纯后台修复、无用户可见 UI 变化，`docs/index.html` 除按「步骤 1.5」惯例更新 `cur-version` 兜底版本号外无需改动。

- **0.19.1** (2026-08-26) — 修 Markdown 表格的列宽：**正文明明还空着一半，单元格里的文字却挤着换行**（都在 `public/vendor/markdown.js`）。① **根因是一条与容器宽度无关的硬上限**：`td { max-width: 34ch }`。34ch 在预览的字号（15px × .94em）下约合 240px、17 个汉字，于是不管正文有多宽，内容列一律在第 17 个字处换行；配套的 `.md-table-scroll table { max-width: none }` 又把容器约束彻底放开，列宽完全由那个固定数字说话。用户截图里那张 7 行 2 列的键值表因此只用掉 445px，右边空掉 375px，而「22 组离线设备聚合数据，覆盖阈值边界、脏数据、超长文本、注入等边缘场景」这种一句话被折成三行。这两行都是 0.17.0 引入的，当时的动机（"免得一句长备注把整张表拉到几千像素宽"）在**表格自己就是滚动容器**的前提下是多余的——`max-width: 100%` 已经封了顶。② **改成两条规则说明列宽，别的都是它们的推论**：`width: max-content`（内容放得下就按自然宽度，窄表不被拉伸成两列各占半页的空表格）+ `max-width: 100%`（上限是**容器**而不是某个数字，超出后浏览器在容器内按各列的内容量重新分配，长文本这才开始换行）。只读预览页那条规则只改 `display` / `overflow`，宽度约束照旧继承，此处的 100% 解析到 `.md-table-scroll` 的宽度、语义没变。同一张表实测 **445px → 724px（正文可用宽度正好是 724）**，内容列换行行数从 `[1,3,2,2,2,1,2]` 降到 `[1,2,1,1,1,2,1]`，剩下两行是真的超过一行宽度。宽表仍然溢出并横向滚动——顶开容器的是各列的 `min-width: 5em`，它的角色从"窄容器兜底"升级成"压到这么窄就该改去滚动"的阈值。③ **长 URL 顶破布局**：`overflow-wrap: break-word` 在表格里等于没写——它**不参与 min-content 尺寸计算**，而列宽正是按 min-content / max-content 分配的，于是一条不可断的长 URL 会把同一行其它列挤成竖排、整张表凭空多出一条横向滚动条。改用 `anywhere`（两者的实际断行行为一样，都优先在正常断点处断，区别只在 intrinsic 尺寸）。但**打印路径必须退回 `break-word`**：那里 `min-width` 归零（纸上没有横向滚动，宽表宁可挤也不能被裁掉右边几列），归零 + anywhere 叠加意味着"`128,304` 可以拆成两行"，表格于是总能压进纸宽、代价是数字和短词被拦腰断开。纸上正确的做法仍是让宽表顶出去、由 `printFitScript` 逐档收紧字号。**这一条是测试抓出来的**：全套里 `md-pdf-export` 的「宽表挂上了收紧 class」变红，实际值 `false`——12 列表不再需要收紧就放得下了，而放得下的方式是断开数字。④ **首列被削到断行**：表格用满宽度之后，浏览器按内容量分配空间，行名列（几个字）在内容列（一句话）面前一路被削到下限，「字段口径依据」断成两行——恰恰是最不该断的那一列。给 `tbody td:first-child` 单独一档 `min-width: 7em`（≈ 7 个汉字，覆盖绝大多数行名；更长的仍然换行，那是它该换）。这个值刻意没动通用的 `5em`：0.17.1 那张 8 列 fixture 表的宽度是按 `5em` 校准的，正好卡在「推荐档溢出、全屏档放得下」这条线上，动它会让那条不变式空转。⑤ **顺带补齐滚动提示的另一侧**：此前只有右缘的渐变遮罩，宽表滚到中间之后左边那几列（往往正是行名列）无声无息地消失，读者会以为表格就是从这一列开始的。加 `::before` + `md-can-scroll-left`，`tableOverflowScript` 的 `syncOne` 一并算左侧（`scrollLeft > 2`，容差与右侧同源）。实测三态正确：初始只亮右、滚到中间两侧都亮、到底只亮左；`.md-table-block` 的 `width: fit-content`（0.17.1 引入）让两侧边缘都贴住可见内容的边缘，实测 gap 0px。⑥ **验证**：全套 44 个 spec / 875 项断言全绿，其中三条既有的表格不变式原封不动地守住了这次改动——12 列宽表仍溢出并出现提示、「遮罩亮 ⟺ 真的还能滚且贴住表格边缘」在三个档位都成立、宽表表头没被压成竖排。另外量化对比了修复前后（表格宽度、每行换行数）并截图核对；编辑器右侧那半边（`display: block` 自身滚动、不能被注入包裹层）单独验过：含长 URL 的窄表从"自身横向滚动"变成正常换行，12 列宽表仍滚动。⑦ 按「步骤 1.5」同步了 `docs/index.html` 的 Markdown 特性卡措辞（原文只说"宽表横向滚动并在右缘给出提示"，现在先讲"列宽先把可用宽度用满，用完了才换行"，再讲两侧提示）。

- **0.19.0** (2026-08-25) — 换掉文件监听后端，修掉一个让**导出 PDF / 在访达中显示 / 自动升级全都失效**的既有 bug（新增 `lib/fs-watcher.js`，`server.js` 的 `createWatcher` 改为调它）。① **症状与根因**：0.18.1 发完在真实实例上验证导出，拿到的不是"变快"而是 `spawn EBADF`；装回 0.18.0 复现，确认是既有问题、与那次修复无关。用探针把线量清楚了——**进程持有 10200 个 fd 时 spawn 正常，10240 起必定 EBADF**（这是 Node 给进程设的 `RLIMIT_NOFILE`；提高 shell 的 `ulimit -n` 没用，试过 1048575 同样在 10240 断）。而本机 Atlas 进程开着 **10356 个 fd，其中 10334 个是普通文件**，全部来自文件监听：**chokidar 4 起移除了 fsevents 依赖、改成逐目录挂 `fs.watch`**，macOS 上每个 watch 都要占一个 kqueue fd，于是 fd 用量正比于目录数——实测监听 `~/Documents/AIProjects`（3598 个目录）净增 **10553 个 fd**，之后进程连 `lsof` 都 spawn 不出来。影响范围不止导出 PDF：「在访达中显示」和自升级也走 spawn，但它们**时好时坏**——fd 数越界而号段有空洞时，能不能拿到低号 fd 是碰运气，所以症状是概率性的、比稳定坏更难查。② **修法**：`fs.watch(root, { recursive: true })` 把递归交给操作系统，**整棵树 0 个额外 fd**。实测本机两个扫描根：**fd 10356 → 27**，导出 PDF 从必然 `EBADF` 变成 2~4 秒出片。③ **这个 bug 为什么能一直藏着：它是 macOS / Windows 特有的**。同一份 chokidar 代码在不同平台的 fd 代价完全不同——macOS 的 kqueue **每个被监视目录占一个真实 fd**（Windows 每个目录一个句柄，同理），而 Linux 的 inotify 用的是 watch descriptor，libuv 让整个事件循环**共享一个 inotify fd**，监听几千个目录也只占那一个（它的天花板是 `max_user_watches`，超了报 ENOSPC，是另一回事）。也就是说 **CI 跑在 Linux 上，永远复现不了这个 bug**，而用户的 mac 上必现——这正是它躲到今天的原因，也提醒一件事：跑在单一平台的 CI 对这类资源问题是盲的。改完之后本次 CI 实测 Linux 下 `fd 22 → 22（净增 0）`、mac 上 `13 → 13`，两边都不再有风险。各平台的路径：macOS / Windows 用内核提供的递归通知（FSEvents / ReadDirectoryChangesW）；Linux + Node 20.13+ 的 recursive 是 Node 在 JS 层逐目录模拟的，但因为上面那个 inotify 特性，fd 依然接近 0；Linux + Node 18/19 与其它平台探测不到 recursive，回退 chokidar，行为与 0.18.x 完全一致。模块导出 `SYSTEM_RECURSIVE` 表示"递归是不是内核给的"，只用来解释性能特征与限定测试里 fd 断言的适用范围。**（第一版的注释和本条描述把 Linux 写成了"fd 占用和 chokidar 没区别"，是错的；CI 日志里那行 `net 净增 0` 当场推翻了它，已改。）**④ **`fs.watch` 缺的四件事都得自己补**，这是本次的主要工作量：**(a) add / change / unlink 的区分**——macOS 上几乎所有事件的 `eventType` 都是 `rename`（连改内容也是，实测确认），所以 eventType 完全不可信，一律靠 stat 判定；判不准时**刻意偏向 change**，因为上层只在 change 时清 `store.seen`（点亮未读红点），把 change 误报成 add 会让"AI 改过这篇"的红点不亮（功能失效），反过来只是桌面通知文案从"新文档"变成"文档已更新"，而清一个本来不存在的 seen 记录是无害的空操作。**(b) 写入稳定期**（chokidar 的 awaitWriteFinish）——AI 流式写文件会连着触发事件，按路径去抖 + 两次 stat 采样一致才认为写完，否则上层会读到半截文档。**(c) ignored / depth 过滤**——原生递归监听没这两个概念，而且它会把 node_modules 里的事件也送过来，所以过滤必须排在 stat 之前、只用字符串判断（一次 npm install 是几万个事件）；depth 的语义与 `walk()` 对齐（root 下直属文件算第 0 层）。**(d) 整目录搬入的补偿**——`mv` 一个已有目录进扫描根**只产生一个目录事件，里面的文件没有独立事件**（实测确认），所以收到目录事件时要扫一遍把没见过的文档补出来；反过来删除整个目录时 FSEvents 会逐个报文件，不需要特殊处理。⑤ **一个踩过的坑**：补偿扫描第一版直接 emit add，结果新建一个文件会先报 add（来自父目录事件的补偿扫描）再报 change（来自文件自己的事件），**用户会收到两条桌面通知**。改成让补偿扫描只把路径塞进同一个 per-path 去抖队列、判定统一由一处做，两条路径就自然合并成一次了。⑥ **测试**：新增 `fs-watcher.spec.js`（20 项，纯 Node、不需要浏览器）。第一组就是这个模块存在的理由——造 600+ 个目录后断言 **fd 净增 ≤ 2 且此时仍能 spawn**（撤掉修复必红）；其余覆盖三种事件、"改动盘点期就存在的文件必须报 change 而不是 add"、分段写入只报一次且报出来时内容完整、depth 与 ignored 过滤、整目录搬入与整目录删除、close 后无事件且 fd 归位。端到端另验了未读红点的完整链路（新建→未读、标已读→改内容→**红点重新亮起**、全文搜索命中新内容、删除→索引移除）与 `/api/reveal`。全套 44 个 spec 全绿。⑦ 测试里踩到的时序坑记一下：为了造 fd 压力先同步创建 600 个文件、紧接着挂监听，**FSEvents 会把挂监听前那一小段时间的事件补送过来**（机器越忙延迟越大），于是它们会在后面某次断言里冒出来。产品行为是对的（stat 发现是已知文件 → 报 change），落到真实使用上就是"启动后可能对启动前刚改过的文件补报一次 change"，无害；spec 里滤掉这批噪音并在挂监听前先让事件流干。⑧ 另记一次**未能复现**的偶发：满负荷串联跑时 `preview-live-edit.spec.js` 报过 6 项失败（`/api/edit-doc` 请求失败 + `waitForFunction` 30s 超时），随后单独跑两次、与 `toast` 串联跑一次、以及再跑一整轮 `npm test` 全部全绿。失败项是 HTTP 请求层的，与本版改动（只碰文件监听）无关，判断是机器满载时的时序偶发——和 0.18.1 那次 `quickopen-a11y-rename` 同类。

- **0.18.1** (2026-08-25) — 修 0.18.0 的 ⑦ 段记下的那个既有问题：**导出 PDF 每次都要整整 30 秒**，而 PDF 其实早就写好了（`lib/pdf-export.js`）。① **根因不是渲染慢，是 Chrome 不肯退出**。先做了一次带时间戳的诊断（三种文档各跑一遍，同时观测"文件首次出现 / 尾部出现 `%%EOF` / 大小稳定 / 进程退出"四个时刻），结论很干净：PDF 分别在 **2.5s / 3.1s / 7.3s** 就完整落盘了，而 `chrome --headless=old --print-to-pdf` 之后**一直挂着不退**，直到被 `_doExportPdf` 里那个 30s 硬超时 `SIGKILL`——也就是说每次导出用户白等二十多秒，等的是一个已经无事可做的进程。既有代码的 `writePoll` 只用「文件出现」来 emit 一次 `writing` 阶段事件，看到了这个信号却没有用它做任何决策。② **修法：文件一写完就主动收掉 chromium**。判据用 `%%EOF`（PDF 规范要求的文件结束标记，只出现在文件末尾）而不是只看大小——实测 Chrome 是一次性写入的（文件首次出现那一刻尾部就已经有 `%%EOF`），但万一某个版本或平台改成分段写，中间态不会带 EOF，这个判据不会把半成品当成写完的；再叠一次「大小与上一拍相同」作保险，轮询间隔从 250ms 收到 150ms 让响应更快。命中后先 `SIGTERM` 给它 1.2s 收尾机会、没走再 `SIGKILL`（走 SIGTERM 是为了让它自己释放 `user-data-dir` 的锁——那虽是每次新建、随后整个删掉的临时目录，但强杀留下的半个 profile 偶尔会拖慢下一次启动）。**30s 硬超时保留**，角色从「正常路径的收尾方式」变成「渲染真的卡死时的兜底」。③ **效果**：四种文档实测 **2.3s / 2.6s / 2.5s / 4.3s**（4.3s 那次是队列里第一个、承担了 Chrome 冷启动），比原来快 7~13 倍；导出是串行队列，连着导几篇的累积收益更大。④ 顺带把成功判定的信息补全：`exportPdf` 现在额外返回 `complete`（尾部是否有 `%%EOF`）。**它刻意不参与成功判定**——正常路径的收尾条件本身就是 EOF、必然为 true，只有走到硬超时才可能拿到一份截断的 PDF；不拿它否决成功是为了不引入回归（万一哪个平台的 Chrome 在末尾追加了什么导致判据失效，也不该让本来能用的导出变成报错）。服务端在 `complete === false` 时打一条 warn，留个排查线索。⑤ **测试**：`md-pdf-export.spec.js` 加 3 项（PDF 尾部有 `%%EOF`、文件头是 `%PDF-`、端到端耗时 < 20s）。耗时门槛设 20s 而不是贴着实测的 3s：真实耗时 2~4s，而回归（退回等硬超时）必然 ≥30s，中间留足余量给慢机器和 CI 的共享 runner，不会因为环境慢而假红。**反向验证做过**：`git stash` 撤掉修复后跑同一个 spec，耗时 30192ms、两条新断言都红，不是陪跑。全套 41 个 spec 全绿。⑥ 记一次**未能复现**的偶发：全量跑的那一轮里 `quickopen-a11y-rename.spec.js` 报 1 项失败，随后单独连跑 3 次全绿，失败项内容已被后续 spec 的输出覆盖、没抓到。本版只碰了 PDF 导出管线与一行日志，与 ⌘K / 重命名无关，判断是偶发；留在这里备查——下次再遇到要先把单个 spec 的完整输出留下来。

- **0.18.0** (2026-08-25) — 三项新功能：**Mermaid 图表与数学公式**、**HTML 预览沙箱与信任分级**、**CSV / JSON / 文本 / SVG 可选扫描**。① **Mermaid + KaTeX**（`public/vendor/markdown.js` + 新增 vendor 文件）：AI 写的架构说明、时序、流程几乎默认用 ` ```mermaid `，指标定义常带 `$…$`，而这些在 Atlas 里此前只是一段灰代码和一串美元符号——这是"用户会因为一张流程图流走"的那类基线缺失（同期新出的 markview / showmd 都把它当卖点）。做法是**服务端只产出降级可读的 DOM、渲染放到浏览器**：mermaid 块输出成 `<pre class="md-mermaid"><code class="language-mermaid">`，没渲染时它就是个正常代码块；`enhanceRich()` 在浏览器里串行调 `mermaid.render`（mermaid 对并发 render 不友好），失败时显示 mermaid 的**原始报错**并保留源码（AI 写错 mermaid 语法是常事，报错本身就是给 AI 的修改依据），成功后加一个「源码」开关。公式走同一套：块级 `$$…$$` / `\[…\]` 在 `render()` 里识别，行内 `$…$` / `$$…$$` / `\(…\)` 在 `inline()` **最前面**抠出来占位（必须排在转义与强调之前，否则 `$a_1 * b$` 里的 `_` 和 `*` 会被强调规则吃掉），交给 KaTeX 渲染，失败就显示原文。`$` 的边界规则照 Pandoc 来（开定界符后紧跟非空白、闭定界符前非空白、闭定界符后不紧跟数字），所以 `单价 $5，折后 $4` 和 `$100 到 $200` 原样显示——不用 lookbehind 而是用捕获组约束末字符，因为 Safari 16.4 之前不支持 lookbehind 而这份文件要在用户浏览器里跑。**按需加载**：`detectRichInHtml()` 基于渲染产物判断（零误判），没有图表公式的文档一个字节都不下载（mermaid 有 3.5MB）。四条路径一致生效——只读预览、编辑器实时预览（另开一档 350ms 防抖，跟着每次按键跑的话打一段话就是几十次图布局）、PDF 导出（`assetBase` 换成 `public/vendor` 的绝对 `file://` URL，否则 `/vendor/…` 会被解析到文件系统根）、局域网分享页（`/vendor/` 对非本机放行，否则访客只能看到源码）。第三方库按现有 `Sortable.min.js` 的先例进 `public/vendor/`（mermaid 11.17.1 / KaTeX 0.18.4 + 20 个 woff2），而不是加 npm 依赖——后者会拖进 84MB 的传递依赖树；`/vendor` 单独挂一条允许 ETag 协商缓存的静态路由（那 3.5MB 挂在 `no-store` 上每次预览都要重传一遍，而它的内容在两次启动之间不会变）。② **预览沙箱与信任分级**（`server.js` / `public/app.js`）：预览用的是同源 iframe，而里面那份 HTML 是 AI 写的——它的脚本能 `fetch('/api/save-md')` 改写磁盘上别的文档、能开局域网分享链接、能读扫描根配置。**实测确认过这条路是通的**。现在 HTML 默认 `sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads"`——**刻意不给 `allow-same-origin`**（两者同时给等于没沙箱，文档能自己把属性摘掉），文档自己的图表交互照常运行，但源变成 opaque：实测读父页面报 `SecurityError`、读写 Atlas 接口都被挡。代价是那几项需要注入的能力用不了（预览内编辑、正文命中高亮、⌘K/⌘B 转发、滚动位置恢复），所以给顶栏加了盾牌开关（`POST /api/trust`，按文件记在 `store.trusted`），点编辑按钮时会直接问要不要信任；`sandbox` 属性只在创建文档那一刻生效，所以切换后必须走一次 `about:blank → url` 的真实导航（给同一个 `src` 重新赋值不算导航）。md / csv / json / txt / svg 的预览页是 Atlas 自己渲染、内容全部转义过，**不沙箱化**——那样只会白白砍掉滚动恢复和高亮。服务端加了第二道锁：**非 GET 请求校验 Origin**，沙箱文档发出的 `Origin: null`、别的站点、本机其它端口的页面一律 403，不带 Origin 的 curl / CLI 放行（浏览器对 fetch 的写请求一定带这个头，挡住浏览器就够了）；这样将来哪条路径漏了 `sandbox` 属性，写操作仍然进不来。设置里新增「安全」分区：全局开关 `config.trustAllHtml`（回到 0.17 及更早的行为，打开前有一次带风险说明的确认）与「清空单篇信任记录」。③ **CSV / JSON / 文本 / SVG**（新增 `lib/plain-render.js`）：`DOC_EXTENSIONS` 扩到六种，但**默认仍只有 html + md**——AI 顺手导出的数据文件通常比正文多得多（一次分析吐十几个 csv 很常见），无条件扫进来会把目录树冲淡、未读红点跟着失真，而红点的价值全在于稀缺。CSV 用手写状态机按 RFC 4180 解析（字段里的分隔符、换行、`""` 转义都不会切错行——用 split 会从某行开始整张表错位，而带引号的长备注在 AI 导出里非常常见），分隔符自动嗅探且引号内不计数，**整列判断后数字列右对齐**，复用 Markdown 那套 data table 排版与宽表滚动提示（为此把表格遮罩逻辑从 `enhanceScript` 里拆成独立的 `tableOverflowScript` 复用）。JSON 重新缩进 + 按 key / 字符串 / 数字 / 布尔 / null 上色；非法 JSON 不白屏，报出行列位置——V8 的报错格式变过三轮（`line X column Y` / `position N` / Node 22+ 只在消息里嵌一段原文上下文），三种都处理，最后那种靠把片段拿回原文 `indexOf` 定位并要求唯一命中。SVG 用 `<img src="/raw/…">` 引入而不是内联：浏览器不执行 `<img>` 里的 SVG 脚本（实测 `<script>` 没跑），这条路径天然隔离、因此也不需要沙箱。这四种只读（没有编辑器），但未读红点、版本对比、收藏、标签、⌘K、全文搜索（csv/json 索引原文，svg 只索引 `<text>`/`<title>`/`<desc>` 里的文字）、局域网分享（渲染成网页返回，否则浏览器会把 .csv 直接下载走）、导出 PDF（SVG 除外）都照常。④ **修掉一处自己引入的副作用**：`styles.css` 一直用 `:has(#btn-edit:disabled)` 反推"首页态"来收起整条文档工具栏——"编辑按钮不可用"当时确实等价于"没打开文档"，但只读格式进来后就不成立了，表现是打开一篇 CSV 时编辑按钮**凭空消失**而不是变灰。改成显式的 `body.no-active-doc`（`index.html` 初始带上，`setActiveFile` 移除 / `goHome` 添加），三态实测正确。⑤ **测试**：新增 `rich-render.spec.js`（39 项）、`sandbox-trust.spec.js`（33 项）、`plain-formats.spec.js`（44 项），都做过反向验证；三个既有 spec 加 `config: { trustAllHtml: true }`——`scroll-stuck` / `preview-shortcut-bridge` / `shortcuts-panel` 都要从宿主页面读 iframe 的 `contentDocument`，而那正是沙箱切断的东西，它们测的是布局与快捷键桥、不该顺带承担沙箱的职责（沙箱本身由新 spec 覆盖）。全套 41 个 spec 全绿，`e2e-install` 10 项通过。⑥ **包体积**：unpacked 从约 300KB 涨到 5.0MB / 47 个文件（mermaid 3.6MB + KaTeX 0.4MB），`npx atlas-dashboard` 首次下载会慢几秒——这是"离线可用 + 不引入 84MB 依赖树"的代价，步骤 3 的 `total files` 预期值已同步更新。⑦ 顺手记一个**既有**问题（本版未改，基线同样如此）：PDF 导出每次都要 30 秒，因为 Chrome `--headless=old` 打印完 PDF 后不自己退出，一直靠 `pdf-export.js` 里的 30s 硬超时收尾（文件其实早就写完了）。可以改成"检测到 PDF 写完且大小稳定就主动 kill"，但那是动导出管线，留给后续版本。

- **0.17.1** (2026-08-25) — 修 0.17.0 的宽表遮罩：**加大阅读宽度后，表格右侧那道阴影还留着，而那个位置已经没有表格了**。两个独立缺陷叠在一起，缺一个都不会长成用户看到的样子（都在 `public/vendor/markdown.js`）。① **遮罩状态一直落后一档**：`.md-inner` 的 `max-width` 带 `transition: .18s`，而切档时 `widthScript` 的 `apply()` 是**同步**调 `__atlasSyncTableOverflow()` 的——那一刻布局还是旧宽度，量出来的 `clientWidth` 还是上一档的值，于是"表格已经放得下了"这件事永远晚一步被发现，而动画结束后没有任何人再测量一次。0.17.0 发版前的验证之所以没抓到，是因为当时只在推荐宽度档下截图核对过；而从加宽档切到全屏档时同步测量恰好也得出"不溢出"、蒙对了，更掩盖了这一点。现在改用 `ResizeObserver` 观察 `.md-table-scroll`：它在 transition 的每一帧都触发，遮罩跟着动画淡入淡出，不需要去猜动画什么时候结束。顺带修掉三条原先根本没有重测入口的路径——**拖 TOC 宽度**、**收起 / 展开 TOC**、以及带动画的档位切换，因为 0.17.0 只监听了 `window resize`，而这三条都不发 resize 事件（正文宽度却实打实变了）。② **遮罩画在表格外面**：`.md-table-block` 是 block、宽度铺满整个正文，而遮罩是挂在它身上的 `::after`、贴的是**它**的右缘。表格比正文窄时（窄表，或者切到更宽档位之后），遮罩就落在表格右边那片空白上——实测偏离表格右缘 275px。这一条和 ① 独立：就算判定完全正确，只要哪次遮罩该亮，位置也是错的。改成 `width: fit-content; max-width: 100%`，这一层于是收缩到 `min(表格自然宽度, 正文宽度)`，右缘永远等于可见内容的右缘（实测偏差 0px）。③ 测试：在 `md-render-and-roundtrip.spec.js` 里把这件事收成一条**不变式**——「遮罩亮 ⟺ 真的还能往右滚，且亮着时遮罩右缘必须贴住表格右缘（偏差 ≤ 2px）」，三个档位各查一次，比写死"哪张表在哪档下该不该亮"稳得多。fixture 加了一张 8 列短内容的表（列宽由 `min-width: 5em` 决定所以宽度可预测，约 790px），正好卡在「推荐宽度档 724px 装不下、全屏档 874px 装得下」——这个"从溢出变成不溢出"的转变是遮罩状态出错时唯一会露馅的场景。**这条转变本身也被断言出来了**（比的是 `canScrollRight` 这个真实布局事实，不是 `hint` 那个可能正错着的状态），否则将来字体或列宽一变，前提不成立，上面三条会静默空转。撤掉两处修复复验过会红，实际值 `{hint:true, canScrollRight:false, gap:39}` 同时暴露两个缺陷，不是陪跑。另外手工验了五条路径（三档切换 / 收起展开 TOC / 拖 TOC 到 500px / 视口 1000↔1800 / 把宽表滚到最右遮罩要灭）与 `fit-content` 没把宽表压扁（12 列表仍可横向滚动、窄表不可滚）。全套 38 个 spec / 844 项断言全绿。④ 记一个本机环境坑：`npm pack` 报 `EACCES ... _cacache/content-v2/...`，是 `~/.npm/_cacache` 里有目录属主为 `root`（历史上某次 `sudo npm` 留下的），与本仓库无关；不要去 `sudo chown` 用户的缓存，加 `--cache /tmp/<临时目录>` 跑就行（已补进「故障排查」表）。

- **0.17.0** (2026-08-25) — Markdown 渲染质量：表格重排（含两个真 bug）+ 阅读宽度三档 + GFM 提示块。全部集中在 `public/vendor/markdown.js`（`app.js` 只加了一条快捷键清单）。① **修「表头和数据列全是错开的」**——`<th>` 的浏览器默认 `text-align` 是 `center`，`<td>` 是 `left`，而 CSS 里两者都没显式声明。于是**任何没写 `|:--:|` 对齐语法的表，表头都飘在列中间**，跟它下面那一列对不上。这是用户说「表格结构不清晰」的头号来源，而且它不是审美问题、是纯粹的对齐 bug：五列的模型对比表里「模型」二字停在第一列中央、「备注」停在最后一列中央，眼睛得先在每一列里找一次表头到底管的是哪些格。现在 `th` / `td` 统一显式 `text-align: left`；Markdown 里写的 `|:---|:--:|---:|` 会输出成单元格自己的 `style="text-align:x"`，行内样式优先级更高，照样生效（spec 里两个方向都断言了）。② **修「宽表被压成竖排，横向滚动条永远不出现」**——`table` 上写着 `max-width: 100%`，表格因此**永远不会溢出容器**，外层那个 `.md-table-scroll`（0.7.0 就加了）拿不到任何可滚动内容、滚动条从来没出现过；浏览器为了塞进 100% 只能拼命压缩列宽，把「归因说明」「启动次数」压成一列一个字的竖排，一行数据占掉 150px 高。12 列的月度数据表在这套 CSS 下基本不可读。现在 `width: max-content` 让表格取内容自然宽度、大方地溢出，滚动交给容器；`td` 加 `max-width: 34ch` 免得一句长备注把整张表拉到几千像素宽，`th` / `td` 加 `min-width: 5em` 给窄容器兜底（编辑器右侧的预览面板只有 500 多像素宽，没有这个下限它还是会压成竖排）。**编辑器那半边不能被注入包裹层**（`htmlToMarkdown()` 要靠 DOM 反解析回源码，多一层 `div` 会污染结果，`serializeBlocksList` 会把 `DIV` 当块然后把整张表序列化成一行纯文本），所以那边走 `display:block + width:max-content + max-width:100% + overflow-x:auto` 让表格自己当滚动容器（GitHub markdown-body 用了很多年的组合）；只读预览页里 `enhanceScript` 会套上包裹层，那时用 `.md-table-scroll table{display:table}` 把它切回正常 table 布局，否则遮罩会跟着内容一起滚走。③ **表格按 data table 的常规做法重排**（参考 Vercel Design 的 Table 与 Stripe Docs）：0.12.0 那版是「只留横线、去掉竖线和斑马纹」的极简版，在 3 列小表上确实干净，但十几列的宽表里一条横线锁不住一行、眼睛横着扫过去会串行。现在四个信号各管一件事、不重复表达：外框圆角圈出边界、表头一层浅底（`--md-table-head`）、极淡斑马纹（`--md-table-alt`，这个变量 0.12.0 就定义了却没有任何规则用它——删斑马纹时忘了删变量）、行 hover（`--md-table-hover`）；另加首列 `font-weight:500`（首列通常是行的名字，横向扫读需要一个锚点）与 `font-variant-numeric: tabular-nums`（价格 / 百分比按位对齐才能比大小）。圆角靠 `border-collapse:separate` + 表头首末单元格分别设 `border-top-*-radius`，不然表头底色的方角会从圆角外框里露出来。④ **宽表右缘的「还有内容」渐变提示**（`.md-table-block::after`）：macOS 的滚动条平时是隐藏的，表格被容器裁掉右边五列时没有任何信号。`enhanceScript` 现在套两层——外层 `.md-table-block` 挂遮罩、内层 `.md-table-scroll` 负责滚动（overflow 容器内的 absolute 元素会跟着内容滚走，遮罩必须挂在不滚动的那一层），滚动到最右时遮罩淡出（容差 2px，子像素舍入会让它一直亮着）。渐变用半透明黑（`--md-fade`）而不是背景色：表格自己也是浅底，同色渐变等于看不见（第一版就是这么写的，截图上完全看不出来）。⑤ **新功能：阅读宽度三档**——`.md-inner` 的 `max-width` 从 0.7.0 起就是硬编码的 `820px`，从来没有过切换入口（用户记忆里的「文档可以改宽度」是 0.16.0 加的**目录栏**宽度拖拽，两回事）。1440 宽的屏幕上 TOC 250px + 正文 820px，右侧空着 370px，而十几列的宽表恰恰需要那 370px。现在预览页右上角一组三段控件：推荐 `820px`（约每行 54 个汉字）/ 加宽 `1120px` / 占满全屏（`max-width:none`），点一下即换，`[` `]` 也能逐档调（这两个键外壳没占用，预览快捷键桥只转发带修饰键的组合和裸 `?`，所以在预览页里监听是安全的），选择记在 `localStorage: atlas:mdReadWidth` 跨文档跨会话保持。档位属性挂在 `<html>` 而不是 `<body>`，这样 `<head>` 里一行 boot 脚本就能在首次绘制前定档——挂 body 的话长文档会先按 820 排一帧再跳到全宽，切文档时那一下闪动会反复出现。图标用「外框固定 + 内部填充条变宽」的同一个隐喻走三档，不用去猜三个不同图标各自什么意思。⑥ **新功能：GFM 提示块**（`> [!NOTE]` / `TIP` / `IMPORTANT` / `WARNING` / `CAUTION`）——AI 生成的文档里这个写法满地都是，而渲染器不认识它，只会退化成一段带 `[!WARNING]` 字面量的普通引用：「重要」和「顺带一提」在视觉上完全一样，这是「结构不清晰」里很大一块。现在渲染成带图标 + 类型名 + 左侧色条 + 同色系 7% 底色的 callout（`color-mix(in srgb, var(--md-alert-c) 7%, transparent)`，五种类型共用一条规则、深浅主题各自只换一个色号），配色取 GitHub Primer 的成熟值（蓝=说明 / 绿=提示 / 紫=重要 / 黄=注意 / 红=警告，是读者已有的直觉）。GitHub 要求 `[!NOTE]` 独占一行，实际生成的文档常写成 `> [!NOTE] 正文接着写`，两种都收。**反向序列化是这里最容易出错的地方**：标题行（「注意」两个字）是渲染出来的装饰、源码里只有 `[!WARNING]`，所以 `serializeBlock` 的 `BLOCKQUOTE` 分支要先 `cloneNode` 摘掉 `.md-alert-title`（不摘的话它是个 `P`，会被当成正文块序列化成 `> 注意`）再把 `[!WARNING]` 补回首行——否则用户在预览里改一个字，提示块类型就悄悄变成了一行中文正文。标题元素还加了 `contenteditable="false"`，让它在所见即所得预览里点不进去：能改但保存时必然被丢弃的东西，不该给出可以改的错觉。⑦ **有无目录的两个分支合并**：`renderPage()` 原来是两套正文外壳——没目录时 `body` 直接当 `.md-body`、宽度写在 `body` 上；有目录时是 `.md-content > .md-inner.md-body`。同一篇文档因为标题多了两个就换一种行宽和一套增强逻辑，也容易出「只有一种情况下才有的 bug」。现在正文外壳完全一致，只有侧栏 DOM 有无之分（`body.md-no-toc` 把 `margin-left` 归零），阅读宽度控件两种情况都在。⑧ **PDF / 打印：塞不进纸宽的宽表自动收紧**——A4 纵向减去 `@page` 的左右 14mm 只有约 688px，12 列的月度表 min-content 就有 745px，右边两三列会被纸张边缘**直接裁掉**（导出发给别人时那几列凭空消失，这是既有行为，不是本版引入）。新增 `printFitScript`：量一次、超了就挂 `.md-print-tight`（`.72em` + `4px 5px` padding）、再量一次还超就换 `.md-print-tighter`（`.6em`）。不去算缩放比例——padding 是固定 px，比例算不准；表格数量是个位数，试两档的成本可以忽略。Chrome `--print-to-pdf` 带 `--virtual-time-budget=8000`，这段脚本会在出片前跑完。打印分支的表格同时改回 `width:auto` + `min-width:0`，窄表因此不再被拉满纸宽（以前 3 列小表会拉到整页宽、中间大片空白）。这也是打印版**唯一**允许带的脚本，`md-pdf-export.spec.js` 的断言从「完全不带 `<script>`」收紧成「只带一段排版自适配、不带任何交互增强（`addEventListener` / `clipboard` / `scrollIntoView`）」，意图没变。⑨ 顺带四处渲染细节：段落 `text-wrap: pretty`（避免末行只剩一个孤字）、列表符号 `li::marker` 退到 `--md-fg-faint`（项目符号是结构提示，不该和文字抢同一档对比度）、图片 `display:block; margin:0 auto` 独占一行居中（md 里的图片几乎都是配图，跟着文字左贴会显得歪）。⑩ 测试：在既有两个 spec 里新增 29 项断言，不新增 spec 文件。`md-render-and-roundtrip.spec.js`（28 → 52 项）补三组——表格结构（表头与数据列左边缘实测对齐、`th` 计算值是 `left`、写了 `---:` 的列仍右对齐、12 列表真的溢出容器、溢出时挂上 `.md-can-scroll-right`、**表头行高 < 60px 作为竖排回归的探针**）、GFM alert（五种类型的 `data-md-alert` / 标题 / 图标 / 正文、`[!WARNING]` 字面量不再残留、普通引用不被误判、以及**改过 alert 正文后回写的源码仍是 `> [!WARNING]` 且装饰用的「注意」没被写进文件**）、阅读宽度（默认 820、三档按钮的 `aria-pressed`、`localStorage` 落盘、重载后档位与按钮态都恢复、`[` `]` 逐档切换与两端不越界）。`md-pdf-export.spec.js`（21 → 25 项）加纸宽 688px 下的实测：小表按自然宽度不被拉满、12 列宽表收紧到纸宽内一列不裁、宽表挂上收紧 class 而小表没有被无谓收紧。**阅读宽度那条断言踩了一个坑值得记**：第一版写的是「全屏档比加宽档更宽」，但 spec 的 iframe 在 1500 视口下减去侧栏与 TOC 只剩 970px，两档都被夹到 970、断言恒假——改成「铺满可用宽度」（`innerW === contentW`），这才是这一档真正的语义，也不随视口飘。全套 38 个 spec / 840 项断言全绿（`e2e-install` 按流程单独 `npm pack` 后跑并删掉 tgz，10 项；`scroll-after-toggle` 打印「HTML 不够长，没法测试」跳过，是本文档步骤 0 已记载的既有行为）。README 与 landing page 同步（Markdown 双模卡片 + 导出 PDF 卡片 + 键盘导航卡片的分组清单 + 静态兜底版本号；README 的 Dashboard 功能列表拆出「阅读宽度三档」「表格」「GFM 提示块」三条，快捷键表格加 `[` `]` 一行）。

- **0.16.0** (2026-08-25) — 界面重做 + 两个既有 bug 修复 + 三个功能增强。① **界面按「一层底座 + 四块分区」重做**（`public/styles.css` / `app.js` / `vendor/markdown.js`）：诊断出的问题不是配色不好看，而是三件结构性的事——**密度失控**（`AIProjects` 一个分组下 411 个文件平铺，文件名被截成 `01-user-segment-and…`，588 个红点铺满整列）、**层级扁平**（全站 `font-size: 13px` 一刀切，KPI 数字 / 卡片标题 / 文件名 / 路径 / 时间全是一个重量，眼睛没有落点）、**缺少性格**（白底 + 1px 灰边 + 8px 圆角 + 无阴影，是 admin 模板的默认长相）。所以先立底座：灰阶去掉蓝味（原 `#f4f6f9` / `#14181f` 蓝味偏重，整个界面像"浅蓝色的后台系统"），深色压到接近纯黑 `#0a0a0b`，border 淡化、分层改为主要靠 border 而非阴影（`--shadow-1` 近乎归零，只给 modal 和 ⌘K 留投影），圆角整体收紧一档（8/12/16 → 6/10/14），accent 从纯蓝 `#2563eb` 换成紫蓝 `#5b5bd6`——纯蓝是所有后台系统的默认色没有辨识度，而 brand-mark 的渐变本来就是 `#5b9cff→#8b5bff`，主色偏紫才和品牌自洽。**补上原先缺失的字号 / 字重 / 行高 / 密度阶梯**（`--fs-xs`~`--fs-2xl`、`--fw-*` 用 500/560/620 这种非整档值——600 在 `-apple-system` 下会跳到偏粗的字面，密集界面里显得吵），各区域只许从阶梯取值。**关键约束是保留了全部既有变量名**，3200 行 CSS 的引用一处没动，所以这一层是纯粹的取值替换。② **红点按新鲜度分两档**（`app.js` 新增 `isFreshUnread()` 作为 24h 窗口的唯一来源）：24 小时内改动过的是红点 + `--fw-semi`，更早的降级成灰点 + 常规字重，文件行 / 分组红点 / 首页待看队列 / ⌘K 结果四处共用同一个判据。红点的含义是"AI 刚动过这个文件"，可 588 个饱和红点同时亮着时这个信号就等于不存在——顺带把整列粗体也降下来，那是和红点同源的噪音。首页 KPI 跟着改口径：「文档 / 未读(红) / 项目 / 收藏」→「文档 / **今天改过**(红) / 待看 / 项目」，红色只留给 24h 窗口内的数字，一个永远亮红的三位数不是警报是背景噪音。③ **修「一级文件夹重命名后刷新就没了、但有时又能存住」**——两个缺陷叠加，这解释了"偶发"。前端是经典的 lost update：`scheduleSaveTree()` 是 250ms 防抖，而请求体原来在**定时器触发那一刻才现取 `state.tree`**，这 250ms 里任何一次 `fetchState()` 返回都会把整棵树换成服务端的版本（上面还是旧名字，因为改动还没发出去），于是自己的保存请求把自己的改动覆盖了，界面却显示"已保存"；触发源很多且时机随机（SSE 400ms 防抖、60s 轮询、切回标签页、新建分组、归档）。现在排程的同时就深拷贝快照，并加 `hasPendingTreeWrite()` 让 `fetchState` 在有未落盘改动时不覆盖内存树。同一个 race 还有两个分身：`startRenameFolder` 改的是渲染闭包捕获的 `folder` 对象（树被换过之后它就是个游离对象，改它不进将要保存的树）——改成按 id 从 `state.tree` 重新定位；`render()` 第一件事是 `innerHTML=''`，会把正在输入的 `contenteditable` 节点直接摘掉，而浏览器移除聚焦元素**不触发 blur**，提交回调根本不执行、敲进去的名字静默消失——现在编辑期间跳过重建，结束时补上被跳过的那次渲染。服务端则是**把名字当成了分组的身份**：`reconcile()` 用 `store.tree.find(n => n.name === folderName)` 认领自动分组，而分组名和 `projectName`（扫描根下的一级目录名）之间唯一的联系就是"恰好相同"——用户一改名就再也认不出来：新文件进来时按名字找不到 → 又 push 一个自动名的新分组；分组一旦临时变空（AI 覆盖写文件时 chokidar 会先收到 unlink 再收到 add、扫描根短暂不可达、切换 docTypes）就被 `pruneEmptyFolders` 删掉，下一轮按 `projectName` 用自动名重建。现在分组带 `autoFor` 身份键（`autoFolderKey()`），`reconcile` 按它认领、老数据由 `backfillAutoFor()` 补齐；`shouldKeepEmptyFolder()` 只回收"自动生成且未改名"的空壳。**还有一个更隐蔽的点**：改过的名字不能只活在 `store.tree` 里——归档（`/api/archive` 直接 filter 掉整个分组）、被误回收、前端整树覆盖，任何让分组从树上消失的操作都会把它带走，所以另存一份 `store.folderAliases[projectName]`（`syncFolderAliases()` 在 PUT `/api/tree` 时同步），`reconcile` 重建分组时用 `autoFolderDisplayName()` 把名字取回来。前端 `readContainer()` 必须原样带回 `autoFor`，否则一次拖拽就把它从整棵树抹掉。顺带修掉两个同源缺陷：手工新建的空分组会在下一次 `/api/state` 被当成空壳清掉（表现是"新建分组立刻消失"）、改过名的顶层分组归档不掉（`/api/archive` 也是按 name 过滤的）。④ **修「对比误报有更新、点开却说没变更」**——根因是**未读看时间、差异看内容，两者从来没对过账**：`unread` 与顶栏那个"有改动"高亮都只比 mtime（`file.mtime > baselineAt`），而 `diffText` 第一件事是 `oldText === newText` 就返回 `changed:false`。AI 用相同内容重新生成一遍文档（或 `touch`、rsync / 网盘同步）会让 mtime 前进但内容没变，于是提示亮起、点开是空的。现在 `buildVersionMeta()` 补上内容核对并返回 `baselineSame`，前端判据加 `&& !file.baselineSame`。核对只对候选文件做——有底本、且 mtime 比底本新，这个集合是"用户打开过、之后又被写过"的文件，通常只有个位数到几十个；结果还按 mtime 缓存（`currentContentHash()`），所以 `fileMap` 那圈"不许 stat"的性能约束没有被破坏。查这个 bug 时挖出一个更伤的**设计缺陷**：`openFile()` 无论未读与否都 POST `/api/seen`，而它会 `recordSeenVersion()` 把磁盘当前内容设成新底本——也就是说"打开文档去看变更"这个动作本身把对比基准刷掉了，之后再点对比永远是"没有变更"，想看的那次差异被吃掉了。而 `versions/` 目录明明留着每个文件最近 5 份快照，`store.seenVersions[path]` 却只存一个 `{file,hash,at}`，另外 4 份没有任何入口可达——死存储。所以问题 ④ 和 ⑤ 其实是同一件事，合并做了。⑤ **对比面板支持版本历史与回退**（`server.js` / `app.js` / `index.html` / `styles.css`）：`seenVersions[path]` 从单对象改成数组（`versionsOf()` 兼容老格式，无需迁移脚本），保留最近 5 份，**内容没变就不追加**——这样列表是"内容变化的历史"而不是"打开了多少次"的历史。面板顶部新增版本下拉（带时间，与当前内容相同的那版会标出来）与「回退到这一版」按钮；回退走 `POST /api/revert`，严格按编辑保存那条路：先 `editBackup.backup()` 备份到 `backups/`、再临时文件 + rename 原子写回、并 `markSelfWrite()` 登记（不登记的话 watcher 会把 Atlas 自己的写入当成外部变更，回退完立刻又亮红点）。**这里有个不做区分就一定会错的地方**：底本分两类——打开文档时自动记的（`ack: false`）不能当基准，否则又回到空 diff；用户明确表过态的（`ack: true`，点了「标记为已看过」/ 执行回退 / 在 Atlas 里保存编辑）必须当基准，因为"没有变更"正是他期望看到的结果。没有这个区分要么看不到 AI 的改动、要么 accept 之后还在报差异——既有的 `diff-view.spec.js` 就是这样红的（`accept 后对比结果变为"无改动"`），那不是测试过时，是选版逻辑真的错了。前端 accept 处理里还要清掉手动选中的版本，否则会带着 accept 之前挑的旧版本去比、面板依旧显示一堆差异。顺带补上两处状态不一致：`save-edits` / `save-md` 原来只刷 `store.seen` 不刷底本，于是用户在 Atlas 里保存完再点对比，看到的是自己刚写的那些行被当成"别人动的"。⑥ **分组「在访达中显示」**：hover 自动分组时出现，`POST /api/reveal-folder` 按 `autoFor` 反解磁盘目录（`resolveProjectDir()` 覆盖 `projectName` 的两种来历：文件在扫描根子目录里取子目录名、直接躺在扫描根下取 `basename(scanRoot)`），只在扫描根范围内查找；`autoFor` 会拼进 `path.join` 所以按不可信输入校验路径穿越与分隔符。用户手工建的虚拟分组没有磁盘目录，前端不给它这个按钮。⑦ **Markdown 目录栏可拖拽调宽**（`vendor/markdown.js`）：原来固定 250px，长标题只能靠 ellipsis 截断，而"步骤 1: 更新 PUBLISHI…"这种截断恰好把有用的部分切掉了。宽度走 CSS 变量 `--toc-w`，新增 `.md-toc-resizer` 拖拽条（180~520px 钳制、双击复位、聚焦后方向键 ±8 / Shift ±24 / Home 复位），宽度记在 `localStorage` 跨文档保持，收起目录时拖拽条让位、打印时一并隐藏。拖拽用 `setPointerCapture`，否则指针一移出那条 5px 窄条就断。⑧ **两处样式缺陷**：确认弹窗「清除」按钮 hover 时文案发虚——根因是 `filter: brightness(1.08)` 会把背景和文字一起提亮，而实心按钮上的文字已经是白色提不亮了，背景一亮对比度反而往下掉（实测 hover 后约 `#e8232f` + 白字 = 4.45:1，低于 WCAG AA 的 4.5），改成明确指定深一档的 `--unread-strong`，新对比度 6.85:1；同样的写法在 diff 面板主按钮上也有，一并换掉。面包屑「首页」的 hover 底色紧贴 ⌂ 图标左缘——`.crumbs` 是 `overflow: hidden`，而 `.crumb-home` 用 `padding: 0 6px; margin-left: -6px` 做对齐，负 margin 把左侧那 6px padding 连同 hover 底色一起裁到容器外了；改成两个形态用同一套 `height` + `padding` 对齐（既有缺陷，非本次界面改动引入）。⑨ 测试：新增三个 spec 共 87 项断言——`folder-rename-persistence.spec.js`（24 项：改名后 reconcile 认得 / 新文件归进改名后的分组 / 分组临时变空不丢名字 / 未改名的自动空壳照旧回收 / 手工建的空分组不被清 / 改过名的分组能归档且恢复后名字回来 / 前端改名后紧接 `fetchState` 不冲掉——读 `store.json` 验证磁盘真实内容 / 编辑进行中不被 render 打断）、`folder-reveal-and-toc-resize.spec.js`（26 项：入口渲染条件 + 4 条校验分支，成功路径会真的 spawn `open -R` 弹窗所以不进自动化 / 拖拽与钳制 / 双击复位 / 键盘微调 / 持久化与跨文档保持 / 收起时拖拽条隐藏）、`diff-versions-and-revert.spec.js`（37 项：同内容重写不报有改动 / 内容真变了才报 / 打开文档不再吃掉差异 / 内容变化才追加版本 / 指定版本对比与 404 / 回退含校验与备份内容核对 / 站内保存后不算变更 / **ack 分界的两个方向**）。三个 spec 都用 `git stash` 撤掉修复验证过会失败（分别红 5 / 4 项），不是陪跑。全套 38 个 spec 全绿（`e2e-install` 按流程单独 `npm pack` 后跑并删掉 tgz，10 项；`scroll-after-toggle` 打印「HTML 不够长，没法测试」跳过，是本文档步骤 0 已记载的既有行为）。⑩ 测试里踩到两个坑值得记：改磁盘后必须 `settle(900ms)` 等 chokidar 的 `awaitWriteFinish`（300ms 稳定期），不等就会拿到旧的扫描结果、断言全是假失败；TOC 拖拽条会跟着宽度移动，每次拖拽前必须重新取 `boundingBox`，而 `frameLocator` 返回的 box 已经是页面绝对坐标、不要再加 iframe 偏移。README 与 landing page 同步（未读红点 / 目录树 / 首页概览 / Markdown 目录栏四张卡片 + 静态兜底版本号）。

- **0.15.0** (2026-08-24) — 新功能：**清除最近浏览记录**。① 侧栏「最近」分区此前是只进不出的：`pushRecent()` 把打开过的文档按 LRU 塞进 `store.recent`（上限 10），而**没有任何路径能把它清空**——记录只在文件从磁盘消失时被顺带剪掉。于是"不想让侧栏一直摆着刚看过的那几篇"（临时看了不相干的东西、要投屏 / 录屏给别人、或者就是不想留痕）唯一的办法是去删 `~/.atlas/store.json`，而那会把已读状态、备注、收藏、标签一起带走。现在分区头右侧加一个「清除」（`public/index.html` / `app.js` / `styles.css`），后端新增 `POST /api/recent/clear`（`server.js`）只把 `store.recent` 置空，`seen` / `seenVersions` / `favorites` / `tags` 一个都不碰——用户点这个按钮想的是"别显示我看过什么"，不是"把阅读状态重置回未读"。② 结构按 0.14.0 的 tag-bar 那套来：分区头包进 `.recent-bar-head`，折叠按钮与清除是**并列的两个 button**（button 不能嵌套），折叠按钮 `flex: 1` 吃掉整行剩余宽度、热区不因此变小；`.recent-clear` 直接复用 `.tag-bar-clear` 的外观（用文字「清除」而不是 ✕ 图标——侧栏里已经有一排 ✕ 形状的按钮，含义完全不同的动作长成同一个样子容易误点）。**分区收起时清除按钮仍在**：折叠只是把列表藏起来、记录还在，这时候恰恰更需要一键清掉。③ 走应用内确认框（`showConfirm`，`danger: true`）而不是点下去就清——这个动作不可撤销，文案里明确写清"只清列表，文档本身、未读红点和收藏都不受影响"，免得用户以为顺带把红点也重置了。交互上先本地清、立刻重画侧栏与首页那张「最近打开」卡片（两处读的是同一份 `state.recent`，不一起更新就会自相矛盾），再打后端；请求失败就把列表原样放回并给出 error toast——一次没成功却看着像成功了，比慢半拍难受得多。④ 顺带修掉 `renderRecent()` 的一处既有瑕疵：列表为空时它只给 `#recent-bar` 加 `hidden` 就 `return`，**DOM 里那一串 `.recent-item` 节点还留着**。以前这些节点不可见所以没人注意，但"清除记录"之后它们仍躺在文档里，等于"已清除"只是视觉上的；现在一并清空 `innerHTML`，下次有记录时 render 本来就整体重建，没有额外成本。⑤ 测试：临时写了 13 项断言覆盖按钮存在与可见、折叠态下仍可见、确认框文案、取消不生效、确定后侧栏隐藏且无残留节点、`store.recent` 清空而 `store.seen` 保留、`/api/state` 返回空 `recent`、首页卡片回到空态、清空后再打开文档仍能重新累积，全绿后按项目惯例删除（未新增 spec 文件）。全套 35 个 spec 全绿（`e2e-install` 按流程单独 `npm pack` 后跑并删掉 tgz；`scroll-after-toggle` 打印「HTML 不够长，没法测试」跳过，是本文档步骤 0 已记载的既有行为）。README 与 landing page 同步。

- **0.14.0** (2026-08-24) — 新功能：**回到首页**；UI 优化：**标签筛选区重做**。① 「回到首页」（`public/app.js` / `index.html` / `styles.css`）：0.12.0 把右侧空白做成了首页概览（待看队列 / 最近打开 / 收藏），但**打开第一篇文档之后就再也回不去了**——`state.activeFilePath` 一旦被赋值就没有任何路径让它回到 `null`，iframe 永远挂着最后打开的那篇，顶栏那三组「针对当前文档」的按钮永远可用，想再看一眼首页只能刷新整个页面。全项目只有一处内联的复位代码（设置里切换扫描类型、当前文件恰好失效时那 6 行），而且它自己也漏了关对比面板、漏了把顶栏按钮收回禁用态。现在抽出 `goHome()` 作为 `setActiveFile()` 的反操作：卸载 iframe（走 `about:blank` 而不是 `src=''`，后者在部分内核里会重新 GET 当前目录、闪一个 `Cannot GET`，与 `reloadPreviewDoc` 同一个理由）、清 `loading` 类（残留 `opacity:0` 会让下次打开先闪一下空白）、收起 md 编辑器与对比面板、清掉树里的 `.active`、把 9 个顶栏按钮逐个置回 `disabled`（它们此前只在 `setActiveFile` 里被 `= false` 打开过，反向路径根本不存在）、并重画首页与收藏 / 最近列表。编辑态下走 `confirmDiscardIfDirty()` 确认，选「继续编辑」则整个动作中止（返回 `false`）；草稿仍按既有机制落到 `atlas:mdDrafts` 留 7 天。② 三个入口：**面包屑最左段**（主入口）——面包屑原来是「项目 › 文件名」，压根没有根，而面包屑的第一段本来就该是可点回根的，这个缺口正是"没法回首页"的直接原因；现在是「⌂ 首页 › HTML 项目 › 文件名」。没打开文档时同一位置是不可点的占位，两个形态用同一套 markup（图标 + 文字），位置逐像素对齐、来回切换不横跳——第一版占位只有纯文字，切换时"首页"二字会横跳 13px，看起来像两个不同的东西。**侧栏左上角的 Atlas logo** 改成 button（点 logo 回首页是通用肌肉记忆，白捡一个入口且不占新的界面位置）。**`Esc`**——原来只处理"焦点在搜索框时清空搜索"，现在整理成一条由近及远的退出阶梯：关弹窗（在既有的 capture 层就被吃掉）→ 清空搜索 → 收起对比面板 → 回首页；编辑态整段跳过，那时 Esc 的候选动作是"放弃改动"，不该由一个顺手按下的键来决定。③ 这里有个不改就等于白做的坑：目录树的 keydown 原来**无条件**把 Escape 解释成"退出列表回搜索框"，而文件行是 `tabIndex = -1`、鼠标点击也会让它获得焦点——于是"从侧栏点开一篇文档"（最常见的动线）之后按 Esc，事件被树吃掉，全局那条阶梯永远走不到最后一级。改成只在行上真的有 `.kbd-focus`（即确实在用键盘逐行导航）时才拦截，并补上 `stopPropagation()`。④ 一个刻意的取舍：**`Esc` 不加进预览 iframe 的快捷键桥**（`PREVIEW_BRIDGED_BARE_KEYS`）。带 lightbox / 浮层的 HTML 报告普遍用 Escape 关闭自己的弹层，抢过来会把文档本身的交互弄坏——和单键 `/` 不转发是同一个理由。代价是读文档时按 Esc 不回首页，但那个场景鼠标本来就在手上，面包屑和 logo 两个入口都在视野里；README 与快捷键说明里都写明了这一点。⑤ 顺带收口三个**当前文档已经不存在了却不复位**的既有缺陷：归档分组、文档在磁盘上被删、切换扫描文档类型。前两个此前完全没有任何复位——侧栏树里已经找不到那篇文档了，预览区却还挂着它，顶栏按钮全可用，点刷新 / 分享 / 导出全是 404。现在统一放在 `fetchState()` 里：拿到新 `state.files` 后发现 `activeFilePath` 不在其中就 `goHome({ confirmDirty: false })`（文件都没了，弹「放弃改动吗」只会拦住必须发生的复位）。⑥ 标签筛选区重做（`public/styles.css` / `app.js` / `index.html`）：0.10.0 加的标签筛选条 `padding: 0 12px 8px`，**顶部间距是 0**，一排裸 chip 直接顶在排序栏的分隔线上，既没有"这排东西是干什么的"的锚点，标签一多还会无声地把文件树往下挤。现在改成与「收藏 / 最近打开」同构的可折叠分区：`section-head` 分区头（标签图标 + 「标签」+ 计数徽章）+ 内容区，顶部有 11px 呼吸空间；整行可点折叠、状态持久化到 `atlas:tagsCollapsed`；计数平时是标签总数、筛选中变成「已选 / 总数」并转成 accent 色——收起来之后这是唯一还能看出"树被过滤过"的地方，所以必须带上已选数。chip 从 20px 提到 22px、圆角改 `--r-full`、选中态加一圈 inset 描边把 1px 边"加粗"到看得清；chips 区左缘缩进 24px 与分区标题文字对齐，`max-height` 按「4 行」算（`calc(22px*4 + 5px*3 + 6px)`）而不是拍一个 96px——差半行的截断看起来像渲染坏了，而滚动停在行与行之间是干净的；溢出时底部渐隐提示"下面还有"，**滚到底自动撤掉渐隐**（继续淡着反而像没渲染完），渐隐 class 由 `syncTagChipsOverflow()` 维护并挂了 `ResizeObserver` 应对侧栏拖宽。⑦ 测试：临时写了 49 项断言覆盖三个入口、`Esc` 的四级优先级、编辑态确认与草稿保留、文件删除与归档后的自动复位、chips 溢出与滚到底的渐隐状态，全绿后按项目惯例删除（未新增 spec 文件）。全套 35 个 spec 全绿（`e2e-install` 按流程单独 `npm pack` 后跑，`scroll-after-toggle` 的跳过经 `git stash` 前后对比确认是既有行为而非本次回归）。现有 spec 里用到面包屑的几处断言（`#crumbs .crumb-name`、`textContent` 含文件名）不受结构变化影响。README 与 landing page 同步。⑧ **发版流程本身改了两处**（本文档已同步）：其一，标准命令序列从「publish → push → tag」调整为「**push → 等 CI 绿 → publish → tag**」——`npm publish` 是唯一不可逆的一步，原顺序的风险是发完包才发现推不上去（git 凭据过期 / CI 红），npm 上就留下一个 GitHub 上找不到对应代码的版本；唯一的硬约束「tag 必须在 publish 之后」（否则 Release 里的 npm 链接是坏链）仍然满足。其二，本次前置检查时 `gh auth status` 报 keyring token 失效，追查后确认 **`gh` 与 `git push` 用的是两套凭据**（keyring vs `osxkeychain`），且本仓库是 public、CI 状态与 Release 都能用匿名 `api.github.com` 读到，所以 gh 失效**不阻塞发版**——已把这条例外、替代命令、以及"匿名 curl 会间歇返回空响应、判失败前先重试 2~3 次"（本次验证 ② 就先误红了一次）都写进前置检查 / 步骤 4 / 验证章节 / 故障排查。

- **0.13.0** (2026-08-24) — Bug 修复：**「全部标为已读」点完还剩几篇未读**；新功能：**目录树全部折叠 / 全部展开**。① 未读口径修复（`server.js`）：归档过滤此前只做在 `reconcile()` 这一层（建目录树时跳过 `store.archivedProjects` 里的 projectName），而 `/api/state` 返回给前端的 `fileMap` 用的是**全量** `scanned`。底栏「N 篇文档 · M 未读」和首页「待看」都基于 `files`，于是把归档分组的文档也算进去了；偏偏 `/api/seen/all` 遍历的是**已过滤**的 `store.tree`，那几篇根本不在里面——形成一个自相矛盾的状态：侧边栏树里看不到它们，底栏却一直挂着未读数，点多少次「全部标为已读」都清不掉。现在抽出 `visibleFiles(scanned, store)`，树 / 统计 / 未读 / 正文搜索 / ⌘K 共用同一个可见集合。这里要区分两个集合：清理类逻辑（recent 剪枝、收藏与标签的惰性剪枝）继续按**磁盘全量** `diskPaths` 判断——归档只是隐藏，文件还在磁盘上，按可见集合判断会把用户手工投入的收藏和标签当成"文件已删"清掉，取消归档后就找不回来了；返回给前端的一切（`fileMap` / `favorites` / `allTags` / `recent` / `scannedCount`）才按可见集合过滤。② 同源修掉三处：**「全部标为已读」改成按当前扫描结果标记而不是走 `store.tree`**——树会滞后于磁盘（刚落地、还没被 reconcile 收进树的新文件不在里面），按树标会漏掉它们，这是同一句用户抱怨的第二个成因，与归档无关也能复现；新增 `markSeenAt(mtime)` 把已读时间戳改成 `max(Date.now(), mtime)`，因为未读判定是 `seen < mtime`，文件 mtime 落在未来时（时钟漂移、网络盘、被 touch 过）只写 `Date.now()` 红点是清不掉的，`/api/seen` 与 `/api/diff/accept` 一并改；watcher 的 `onEvent` 里归档分组不再 emit SSE 事件、也不再清 `seen`——否则会弹一条「文档已更新」桌面通知，点开去树里却找不到那篇文档。`/api/search` 也过滤归档，不然正文命中回到前端拿 `state.files` 查不到条目，等于一条点不开的死结果。③ 新功能「全部折叠」（`public/index.html` / `app.js` / `styles.css`）：分组一多，逐个点开点关是这个界面里最费手的操作。「全部文档」标题栏右侧加一个按钮，做成**一个按钮两个状态**（已全部折叠 → 图标翻成 `⌄⌄` 变「全部展开」），比并排放两个按钮省一格空间，也不用先判断该点哪个；沿用已有的 `atlas:collapsed` 持久化，刷新后保持。新增 `allFolderIds()` 递归收集含子分组的全部 id、`toggleCollapseAll()`、`updateCollapseAllBtn()`（挂在 `render()` 末尾与 `toggleFolder()`、拖拽悬停自动展开这两条会改折叠状态的路径上）。一个刻意的取舍：**搜索 / 标签筛选生效时该按钮禁用**并在 title 里说明原因——筛选态下目录树是被强制展开的（0.10.1 修的那个"筛选了但什么都没出来"），此时折叠会写进 `state.collapsed` 却没有任何视觉变化，点起来像坏的。图标两版：先画的"两个箭头向中线聚拢 + 一条横线"在 13px 下三条线间距不到 1.5px，糊成一团，换成双 chevron（向上=收起 / 向下=展开），和分组行自己的 chevron 同一套语义。④ 测试：新增 `archive-and-collapse-all.spec.js`（34 项），覆盖归档前后的 files 口径 / tree 与 scannedCount 一致 / 全部标为已读后一篇未读不剩 / mtime 在未来的文档也能标掉 / 正文搜索不捞归档文档 / 取消归档后原样回来（且仍是未读）/ 前端底栏文案与首页待看空态 / 折叠按钮的两个状态与图标翻转、localStorage、刷新后保持、筛选态禁用；已挂进 `npm test`。全套 35 个 spec 全绿，`npm test` 616 项断言。README 与 landing page 同步。

- **0.12.0** (2026-08-21) — 界面系统性升级 + 三个可发现性缺口的修复。**① 设计令牌层重写**（`public/styles.css`）：所有配色改用 `light-dark(浅, 深)` 单次声明，深浅两套色板不再各维护一份，随之删掉全部 `@media (prefers-color-scheme)` 重复块（`.preview` / `.md-preview-pane` / 源码↔预览同步高亮 / 两处 pulse 动画）。新增 `--border-strong`（控件轮廓，原来 `--border` 在深色下几乎看不出这是个按钮）、`--hairline`、`--accent-hover/-press/-ring`、`--on-accent`（深色主题的蓝配白字只有 2.6:1，实心按钮上必须换近黑）、`--warn`、`--shadow-1~3`、`--sp-*` 4px 栅格、`--r-*` 圆角、`--h-ctl*`、`--ring`。顺带修掉一个一直没人注意的问题：从未声明 `color-scheme`，于是深色模式下原生 checkbox 与滚动条仍是刺眼的浅色。**② 图标系统统一**：`public/index.html` 顶部内嵌 35 个 symbol 的 sprite（viewBox 24×24、stroke 1.75），`app.js` 新增 `ic()` / `docTypeIcon()`，把散落各处的 emoji（📁 📂 📋 🏷 ✎ ✕ 📝 🌐 Aa ⌕ ▾ 🕰️ ✅ ⚠️）全部换成线性图标。emoji 在 mac / Windows / Linux 是三套完全不同的字形、颜色不受 `currentColor` 控制、和线性图标的视觉重量也对不上——这是界面观感不统一的主因。`.file.content-match` 那个放大镜改用 CSS mask 画。**③ 顶栏工具条**：10 个同权重带边框的图标按钮改成 ghost 风格并按语义分三组（文档操作 / 标记分发 / 跳到外部），组间加 1px 分隔线；`#btn-share.shared` 与编辑态的 `#btn-edit` 原来靠 `border-color` 表态，ghost 化后改用 `accent-soft` 填充。**④ 侧栏**：头部收成单行并与主顶栏对齐到同一水平线；统计从 `brand-sub` 挪到底栏——320px 宽度下它长期被截成「804 个文档 · 377 未…」，新增 `updateStats()` 统一渲染并在「全部文档」区块标题上给出当前筛选命中数；收藏 / 最近的区块头从「只有右侧 16px 小箭头是热区」改成整行可点（`.section-head`，带 chevron + 图标 + 计数）；缩进引导线常显；`.file.active` 加 2px accent 左竖线。**⑤ 首页**：没打开文档时右侧原本只有一个占位图标加两行提示，整块空着。现在直接回答这个工具存在的理由——「AI 又改了哪些文档」：四个数字（文档 / 未读 / 项目 / 收藏）加上按 mtime 倒序的**待看队列**、最近打开、收藏三张卡片，点一行进文档，不必再去目录树里找红点。**⑥ 设置弹窗**：6 段长滚动改成左导航四分区（扫描 / 外观与通知 / 分享 / 归档），面板自身不滚动、标题栏与导航固定。**⑦ 深浅色可固定**：设置里新增「跟随系统 / 浅色 / 深色」，`<head>` 内联脚本先设 `data-theme` 防首帧闪白。这里踩到一个不明显的坑：**iframe 里的 `prefers-color-scheme` 不继承父文档的 `color-scheme`**，只在根节点切换会出现「外壳浅色、正文深色」的割裂。修法是把主题带进预览 URL——`markdown.js` 把两套配色变量提取成 `mdVarsLight/Dark` 与 `tocVarsLight/Dark` 并新增 `forcedThemeCss(theme)`，`renderPage` 接受 `opts.theme` 把覆盖样式追加在 `@media` 之后，`server.js` 的 `/api/render-md` 读 `?theme=`，`app.js` 的 `previewUrlFor()` 带上该参数；导出 PDF 仍钉浅色不受影响。**⑧ 对比度校准到 WCAG AA**：`--text-faint` 承载的是日期 / 计数 / 提示这类 10~11px 小字，原值在浅色下只有 2.79:1、深色下 3.25:1，现分别提到 4.39 / 4.89；`--unread`（底栏「N 未读」是文字）、`--ok`、`--fav`、`--border-strong` 一并上调。**⑨ 修掉三个长期存在的 CSS 优先级 bug**：`.modal button`（0,1,1）一直压过 `.modal-close` / `.quickopen-item` / `.share-btn-danger` / `.share-stop-all-btn` / `.root-list li button`（都是 0,1,0）——表现是 ⌘K 结果列表**每一行都被画成一个带边框的按钮**、「停止分享」这个破坏性操作显示成普通灰按钮、弹窗 ✕ 被画成方块。改法是给 `.modal button` 加 `:not(:where(...))` 排除三类非控件按钮（用 `:where` 保持优先级不变），其余加 `.modal` 前缀提级。**⑩ 修掉「焦点在预览文档正文里时快捷键全失效」**（既有缺陷，在 0.10.1 上同样复现）：预览是独立文档，键盘事件不跨 iframe 边界冒泡，外壳那个 keydown 总处理器收不到——点进正文读一会儿再按 ⌘K 想跳下一篇没反应，得先点侧栏把焦点拿回来，而这恰好是最常见的动线。新增 `bindPreviewShortcutBridge()` 往同源预览文档注入 keydown 桥（挂在 `load` 上，每次导航重建，`doc.__atlasKeyBridge` 防重复，`capture: true` 以防文档自己 `stopPropagation`）：命中 app 级和弦时**先在 iframe 侧 `preventDefault`**（合成事件只影响外壳，管不到原始事件的默认行为，不拦住的话 ⌘S 仍会弹浏览器「存储网页」、Windows/Linux 上 Ctrl+K 仍会跳地址栏），再构造等价事件派发给外壳，因此「哪个键干什么」仍只存在一处。让位规则：⌘S 仅编辑态接管（非编辑态留给浏览器，与外壳焦点时行为一致）、⌘K/⌘B 在文档内打字时不抢、单键 `/` 一律不转发（不少 HTML 报告自己用 `/` 做站内搜索）。**⑪ ⌘K 快速打开接入正文搜索**：AI 生成的报告文件名往往很泛（一堆 `README.md`、`20260529-xxx.md`），你记得的是「某篇里提过转化率」而不是文件叫什么；侧栏搜索虽然能搜正文，但它同时过滤整棵目录树，是「收窄视野」而非「跳过去」。现在名称命中在前（不破坏「敲两个字母 Enter 就走」的肌肉记忆），文件名没命中但正文里有的另成一组「正文命中」，每条带上下文摘要（关键词已 mark 标出）与这篇里出现了几处；选中回车后预览**滚到第一处并高亮**，顶栏出现 `n / m` 可用 ▲▼ 继续跳，全程不写侧栏搜索框（新增独立的 `qoContent` 状态与 `pendingPreviewHighlight`，后者只在路径匹配时兑现、兑现即失效，且因为「同一篇再打开不触发 iframe load」，`setActiveFile` 里 URL 未变的分支也要兑现一次）。服务端配套：`getFileText` 改为同时缓存原文与小写索引，**snippet 因此保留原始大小写**（原来只存小写，`README` 会显示成 `readme`；并防 `toLowerCase()` 改变长度导致切歪），`/api/search` 新增 `limit`（⌘K 传 25）、每条 `count`、响应 `truncated`，且**扫描前按 mtime 倒序**——带 limit 时循环会提前 break，按原扫描顺序返回的等于「随机 25 篇」，按 mtime 倒序才是「最近改过的里含这个词的」。**⑫ 新增快捷键速查表**：功能此前全藏在按钮 title 与 README 里，首页那行提示还只在没打开文档时可见，Markdown 编辑器那一整套键（⌘B/⌘I/⌘E/⌘K、Tab 缩进、回车续列表）在应用内完全没有出口。现在按 `?` 唤出（侧栏底部键盘图标、首页「全部快捷键」按钮同效），7 个场景分组共 31 条，`⌘`/`Ctrl` 按平台自动切；`SHORTCUTS` 数据刻意放在全局 keydown 处理器正上方，改快捷键的人在同一屏里就能看到清单也要改。`?` 也加进了快捷键桥的转发白名单（目前唯一不带修饰键就转发的键，因为它正服务于「读文档时想知道还能怎么用」）。**⑬ 加固测试 harness**（`tests/helpers/isolated-atlas.js`）：隔离实例在 4400-4799 随机取端口，撞上别的进程时 `server.js` 会自动切到别的端口，而 helper 仍探原端口——若那里恰好是另一个 Atlas（比如开发时留的调试实例），它是健康的，于是 `startAtlas` 认为「起好了」，整个 spec 拿着几百篇真实文档去跑只有几篇 fixture 的断言，失败信息还极具误导性（`空查询时列出全部文档 期望 4 实际 50`）。这次发版前就真踩到了，也追认了此前几次被当成「偶发」的失败。现在先用 `net` 探端口是否真空闲再 spawn，健康检查改用 `/api/config` 的 `scanRoots` 验明身份，撞上时直接报「端口 N 上应答的不是本实例」；PUBLISHING.md 步骤 0 也补了这条排查说明。**⑭ 测试**：新增 `preview-shortcut-bridge.spec.js`（18 项）、`quickopen-content-search.spec.js`（24 项）、`shortcuts-panel.spec.js`（33 项），三者都做过反向验证（临时停用被测逻辑确认断言真会红）；因文案与 DOM 调整同步更新 4 个既有 spec 的断言（`modal-close` 的 `.modal-close span` → `.ico`、`favorites-and-tags` 的 title 前缀、`sse-leak-and-retry` 与 `landing-demo` 的「个文档」→「篇文档」）。全套 34 个 spec 全绿，`npm test` 582 项断言。README 新增 `## 快捷键` 完整表格，landing page 同步 mockup 图标、demo 数据、统计文案，并新增「首页概览」「深浅色主题可固定」两张特性卡与键盘流卡的改写。⑮ 发版后由[验证发版成功](#验证发版成功)第 ④ 项兜住一处遗漏：`docs/index.html` 里 `<span id="cur-version">` 的静态兜底版本号没跟着升（页面脚本会从 npm registry 拉实时版本覆盖它，所以访客看到的一直是对的，只有 JS 被拦或离线时才会露出旧号）。已单独 commit 修复，并把这一项补进了[步骤 1.5](#步骤-15同步-landing-pagedocsindexhtml) 的清单——漏它的根因是那份清单里从来没列过它。

- **0.10.1** (2026-08-21) — Bug 修复：**筛选时命中结果落在折叠的分组里就看不见了**，表现为"筛选了但什么都没出来"、"清除筛选后文档也没回来"。日常使用中分组大多是折叠着的（`state.collapsed` 持久化在 `atlas:collapsed`），而 `renderFolder` 一直无条件按折叠状态渲染：筛选把不含命中项的分组整棵剪掉之后，剩下那些确实含命中项的分组仍然是折叠的 —— 命中的文件行进了 DOM 却被 `.folder.collapsed > .folder-children { display: none }` 藏住，屏幕上一个结果都没有。实测 766 个文档 / 30 个分组、其中 29 个折叠时，点标签 chip 筛选后**屏幕上可见文档数是 0**。修法：`renderFolder` 里 `const isCollapsed = hasActiveFilter() ? false : state.collapsed.has(folder.id)` —— 筛选生效时忽略折叠状态（能活到渲染这一步的分组本身就是"含命中项"的，再让用户一个个点开是反直觉的），且**只在渲染时忽略、不写 `state.collapsed`**，所以清除筛选后每个分组的折叠状态原样恢复、localStorage 里的折叠偏好也不被改写。这个毛病不是 0.10.0 引入的：搜索（0.1.0）与「仅未读」（0.2.0）一直有，0.10.0 新加的标签筛选继承了它，现在三者一起修好。`favorites-and-tags.spec.js` 加了 12 项断言把这条钉住（折叠状态下标签筛选 / 搜索 / 仅未读三种筛选的命中结果都必须可见、命中分组自动展开、清除后折叠状态与 localStorage 偏好都原样恢复），共 84 项。全套 31 个 spec 全绿。

- **0.10.0** (2026-08-20) — 新功能：**收藏夹**与**文档标签 + 按标签筛选**。目录树是"一个文件只能待在一个地方"，但常看的那几篇往往散在不同项目里（每次都要展开好几个分组去翻），而"周报""待评审""要归档"这些维度本身是交叉的、跟目录结构对不上。这两个功能各自解决其中一半。① **收藏**：文件行左侧加常驻星标 `.fav-btn`（未收藏时半透明、hover 该行浮出，已收藏则常亮金色 `--fav`），顶栏也加了同步状态的收藏按钮；侧栏新增「收藏」区（结构照 `.recent-bar`，跨文件夹平铺、按收藏时间倒序、条目上 ✕ 取消、可折叠且折叠态持久化到 `atlas:favCollapsed`）。刻意不把星标塞进 hover 才出现的 `.file-actions` —— 收藏是高频二元操作，藏在第 6 个按钮后面不合理；代价是它落在 SortableJS 的拖拽把手区里，必须同时加进 `initSortables` 的 `filter` 和文件行 `pointerdown/pointerup` 的守卫，否则按下星标会开始拖这一行（拖完 `onEnd` 还会把排序模式强行切到「自定义」）、或者顺带把文档打开。② **标签**：hover 文件 → 🏷 → 逗号分隔输入（`周报, 待评审, AI`），中英文逗号都认，服务端 `normalizeTags()` 做唯一一次规范化（trim、内部空白压成单空格、单个 ≤24 字、最多 12 个、**按小写去重但保留用户第一次输入的写法**，所以输 `AI` 之后再输 `ai` 不会多出一个看起来重复的标签）。文件行上显示前两个 + `+N`（完整列表进 `title`），`hover` 时标签让位给操作按钮——320px 侧栏放不下「chip + 展开后的 5 个按钮」，不让位文件名会被压成「留…」。③ **按标签筛选**：侧栏 `#tag-bar` 列出全部标签（按用量倒序、带计数），点一下只看该标签的文档，**多选是「同时具备」**（AND，与搜索多关键词语义一致，逐步收窄），且与搜索、「仅未读」正确叠加而非互相覆盖——新增 `matchesTagFilter()` 接进 `fileMatches()`，并抽出 `hasActiveFilter()` 统一 `render()` / `renderFolder()` 两处过滤守卫（原来是散在两地的 `state.search || state.onlyUnread`，加一种筛选就要改两处、漏一处就是"筛选只在顶层生效"）。标签筛选故意不持久化（同 `onlyUnread`）：否则刷新后"文档凭空少了一半"很难自查；服务端标签被清空后前端也会撤掉已失效的筛选，避免树里一片空白而筛选条上已无 chip 可取消。④ **数据与迁移**：`store.favorites`（path → 收藏时间戳，存时间而非 `true` 才能按"最近收藏"排序）与 `store.tags`（path → string[]），沿用 `alias` 那套端点约定新增 `POST /api/favorite`（省略 `favorite` 即切换；已收藏时重复收藏不刷新时间戳，避免误触打乱收藏夹顺序）与 `POST /api/tags`（整组覆盖，空即删 key）；`/api/state` 的 fileMap 加 `favorite`/`favoritedAt`/`tags`，顶层加 `favorites`/`allTags`；`/api/rename` 的迁移块补上这两个字段（漏一个用户就会觉得"改个名字东西就丢了"）。删文件后的清理走 `/api/state` 惰性剪枝而不是 chokidar 的 unlink 回调（那里每个事件都要 `loadStore+saveStore`，批量删除会连着打很多次盘），并用 `fs.existsSync` 兜底：条目不在扫描结果里可能只是用户在设置里取消勾选了 Markdown，不该因此丢掉 md 文件的收藏。顺手修掉 `migrateStore` 旧版 `folders` 分支返回手写字面量、缺 `shares`/`seenVersions` 的问题（改成递归自身补齐）。⑤ **修掉一个共享组件的缺陷**：`showDialog` 对「取消」和「清空输入后确定」都返回 `null`，调用方无法区分——第一版标签编辑因此点「取消」会把标签清光。新增 `allowEmpty` 选项（确定返回 trim 后字符串、可以是空串；取消仍返回 `null`），"可清空的字段"从此有正确语义。⑥ **修掉三个既有 spec 的假通过**：`drag-hover-expand` / `drag-stress` / `drag-to-root` 都从文件行左侧硬编码 `+30px` 起拖，而那个位置现在正是被 Sortable `filter` 排除的星标，拖拽根本不启动；前者断言严格所以直接红了，后两者只断言"页面仍响应"会静默变绿。全部改成按 `.file-name` 定位。新增 spec `favorites-and-tags.spec.js`（72 项，含"在星标上拖 70px 不产生 ghost / 不把排序切成自定义 / 不打开文档"这组回归），已挂进 `npm test` 与 CI。全套 31 个 spec 全绿。

- **0.9.1** (2026-08-20) — Bug 修复：**Markdown 文档点过目录 / 标题锚点后，右上角刷新按钮报 `Cannot GET /raw/<n>/<目录>/`**（0.8.0 引入的隐性回归）。根因是 `<base href>` 同时改变了「相对 URL」的解析基准：0.8.0 为了让 md 里 `![](./assets/x.png)` 这类相对图片能加载，给 `/api/render-md` 渲染出的预览页注入了 `<base href="/raw/<n>/<md 所在目录>/">`；但这个 base 也是 `history.replaceState()` 和 `href="#锚点"` 的解析基准 —— 点一下 TOC 项，`replaceState(null,"","#第二节")` 会被解析成 `/raw/<n>/<目录>/#第二节`，iframe 里文档的 URL 就悄悄从 `/api/render-md?path=…` 漂移成了那个**目录**；随后刷新按钮的 `contentWindow.location.reload()` 去 GET 一个目录，`express.static` 找不到 index 就落到 404。① `public/vendor/markdown.js` 的 tocScript 把 `replaceState` 的相对 hash 改成带真实路径（`location.pathname + location.search + "#id"`），不再经 base 解析。② 同一个坑还有更直接的一条路：标题 hover 锚点 `.md-anchor` 与 md 正文里手写的 `[x](#y)`，`href="#id"` 同样按 base 解析，**点一下就整页跳到 `/raw/…/` 404，根本不用按刷新**（0.8.0 只修掉了这类链接被加 `target="_blank"` 的问题，没意识到 base 会让它们跳出本页）。现在 enhanceScript 统一接管：凡 `href` 原始值以 `#` 开头的链接都 `preventDefault` + 自行 `scrollIntoView` + 只安全改 hash，TOC 链接（带 `data-target`）交回 tocScript 处理不重复。③ `public/app.js` 新增 `reloadPreviewDoc(canonicalUrl)`：刷新前先比对 iframe 实际 `pathname/search` 与 canonical 地址（md → `/api/render-md`，html → `/raw/`），一致才 `reload()`（保留 hash / search），跑偏了就重新赋 `src` 并带上原 hash 以便仍定位到原章节；刷新按钮与退出编辑恢复只读预览（`exitEditMode`）两处都收敛到它 —— 即使将来再有别的原因让内层文档 URL 漂移，刷新也不会 404。顺带修掉 `exitEditMode` 里用 `els.preview.src`（DOM 属性，内层文档导航后不会变）判断"是否同一份文档"这个失效判据。全套 30 个 spec 全绿。

- **0.9.0** (2026-08-17) — 新功能：**Markdown 编辑器的源码 ↔ 预览对应区域高亮**。此前左右两栏只有百分比滚动同步，光标落在源码某一段时，右边预览里对应哪块内容全靠自己数——文档一长就完全对不上。现在光标 / 选区落在任一侧，另一侧会同步标出对应内容：光标所在块用细高亮（左侧竖条 + 淡背景），跨块选区把覆盖到的块全部标成更明显的选中态，两个方向都生效。① 映射复用 0.8.0 为保真往返而建的块级锚点：`withRaw()` 除 `data-md-raw` / `data-md-gap` 外再写入 `data-md-line` / `data-md-endline`（1 基闭区间）；`render()` 新增 `opts.lineOffset`，`renderBody()` 把 front matter 占掉的行数作为偏移传下去，否则带 front matter 的文档整篇行号都会偏。② 源码侧的高亮不能靠 textarea 本身——它承载不了任何装饰，而且不聚焦时原生选区根本不绘制。所以在 textarea 下面垫一层色带（`.md-source-hl`，textarea 背景改透明），位置由一个与 textarea 同盒模型的隐藏镜像元素量出来，因此**软换行折出的多个视觉行也能完整覆盖**。踩到的坑：`getClientRects()` 返回的是「内联盒」（13px 字体约 15px 高）而不是「行盒」（line-height 21.45px），内联盒在行盒里垂直居中，直接拿来画会整体偏下约 3px 且高度只有半行；现在按行高把半行距还原回去，实测对齐偏差 ≤1px。③ 预览 → 源码的选区解析用 `range.intersectsNode()` 而不是只看首尾容器——全选、跨块鼠标拖选、`setStartBefore/setEndAfter` 产生的 Range，边界容器往往是预览面板本身（带 offset 指向子块）或空白文本节点，只看首尾容器会漏判；`topLevelBlockOf()` 也加了"节点必须在面板内"的前置判断，避免一路 `parentElement` 爬出面板返回无关祖先。④ 粒度是块而非字符：Markdown → HTML 之后字符级对应关系并不成立（源码里选中 `**粗` 这半截，HTML 里没有任何东西与之对应），块级才是稳定且有意义的单位。⑤ 色带随源码滚动只改 `transform`、不重新测量；分栏宽度变化会重新测量（软换行位置变了）。⑥ 顺带把源码区结构从「textarea 直接做 flex 子项」改成「`.md-source-wrap` 三层叠放（色带 / textarea / 测量镜像）」。新增 spec `md-sync-highlight.spec.js`（24 项），已挂进 `npm test`。全套 30 个 spec 全绿。

- **0.8.1** (2026-08-17) — Bug 修复：**分享弹窗与设置弹窗右上角的 ✕ 关闭按钮点击无效**（0.8.0 引入的回归）。成因是 0.8.0 为可访问性把 ✕ 的图标包进了 `<span aria-hidden="true">`（避免屏幕阅读器去读符号本身），但关闭判断仍写作 `e.target.dataset.close !== undefined` —— 点在图标上时 `e.target` 是那个 span，它没有 `data-close` 属性，于是判断失效、按钮完全没反应，用户只能靠点遮罩或按 Esc 退出。现在抽出 `isCloseTarget()` 统一用 `closest('[data-close]')` 往上找，四处调用点（设置弹窗 / 分享弹窗 / ⌘K 面板 / 应用内确认框）全部改用它，未来再嵌套图标也不会重犯。② 顺带修掉一个相邻问题：`openShareModal()` 结尾调的是全量 `render()`，会把用户刚点的那个分享按钮连同整行 DOM 一起销毁重建，导致弹窗关闭时焦点无处可还（记下的 `prevFocus` 已成游离节点），几百篇文档时还白白重排一遍侧栏。新增 `updateSharedDecorations()` 只切换受影响文件行的 `.shared` 标记与角标，替换掉 6 处为了刷分享角标而做的全量 `render()`。③ 新增回归 spec `modal-close.spec.js`（22 项），把每个弹窗的每条关闭路径都钉住——✕ 按钮（含精确点在图标 span 上）、遮罩、Esc、关闭后焦点归还，以及"点弹窗内部标题不会误关"；已挂进 `npm test`。全套 29 个 spec 全绿。

- **0.8.0** (2026-08-17) — 一轮系统性评审后的集中修复与增强。**① 修掉三个实测确认的交互 bug**：全局单键快捷键只排除了 `isContentEditable`，而 `<input>`/`<textarea>` 的该属性是 `false`，于是每敲一个 `/` 焦点就被弹到搜索框——设置里的「扫描根路径」输入框实测输入 `/Users/x` 得到空字符串，绝对路径根本打不进去；现在统一用 `isTypingTarget()` 排除 INPUT/TEXTAREA/SELECT。⌘B 在 Markdown 编辑器里会去收侧边栏而不是加粗、⌘S 完全没被接管（触发浏览器"保存网页"），两者都已按上下文分流。**② 修掉 Markdown 渲染的四处硬伤**：`renderPage` 不注入 `<base href>`，预览页 URL 是 `/api/render-md?path=...`，导致 `![](./assets/x.png)` 被解析成 `/api/assets/x.png` → md 里的本地图片全部 404（修法就在隔壁：HTML 编辑文档早已注入 base）；YAML front matter 被当成「分割线+段落+分割线」渲染成乱码；正文里手写的 `#锚点` 链接被加 `target="_blank"` 每点一次开一个新标签页；表格 `display:block` 脱离正常流让宽表格的滚动条很难发现。**③ 修掉所见即所得编辑的信息丢失**：过去在预览里改一个字会重新序列化整篇文档，表格对齐 `:---:` 退化成 `---`、软换行段落被压成一行——对 git 版本化的文档就是满屏无意义 diff。现在 `render()` 给每个顶层块记下原始源码（`data-md-raw`）与块间距（`data-md-gap`），只有真正被碰过的块（`data-md-dirty`）才重新序列化，实测改一个标题后全文逐字节不变（唯一规范化是文件末尾补一个换行符）。**④ Markdown 呈现增强**：深色模式（配色全面改为 CSS 变量驱动，此前预览页硬编码白底，深色壳子里嵌一块刺眼白板，编辑器更是左半深色右半纯白）、代码块语言标签 + 一键复制、GFM 任务列表渲染成真复选框、标题 hover 锚点、宽表格横向滚动层。**⑤ Markdown 编辑器**：分栏可拖拽（此前 50/50 写死）+ 双击复位 + 方向键微调、回车自动续列表（无序/有序序号自增/任务）、Tab 多行缩进与反缩进、格式工具条、可折叠大纲、⌘B/⌘I/⌘K/⌘E、崩溃后可恢复的本地草稿（此前只有 `beforeunload`，进程崩了就没了）、支持导出 PDF（此前按钮直接 disabled）。**⑥ 可访问性**：弹窗支持 Esc 关闭、`role=dialog`/`aria-modal`、Tab 焦点陷阱、关闭后焦点归还（此前一个都没有，Tab 会跑到弹窗背后）；全部 6 处 `confirm()` 与 2 处 `prompt()` 换成应用内对话框；emoji 图标按钮补 `aria-label`（此前屏幕阅读器只会读出 emoji 名字）。**⑦ 新功能**：⌘K 快速打开（模糊子序列匹配文件名/备注/项目）、重命名磁盘文件（此前只能改显示用的备注名）、**和上次已读版本对比**——未读红点只回答了"AI 动过这个文件"，这个功能补上"动了什么"：用户每次打开文档时把内容存一份底本到 `~/.atlas/versions/`，之后可逐行 diff（新增 `lib/diff.js`，Myers O((N+M)·D)）。**⑧ 性能**：`/api/state` 与 `/api/search` 原来每次请求都全盘递归 walk，而前者每 60s + 每次切回前台 + 每个文件事件都会被调用；改为 chokidar 增量维护的内存索引后，603 篇文档下 `/api/state` 从 18~28ms 降到 4.7ms、搜索冷启动从 528ms 降到 22ms，且不再每分钟无意义重写 `store.json`。搜索支持多关键词 AND 与引号短语，内容缓存从"按 mtime 淘汰"改成真正的 LRU。**⑨ 安全**：局域网分享此前服务的是被分享文件所在目录的整棵子树——分享 `~/Documents/report.html` 等于把整个 `~/Documents/` 开放给拿到 token 的人；现在默认只放行文档真正引用到的资源（HTML 属性 + srcset + CSS `url()` + md 图片，跟一层引用），并保留 `scope=dir` 逃生口给在 JS 里动态拼路径的页面。token 也不再永久有效（默认 2 小时，可选 30 分钟 / 24 小时 / 不过期），过期返回 410 并自动从 store 清理。**⑩ 杂项**：编辑备份的扩展名跟随源文件（此前 `.md` 被备份成 `.html`，且 pruneOld 只筛 `.html` 导致 md 备份永不淘汰）；请求体上限提到 8MB 使路由自己的 5MB 提示可达，并把 body parser 错误翻译成 JSON；`/raw` 路由不再 splice `app._router.stack`（依赖 Express 内部结构，Express 5 已移除该字段）。**新增 9 个 spec 共 287 项断言**：`md-render-and-roundtrip` / `md-editor-ux` / `quickopen-a11y-rename` / `md-pdf-export` / `index-perf-and-search` / `share-security` / `diff-algorithm` / `diff-view` / `misc-hardening`，全部挂进 `npm test`；同时修了 `toast.spec.js` 与 `preview-live-edit.spec.js`——它们靠 `page.on('dialog')` 应答原生 confirm，弹窗改成应用内后失效，新增 `autoAcceptDialogs()` helper 顶上。全套 28 个 spec 全绿。

- **0.7.3** (2026-08-04) — Bug 修复：解决「文档点开没反应 / 刷新按钮一直转」的页面假死，以及「改扫描根后界面毫无反馈」。① `public/app.js` 修掉 SSE 连接泄漏——`connectSSE` 的 `onerror` 原本每次都排一个 3s 后的重连 timer，多个 timer 各建一条 `EventSource`，而函数只 `close()` 得到 `evtSrc` 这一个引用，其余实例丢引用却仍占着连接；浏览器对同源 HTTP/1.1 只给 6 个连接，泄漏满 6 条后整页所有请求（预览 iframe、`/api/state`）永久排队，表现为点文档打不开、刷新按钮无限转圈。现在重连排程唯一化，`onerror` 先判断实例是否已被取代（僵尸连接直接关闭不参与重连），并主动 `close()` 后再统一排程，避免浏览器自动重连与手动重连叠加。② `public/app.js` 给 `/api/state` 加 15s `AbortController` 超时 + 指数退避自动重试（1s→30s 上限）：此前该 fetch 无超时，连接池被占满时永久 pending 导致 `finally` 不执行、刷新按钮永远停在 scanning 且页面再也不会自愈；同时进入失败态后重试不再点亮转圈动画（只留统计栏文字提示），并让新请求取代仍在飞的旧请求，消除并发 `fetchState`（手动刷新 + SSE 推送 + 重试）各占一个 scanning 计数导致按钮长期转圈、旧响应后到覆盖新数据的问题。③ `server.js` 修掉改扫描根时的数十秒假死：`PUT /api/config` 原本先同步 `startWatchers()` 重建**全部** chokidar watcher 再返回响应，大目录（含 `node_modules` 等）遍历建监听要几十秒，浏览器侧实测 8.3s 才收到响应头，前端等不到结果 → 既不弹 toast 也不刷新列表，看起来就是「点了没反应」。现在配置写盘后立即响应，watcher 同步挪到响应之后异步执行；并把 watcher 改为按扫描根增量增删（`watchers` 从数组改为 `Map<root, watcher>`，新增根只建新 watcher、移除根只关对应的、不变的根保持不动），仅 `ignore` / `maxDepth` 变化时才全量重建。浏览器侧添加扫描根耗时从 8271ms 降到 8ms。④ 新增回归 spec `sse-leak-and-retry.spec.js`（13 项，含反向验证：故意用旧的泄漏写法建 4 条连接，确认断言真的会判失败而非空断言），已挂进 `npm test`。⑤ 修 `inline-edit.spec.js` 过时断言：测试算「原文件名」时只剥 `.html`，0.6.0 起支持 Markdown 后对 `.md` 目标文件永远算出带后缀的值，与产品 `stripDocExt` 不一致导致该项恒失败；改为与产品一致的 `/\.(html?|md|markdown)$/i`。⑥ 同步 landing page 版本号与 `package-lock.json`。

- **0.7.2** (2026-07-16) — Bug 修复：解决一键自升级重启后，部分 Chromium 浏览器可能把 `localhost` 标签保留为空文档、而 `127.0.0.1` 仍正常的问题。① `server.js` 为 Dashboard 的 HTML、脚本和样式等静态资源统一发送 `Cache-Control: no-store`，避免升级期间替换全局包文件后继续复用旧 shell、旧脚本或异常空文档缓存。② `public/app.js` 在确认新服务上线后不再调用普通 `location.reload()`，改为携带目标版本号与时间戳执行 `location.replace()`，强制建立一次全新导航；`localhost` 继续通过 Node 默认 IPv4/IPv6 双栈监听正常访问，无需改用 `127.0.0.1`。③ 同步更新 landing page 与 package lock 版本。

- **0.7.1** (2026-07-16) — Bug 修复 + UX 优化：① `server.js` 的局域网分享路由现在会读取 `.md` / `.markdown` 文件并通过共用 Markdown 渲染器返回完整 HTML 页面，同事通过分享链接看到的是渲染后的文档预览，不再是 Markdown 原文；HTML 与其他静态资源继续按原方式发送。② `public/styles.css` 隐藏目录树中与文件类型 icon 重复的 `HTML` / `MD` 彩色角标，仅保留紧凑的类型 icon，同时缩小元素间距和 icon 宽度，并为标题补上 `min-width: 0`，让长标题优先获得空间且继续正确省略。③ `public/vendor/markdown.js` 为链接与图片 URL 增加安全协议白名单，阻断 `javascript:` 等主动内容协议，避免分享页访问者点击恶意链接时执行脚本。④ 同步更新 landing page 文案与 `package-lock.json` 根包版本。⑤ 根据当前 21 个合法发布文件校正 `npm publish --dry-run` 的清单数量范围。

- **0.7.0** (2026-07-13) — 新功能 + UX 修复：**Markdown 只读预览的可折叠侧边目录（TOC）**，以及退出编辑保持浏览位置。① `public/vendor/markdown.js` 的 `renderPage`（服务端 `/api/render-md` 渲染 iframe 只读预览用）重写：新增 `extractHeadings`（给渲染后的 h1–h6 注入去重的锚点 id，中文/连字符保留）、`buildTocTree`/`tocTreeHtml`（按标题 level 组织成嵌套树）、`tocCss`/`tocScript`；页面结构改为「固定侧栏目录 + 居中正文 `.md-inner`」。目录支持：按层级三角折叠展开、点击平滑滚动跳转、`IntersectionObserver` 滚动高亮当前章节并自动展开其父级、左上角独立收起按钮（`localStorage` 记忆 `atlas:mdTocCollapsed`）、窄屏（≤900px）浮层化并点后自动收起。标题少于 2 个的文档不显示目录（正文照旧居中），编辑器分栏预览（用 `render`/`htmlToMarkdown`）完全不受影响。② 修复正文滚到底后靠后标题的锚点跳不动：正文末尾加 70vh 占位留白 + 标题 `scroll-margin-top`。③ `public/app.js`：退出 Markdown 编辑（保存 / 取消都走 `exitEditMode`）时记录编辑器预览面板的滚动**百分比**，iframe 重载后按同比例恢复浏览位置（新增 `pendingPreviewScrollPct` + `applyPendingScrollPct`，换算时从可滚动高度里扣除 `.md-tail-space` 留白，强制 `scroll-behavior:auto` 避免回顶动画），不再跳回顶部。同步更新 `README`（Markdown 段）与 `docs/index.html`（「HTML + Markdown 双模」特性卡）。

- **0.6.0** (2026-07-13) — 新功能：**Markdown 文档支持**（HTML 与 Markdown 可共存）。① 配置从单一 `docType` 升级为多选 `docTypes`（数组，默认 `["html","md"]`，兼容旧 `docType` 字段），设置面板新增「文档类型」复选框，HTML（`.html`/`.htm`）与 Markdown（`.md`/`.markdown`）可同时启用；仅 `docTypes` 变化时不重启 chokidar / 不重挂静态路由（事件回调按类型实时过滤），切换更顺不卡。② 新增零依赖 UMD Markdown 渲染器 `public/vendor/markdown.js`（服务端与浏览器共用，全文转义防 XSS，支持标题/粗斜体/删除线/行内与围栏代码/链接/图片/嵌套有序无序列表/引用/分割线/GFM 表格），并含反向序列化器 `htmlToMarkdown`。③ 后端新增 `GET /api/render-md`（渲染只读预览页）、`GET /api/md-source`（原始源码 + 哈希）、`POST /api/save-md`（baseHash 冲突检测 409 + 备份 + 原子写 + 自我写入抑制）；`/api/state` 与 `/api/config` 携带 docTypes，逐文件带 `docType`；全文搜索对 md 直接按纯文本匹配。④ 前端：md 文件预览走 `/api/render-md`；**源码 / 预览分栏编辑器**——左侧 textarea 每帧实时渲染右侧预览、两侧按百分比滚动同步、进入编辑保持进入前的浏览位置（不再跳到末尾）；**预览区 contentEditable 所见即所得直接编辑**，编辑即反解析回源码。⑤ 目录树按类型区分：HTML 🌐 蓝 `HTML` 角标、Markdown 📝 绿 `MD` 角标 + `data-doctype`，面包屑同步标识；md 文件禁用 PDF 导出（暂仅支持 HTML）。同步更新 `README`、`docs/index.html`（新增「HTML + Markdown 双模」特性卡、hero 文案）与 `package.json`（描述 / 关键词加 markdown）。

- **0.5.1** (2026-07-01) — Bug 修复：`localhost` 打不开的问题。服务器原先 `app.listen(PORT, '0.0.0.0')` 显式绑定只监听 IPv4，而在 `localhost` 优先解析到 IPv6 `::1` 的机器上（尤其叠加本地代理时），浏览器连 `http://localhost:<port>` 会先撞 `::1`（服务器没监听）→ 卡住 / 报错，表现为「能扫描到目录但点开文件白屏/报错」。改为不指定 host（Node 默认绑定 `::` 双栈，同时接受 IPv6 `::1`、IPv4 `127.0.0.1` 与局域网）。安全中间件的本机判定（`LOCAL_ADDRS`）本就包含 `::1`/`::ffff:127.0.0.1`，故本机/局域网权限模型不变。临时绕过：用 `http://127.0.0.1:<port>` 访问。

- **0.5.0** (2026-06-30) — 新功能：**预览区轻量所见即所得编辑**。进入编辑模式后可在预览里直接改文案、拖动列表项 / 表格行 / 同类卡片组排序、以及编辑超链接地址，保存写回磁盘原文件。① 架构「源码锚点」：新增 `lib/editable.js`（parse5 解析源文件、确定性遍历分配 eid、判定可编辑角色 text/list/list-item + 排除 script/style/svg/canvas/pre/code 等风险标签）、`lib/edit-apply.js`（按 eid 精确区间替换文本节点 / 子树重写重排容器，只动改过的字节、其余原样，不序列化运行时 DOM → 图表不被烤坏）、`lib/edit-backup.js`（写盘前备份到 `~/.atlas/backups/`，每文件留 20 份）。新增依赖 `parse5`。② 后端新增 `GET /api/edit-doc`（返回带 `data-atlas-eid`/`role` 标注 + 包裹 span 的编辑文档，注入 base href 与 baseHash）与 `POST /api/save-edits`（baseHash 冲突检测 409、路径/扩展名/体积校验、原子写、自我写入抑制避免误标未读）。③ 前端：工具栏「编辑/保存/取消」按钮 + 编辑态视觉标识；文本节点 contentEditable（混排 `<p>前<b>中</b>后</p>` 的每段独立可编辑）；列表用注入到 iframe 内的 Sortable 拖动重排（`forceFallback`，从文字上按下不误触）；链接内文字聚焦浮出 href 编辑条；编辑态拦截 `<a>` 跳转 / 表单提交避免误导航；进入编辑与保存都瞬间保持滚动锚点（强制 `scroll-behavior:auto` 避免平滑滚动动画）。④ 卡片重排保守识别：仅「同标签+同 class、≥3 个、连续」的同构卡片组可拖，异质子元素（标题/底部）排除。新增 spec `preview-live-edit.spec.js`（32 项，自起隔离实例），已加入 npm test / CI / 本文档 spec 清单，并同步 `docs/index.html` 特性卡与 README。

- **0.4.6** (2026-05-26) — UX 修复：用户 `npm i -g` 升级 atlas 但忘了 `atlas restart` 时，跑着的 daemon 还是旧版本 server.js（无 `/api/share/*` 路由）→ 点分享按钮报 `HTTP 404` 让人摸不着头脑。① 启动时探测 `/api/shares`（0.4.4+ 新加端点），404 就弹 info toast 提示"Atlas 服务是旧版本——在终端运行 atlas restart 重启即可"。② 点 share 按钮命中 404 时改文案："分享功能不可用 / Atlas 服务还在跑旧版本——请在终端运行 atlas restart 重启"。

- **0.4.5** (2026-05-26) — ① 新功能：**Atlas favicon**——蓝紫渐变圆角方块 + 白色 line 风 A 字母，沿用 sidebar brand mark 视觉，SVG 矢量，128/48/32/16 全尺寸清晰。同时挂到 dashboard 和 landing page。② UX：顶栏右上角加**分享按钮** `#btn-share`——点击 = 对当前预览文件 openShareModal（已有 token 复用）。当前文件正在分享时按钮变 accent 蓝边框 + 蓝色 icon，一眼看出状态（不用 hover 文件行才看到角标）。③ UX：「在浏览器新标签打开」按钮 ⤴ emoji 容易和分享 icon 混淆，换成 lucide 风的 external-link line icon（方框 + 右上斜出箭头 + 内部小开口），和分享按钮的"三圆点连线"完全区分。

- **0.4.4** (2026-05-26) — ① 新功能：**局域网分享 + 二维码**。文件 hover 出 🔗 按钮，弹 modal 含大二维码 + 三种 URL（多网卡 + 本机）+ 复制按钮 + 停止按钮。token 16 字符不可猜，store 持久化（atlas 重启不失效）。**安全**：Express 中间件按来源 IP 分流——localhost 全开 dashboard，LAN 访问 403，仅放行 `/share/<token>/*`，path traversal 严格防御（resolve 后必须仍在原 HTML 同目录子树）。② 新功能：归档项目分组——删除文件夹不再"删完自动回来"，而是进入归档列表，下次扫描跳过。磁盘文件不动，设置面板可恢复。③ 安全开关：设置面板加"停止全部分享"红色按钮（评审完一键关）。④ UX：设置 icon 从 ⚙ emoji（在 light 主题下渲染像眼睛）换成 SVG 齿轮 line icon，识别度高。⑤ 启动 banner 多打印一行 LAN IP 让用户知道"分享时同事会看到的 URL 是什么"。

- **0.4.3** (2026-05-26) — ① 新功能：**导出 PDF**。顶栏新加按钮，后端调本机 Chrome / Edge / Brave / Arc / Vivaldi / Chromium 任一（macOS / Linux / Windows 候选路径全覆盖）的 `--headless=old --print-to-pdf` 渲染，布局 100% 保真。SSE 推阶段进度（launching / rendering / writing），前端 toast 升级支持 progress 模式（不自动消失 + 旋转图标 + 底部 indeterminate accent 流动条 + 阶段文字）。同名自动加 `(2)`/`(3)` 后缀，文件名清洗中文 / 特殊字符。串行队列避免快速连点冲突，自动重试一次应对 Chrome `allocator` 间歇 bug。找不到 chromium 时降级到 `iframe.contentWindow.print()` 弹原生打印对话框。② 新功能：**三档排序** segmented control（按名称 / 按时间 / 自定义），默认按名称——系列文档（v1/v2/v3）自然聚合。直接拖动文件自动切到"自定义"。`localStorage` 持久化。③ 新功能：**单文档刷新**按钮——刷当前 iframe，不刷整个 Dashboard，树展开 / 滚动 / 最近列表全保留；刷完顺便标已读清红点。④ 排序 UI 改 IDE 工具栏 inline 风（无外框、accent 文字色 + 短下划线 active 标识），"仅未读" checkbox 合并到同一行；右下角 toast 反馈 → 按钮自身高亮反馈。

- **0.4.2** (2026-05-25) — ① 新功能：发版第一时间通知用户。server 端 npm 检查频率从 24h 改 1h，发现新版本立即通过 SSE 推到所有打开的 tab；新连接进来也立即推已知更新。② 新功能：醒目的更新 banner（顶栏下方一条 36px 的 IDE 风格通知条）—— 红点脉动 + accent stripe + "立即更新"主按钮 + 命令块兜底（点击复制 `npm i -g atlas-dashboard@latest`） + ✕ 关闭。dismiss 过的版本 localStorage 记忆，新版本到来时自动重新弹。③ **一键自升级**：banner "立即更新"按钮触发 `/api/self-upgrade` SSE 流——后端 spawn `npm i -g atlas-dashboard@latest`，stdout/stderr 实时回推，banner 切到 busy 模式（流动进度条 + 阶段文字 + 可折叠"查看日志"）；安装完成 spawn 独立 helper 脚本（`lib/restart-helper-template.js`）等老 server 退、启动新版；前端轮询 `/api/state` 等新 server 上线，自动 reload 页面。失败切换到 error 态显示原因 + [重试] 按钮 + 命令兜底。④ 桌面通知：发现新版本时（已授权 Notification）每个版本会话发一次。

- **0.4.1** (2026-05-25) — ① 新功能：增/删扫描根、保存失败时给右下角 toast 反馈（success / info / error 三类，~2.8s 自动消失，可手动关闭）。② 重要稳定性修复：当扫描根下存在 unix socket / 锁文件（如 `axon.sock`）时，chokidar 抛 UNKNOWN error 直接打挂 server。给 watcher 注册 error handler 并把 `.sock/.lock/.pid` 加入忽略列表。③ 命名优化：散落在扫描根直接根目录下的 HTML 之前会被归到一个叫 `_root` 的兜底虚拟文件夹，开发味儿太重；现在 fallback 改成 `path.basename(scanRoot)`（如 `OtherHTML`），并提供一次性自动迁移把已有 `_root` 改名。④ 0 个 HTML 后代的空虚拟文件夹自动从树里剔除，避免删 HTML 后留一堆空壳 noise。新加 spec `toast.spec.js`（11 项），并加入 npm test 与 CI workflow。

- **0.4.0** (2026-05-25) — 新功能：Dashboard 设置面板加"浏览…"目录选择器，**不用再手输扫描根的绝对路径**。后端新增 `GET /api/browse` 端点（按 OS 权限列出目录、`~` 自动展开 home），前端在 root-add 区下方展开 picker UI（面包屑路径 + ↑ 上级 + ⌂ 主目录 + 子目录列表 + 「选择此目录」），同步 `docs/index.html` 的"多扫描根"卡。新加 spec `dir-picker.spec.js`（14 项）。

- **0.3.2** (2026-05-22) — 修复 folder header 点击有时不响应（要点 2-3 次才能折叠/展开）。和 0.3.0 file 那个 click bug 同源——SortableJS forceFallback 模式吞掉 click 事件。folder header 也改用 `pointerdown` 记位置 + `pointerup` 检查偏移触发 toggleFolder，绕开 click 事件链。新加 spec `folder-toggle-with-jitter.spec.js`（4 项）。

- **0.3.1** (2026-05-22) — ① 修复全文搜索：中文单字（如"灯"）原本被 `q.length < 2` 拦截不发请求。后端区分 ASCII / 非 ASCII，中文/日文/韩文等单字符放行，ASCII 仍要求 ≥ 2 字符避免 'a' 这种太宽的查询。② 新功能：打开文件后 iframe 内自动高亮命中文字（同源直接操作 contentDocument，TreeWalker 注入 `<mark>`），首个匹配自动滚到中间标橙色，顶栏出现 `1 / N` 跳转徽章 + ▲▼ 按钮，搜索框 Enter / Shift+Enter 也能跳。

- **0.3.0** (2026-05-22) — ① 修复：鼠标点击文件时若有 1-3px 抖动会被 SortableJS 当成拖拽吞掉 click，表现为"点 3-4 次才打开"。改用 pointerdown 记位置 + pointerup 检查偏移触发 openFile，绕开 click 事件链。② 升级提示：CLI 启动时显示新版本可用（每天最多查一次，缓存到 `~/.atlas/update-check.json`）；Dashboard 顶栏右侧出现脉动小标签，点击复制升级命令。③ GitHub Releases 自动化：push tag `v*` 时 workflow 抽取 PUBLISHING.md 当版本描述自动创建 Release。
- **0.2.1** (2026-05-22) — 修复：键盘导航留下的 `.kbd-focus` 视觉态没自动清除，与 `.active` 同时出现造成"多个文件被选中"的视觉异常。`setActiveFile` 切换 active 时统一清掉 kbd-focus，CSS 上 kbd-focus 改为 outline-only（不再争夺背景色）。
- **0.2.0** (2026-05-22) — 三个功能改进：① 键盘导航（搜索框 `↓` 进列表、`↑↓` 切换、`Enter` 打开、`Esc` 回搜索）；② 最近打开快捷栏（侧栏顶部 LRU 队列，最多 10 项，跨项目秒回）；③ HTML 全文搜索（后端 contains 匹配 + mtime 缓存，仅内容命中的文件标 🔍）。GitHub Actions CI 落地（push/PR 自动跑测试）。
- **0.1.2** (2026-05-21) — 加拖拽 hover-to-expand：拖文件悬停在折叠 folder 头上 600ms 自动展开。`forceFallback: true` 让 SortableJS 走统一 mouse 事件路径；`document.mousemove + elementFromPoint` 检测鼠标下方真实元素（onMove 不可靠，只在 sibling 切换时触发）。同步 `state.collapsed` + localStorage 持久化。
- **0.1.1** (2026-05-21) — 加 `atlas start / stop / restart / status / log` 守护进程子命令。PID 文件升级为 JSON（含端口 + 启动时间），status 准确显示真实端口。不再依赖用户本地 `~/.zshrc` alias。
- **0.1.0** (2026-05-21) — 首次发布。CLI、首次引导、嵌套分组、桌面通知、备注名等全部功能就位。
