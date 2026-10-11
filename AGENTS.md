# AGENTS.md

给 agent 的说明。人看 `README.md`。

## 这是什么

用自然语言改简历的工具。简历是普通 HTML 文件，存在 `~/.resume-chat/resumes/<名字>.html`。

## 你要做的三步

```bash
npm install                    # 零外部依赖，离线可跑
resume-chat status --json      # 确认可用 Agent 与浏览器就绪
resume-chat ask "<用户的要求>"  # 对话改简历
```

`ask` 正文走 stdout，进度走 stderr；`--json` 下是 NDJSON 事件流
（`{t: 'status'|'tool'|'text'|'session'|'error'|'done', v}`）。

## 改完必须检查

```bash
resume-chat check --json
```

简历最常见的暗病是**内容多两行、悄悄溢到第二页**，肉眼看不出来。
`check` 返回 `{ fits, pages, overflowPx }`；`fits: false` 时退出码是 **1**，
应当把内容压回一页再交付。

## 也可以直接改文件

不想走对话就自己编辑 `~/.resume-chat/resumes/<名字>.html`。规则：

- 单文件 HTML，样式内联 `<style>`，A4 版式（`.page` 是 210mm × 297mm）
- 图片引用写成 `../assets/文件名`
- 打印样式里 `.page` 的 `min-height` 必须是 `0`，否则亚像素误差会把每页撑成两页
- 改完跑 `resume-chat check`

## 别做的事

- 不要编造经历、数字、学历、奖项。信息不够就问用户。
- 不要动 `resumes/` 下其他的简历。
- 不要改简历的整体视觉风格，除非用户明确要求。
- 不要把简历数据写进这个仓库：数据目录是 `~/.resume-chat`，仓库的 `.gitignore` 也挡住了常见落点。

## 退出码

`0` 成功 · `1` check 未通过 · `2` 用法错误 · `3` 环境不满足（缺所选 Agent / 缺浏览器）

## 结构

- `packages/core` —— 内核：简历数据、对话编排、渲染导出。零 HTTP，零界面。
- `packages/ui` —— 界面：HTTP + SSE + A4 预览。依赖 core。

改对话行为看 `packages/core/lib/chat.js` 和 `lib/prompt.js`；
改对话后端看 `packages/core/lib/runners/`。

## 支持任意 Agent

任何能读写文件或运行命令的 Agent（Codex、Claude Code、Cursor、Gemini 等）都可以使用前述 CLI 和直接编辑流程，不需要先安装 Claude。
在仓库内调用 `npm run resume -- <命令>`，无需全局安装。例如：

```bash
npm run resume -- path --json
npm run resume -- check --json
npm run resume -- ask --runner codex "精简最近一段工作经历"
```

网页左下方可以选择对话 Agent。内置 Claude、Codex；默认 `auto` 选择本机可用的 Agent，`RESUME_RUNNER` 可指定默认值。
会话按简历和 Agent 隔离，切换 Agent 不会复用另一家 CLI 的 session。
其它对话后端配置在数据目录的 `runners.json`，详见 `docs/agents.md`。
