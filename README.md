# ChatResume

让你自己的 Agent，通过对话驱动简历 GUI，实时查看修改效果。

左侧提出修改要求，右侧展示 A4 简历预览。支持直接编辑文字、管理多份简历、检查分页和导出 PDF。

## 快速开始

准备 **Node.js 22+**。分页检查和 PDF 导出还需要本机 Chrome / Edge 等浏览器。

使用自己的 Agent 即可，不限定厂商、形态或版本。支持命令行、HTTP 服务和外部 Agent 主动连接；Claude / Codex 是可选适配器。

```bash
git clone https://github.com/Raininghaha/ChatResume.git
cd ChatResume
npm install
npm start
```

打开 `http://localhost:8790`，在网页左下方选择连接方式。选择「自己的 Agent」时，由你的 Agent 领取消息并回传回复和修改。macOS 也可双击 `启动.command`。

## 给 Agent 使用

让 Agent 阅读 [AGENTS.md](AGENTS.md)，即可通过命令行或直接编辑文件使用项目。

```bash
# 使用 Codex 修改当前简历
npm run resume -- ask --runner codex "精简工作经历，保留关键成果"

# 检查分页并导出
npm run resume -- check --json
npm run resume -- export -o resume.pdf
```

Agent 按 [通用协议](docs/agents.md) 接入，GUI 不解析其原生版本或模型输出。已有的桌面 Agent、CLI 或服务需要其宿主提供连接能力，或通过一个适配程序转换协议。

具体配置见 [Agent 接入说明](docs/agents.md)。

## 数据存放

简历、图片和会话默认保存在 `~/.resume-chat/`，与代码分开，不进入仓库。可用 `RESUME_HOME` 指定其他目录。

模型调用沿用本机 Agent CLI 的登录和配置；简历内容可能发送到其配置的模型服务。

## 更多说明

- [使用指南：命令、配置、远程访问与常见问题](docs/usage.md)
- `packages/core`：对话、简历管理、分页检查与 PDF 导出
- `packages/ui`：本地网页、对话框与简历预览

[MIT License](LICENSE)
