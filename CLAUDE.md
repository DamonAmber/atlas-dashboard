# 给在这个仓库工作的 AI

你正在 `atlas-dashboard` 仓库工作。这是一个已发布到 npm 的本地 HTML 浏览/管理工具。

## 立即去读这两个文件

1. **[PUBLISHING.md](./PUBLISHING.md)** — 发版流程的唯一权威文档。任何涉及"发新版 / 发布 / publish / release"的工作前必须先读。
2. **[README.md](./README.md)** — 用户视角的功能介绍。

## 必守规则

- **改了发版相关流程**（命令、自动化、tools、token 机制）→ **同步更新 PUBLISHING.md**。这是约束不是建议。
- **加了新的测试 spec**（`tests/*.spec.js`）→ 把它加到 PUBLISHING.md 的"步骤 0：跑全套测试"清单里。
- **加了新的 GitHub workflow**（`.github/workflows/*`）→ 在 PUBLISHING.md 的"自动化（你不用管）"表格里加一行。
- **凭据类信息**（npm token / GitHub PAT / npm recovery codes）**永远不在聊天里贴**——让用户自己在终端里粘到 `~/.npmrc` 或环境变量。
- **`npm publish` / `git push --tags` / `npm unpublish` / `gh release delete`** 是公开/不可逆操作。**先和用户确认**。

## 这个项目的关键事实

- npm 包名：`atlas-dashboard`
- GitHub: `DamonAmber/atlas-dashboard`
- 当前版本：见 `package.json` 的 `version` 字段，或 PUBLISHING.md 顶部的"已发布版本"
- 本地服务默认端口：4321
- 用户配置目录：`~/.atlas/`（含 `config.json` / `store.json` / `update-check.json` / `atlas.pid` / `atlas.log`）
- 测试运行前提：本地有 atlas 服务跑在 :4321，用 `node bin/atlas.js`（项目目录）启动让它读最新代码而不是 npm 包里的旧代码

## 不要做的事

- 不要主动新建 `.md` 文档（除非用户明确要求或 PUBLISHING.md 要求）
- 不要在用户没要求时跑 `npm publish` —— 先确认版本号、跑过测试、改过 PUBLISHING.md
- 不要 `git push --force` 或 `git push --no-verify` —— 这是个公开仓库
- 不要修改 `~/.atlas/store.json`（用户的虚拟分组、备注、已读状态都在里面，破坏会让用户体验受损）
