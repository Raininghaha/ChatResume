# ChatResume

用对话修改简历，实时查看效果。

左侧提出修改要求，右侧展示 A4 简历预览。支持直接编辑文字、管理多份简历、检查分页和导出 PDF。

## 快速开始

准备 **Node.js 22+**，安装并登录 **Claude Code 或 Codex CLI**。分页检查和 PDF 导出还需要本机 Chrome / Edge 等浏览器。

```bash
git clone https://github.com/Raininghaha/ChatResume.git
cd ChatResume
npm install
npm start
```

打开 `http://localhost:8790`，在网页左下方选择 Agent，即可开始对话。macOS 也可双击 `启动.command`。

## 给 Agent 使用

让 Agent 阅读 [AGENTS.md](AGENTS.md)，即可通过命令行或直接编辑文件使用项目。

```bash
# 使用 Codex 修改当前简历
npm run resume -- ask --runner codex "精简工作经历，保留关键成果"

# 检查分页并导出
npm run resume -- check --json
npm run resume -- export -o resume.pdf
```

内置 Claude 和 Codex；其他 Agent 可通过本地配置接入。能读写文件或执行命令的外部 Agent 也可直接使用，无需依赖 Claude。

具体配置见 [Agent 接入说明](docs/agents.md)。

## 数据存放

简历、图片和会话默认保存在 `~/.resume-chat/`，与代码分开，不进入仓库。可用 `RESUME_HOME` 指定其他目录。

模型调用沿用本机 Agent CLI 的登录和配置；简历内容可能发送到其配置的模型服务。

## 更多说明

- [使用指南：命令、配置、远程访问与常见问题](docs/usage.md)
- `packages/core`：对话、简历管理、分页检查与 PDF 导出
- `packages/ui`：本地网页、对话框与简历预览

[MIT License](LICENSE)
