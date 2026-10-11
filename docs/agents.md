# Agent 接入

ChatResume 提供两种入口：外部 Agent 直接操作简历文件或调用 CLI；网页/ask 通过 Agent 后端对话驱动修改。对话能力始终属于 core。

## 外部 Agent 直接使用

Codex、Claude Code、Cursor、Gemini 及其它具有文件或命令行能力的 Agent，读 `AGENTS.md` 即可执行：

```sh
npm install --offline
npm run resume -- status --json
npm run resume -- path --json
# 根据 path 返回的路径编辑 HTML，然后：
npm run resume -- check --json
npm run resume -- export -o /tmp/resume.pdf
```

这条路径不需要任何模型后端。没有本地文件或命令能力的 Agent 需要其宿主提供这些工具。

## 内置对话后端

```sh
npm run resume -- runners --json
npm run resume -- ask --runner codex "精简工作经历"
npm run resume -- ask --runner claude "突出项目成果"
RESUME_RUNNER=codex npm start
```

`auto` 优先使用已安装的 Claude，再选择 Codex，再选择自定义后端。可用性检查只检查程序存在；登录状态、额度或供应商网络错误会在对话时返回。
`CODEX_BIN` / `CLAUDE_BIN` 可指定可执行文件路径。网页左下方的 Agent 选择器与 CLI 使用相同注册表。

Codex 使用 `codex exec --json --skip-git-repo-check`，支持 `exec resume` 多轮续接；新请求及续接均指定 `workspace-write` 和 `approval_policy="never"`，不使用绕过沙箱的参数。模型、认证沿用本机 Codex 配置。Codex 的消息以 CLI 的完成消息为单位显示，未承诺 token 级增量。

Claude 使用其工具白名单；Codex 和自定义 Agent 不具备相同工具白名单。提示词要求只修改当前简历，但并非文件级权限隔离：Codex 的可写范围是数据目录，自定义进程沿用本机权限。不要配置不可信的命令。

每份简历与每个后端使用独立会话。`reset --runner codex` 仅清除 Codex 记忆；不传 runner 则清除该简历全部 Agent 的记忆。自定义文本模式每轮独立；NDJSON 模式可提供 session 事件以续接。失效会话可用 reset 清除。

## 接入其它 Agent，无需改源码

在 `RESUME_HOME`（默认 `~/.resume-chat`）创建 `runners.json`，或用 `RESUME_RUNNERS_FILE` 指定文件。命令与参数从本地配置读取，网页只能选择名称，不能注入新命令。所有进程使用参数数组启动，不经过 shell。

```json
{
  "runners": [
    {
      "name": "my-agent",
      "command": "/absolute/path/to/agent-wrapper",
      "args": [],
      "protocol": "text",
      "description": "我的 Agent"
    }
  ]
}
```

`text` 协议：stdin 收到领域规则与用户要求组成的文本，stdout 输出回复，stderr 为诊断信息；退出码 0 为成功。命令或包装程序需要能根据要求修改 cwd 下的简历文件。只提供聊天回复、不能修改文件的模型 CLI 需要由包装程序补上文件编辑能力。

`ndjson` 协议：stdin 收到一行 JSON `{systemPrompt,prompt,sessionId,cwd}`；stdout 逐行输出 `{t,v}`。允许 `status/tool/text/session/error/done`。`session` 的 v 是字符串或 null；`done` 无需 v，其余 v 为字符串。必须输出 done 并以 0 退出。包装程序负责转换对应 Agent 的原生事件和续接参数。

```jsonl
{"t":"status","v":"开始处理"}
{"t":"tool","v":"正在修改简历"}
{"t":"text","v":"已精简工作经历。"}
{"t":"session","v":"my-session-id"}
{"t":"done"}
```

设置完成后运行 `npm run resume -- runners --json` 查看后端，再使用 `--runner my-agent`，或刷新网页选择它。不限厂商，但每家 CLI 的非交互参数和输出协议不同，需要按其能力配置命令或编写薄包装程序。

Codex 非交互协议参考：[官方文档](https://developers.openai.com/codex/noninteractive)。
