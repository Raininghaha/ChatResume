# Agent 使用说明

ChatResume 是用对话驱动修改简历的 GUI。使用你自己的 Agent，不要求安装另一家 Agent 或固定模型版本。

## 启动与连接

```bash
npm install
npm start
```

读取 [接入协议](docs/agents.md)。可以使用本地命令、HTTP 服务，或主动领取 GUI 消息：

- POST `/api/agent/next` 领取用户要求与简历 HTML。
- POST `/api/agent/events` 回传回复、`resume` 修改事件和 `done`。
- 网页选择「自己的 Agent」，即可在现有 Agent 会话中提供对话与可视化修改。

Claude / Codex 是可选适配器，不能作为通用连接的前提。不要假设任意桌面 Agent 都有相同 CLI 或可以自动被控制。

## 文件与编辑规则

默认数据在 `~/.resume-chat/`，可用 `RESUME_HOME` 改路径。

```bash
npm run resume -- path --json
npm run resume -- check --json
npm run resume -- export -o /tmp/resume.pdf
```

- 简历是 `resumes/<名字>.html`，完整 HTML、内联样式、A4 版式。
- 图片使用 `../assets/文件名`；打印样式 `.page` 的 `min-height` 为 0。
- 每轮先读当前内容；协议修改带上 revision，避免覆盖其他编辑。
- 只修改本轮指定简历；不编造经历、数据或学历。信息不足时在对话中询问。
- 保留版式，除非用户要求调整；完成后检查目标页数和溢出量。
- 用户的简历、图片、会话、连接凭证和日志不得放入仓库。

退出码：0 成功，1 操作/对话/分页失败，2 用法错误，3 环境缺失。

## 代码结构

`packages/core` 负责通用对话编排、连接协议、简历管理与渲染；`packages/ui` 提供 HTTP 和 GUI。修改接入协议时保留版本兼容；具体厂商适配器放在 `packages/core/lib/runners/`。
