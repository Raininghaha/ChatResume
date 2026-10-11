# 连接你自己的 Agent

ChatResume 开源的是对话与简历预览 GUI，以及通用对话编排内核。用户选择自己的 Agent、模型和认证方式。Claude / Codex 只是可选适配器；GUI 启动不需要安装它们。

不限定 Agent 厂商或版本，但 Agent 的宿主必须能调用 HTTP、执行命令或提供适配程序。无法接收外部消息的桌面应用需要其插件或连接层；项目不会自动控制任意应用。

## 通用协议：chatresume/1

GET `/api/agent/protocol` 可读取协议版本和事件类型。每轮输入一个 JSON 请求：

```json
{
  "protocol": "chatresume/1",
  "systemPrompt": "简历编辑规则",
  "prompt": "精简工作经历",
  "sessionId": null,
  "cwd": "/用户本地数据目录",
  "resume": { "name": "我的简历", "html": "完整 HTML", "revision": "内容的 SHA-256" }
}
```

输出事件采用 NDJSON（每行一个 JSON），或通过外部消息接口发送 events 数组：

```jsonl
{"t":"status","v":"开始处理"}
{"t":"text","v":"我会保留关键成果，压缩重复描述。"}
{"t":"resume","revision":"输入请求中的 revision","html":"修改后的完整 HTML"}
{"t":"session","v":"用户 Agent 自己的会话标识"}
{"t":"done"}
```

- `status/tool/text/error` 的 `v` 为字符串；`text` 为追加显示的回复片段。
- `resume` 可选：GUI 内核写入当前简历并触发预览刷新。版本不匹配时拒绝覆盖。多次写入需使用上次提交 HTML 的 SHA-256。
- `session` 可选，`v` 为字符串或 null，由连接层负责恢复自己 Agent 的上下文。
- `done` 必须是最后一个事件，表示本轮结束；失败先发送 `error`。
- 单个事件最多 8 MB，每轮最多十分钟。连接中断或重置后取消任务。
- Agent 也可直接编辑本地文件，此时不发送 `resume`；文件监听会刷新预览。

远程 Agent 收到 HTML 内容；`cwd` 只是服务端路径，远程机器不一定可访问它。图片仍保留 `../assets/文件名` 引用。当前协议不传输图片二进制。

## 方式一：本地命令

在 `~/.resume-chat/runners.json`（或 `RESUME_RUNNERS_FILE` 指定文件）配置：

```json
{
  "runners": [{
    "name": "my-agent",
    "transport": "command",
    "command": "/absolute/path/to/adapter",
    "args": [],
    "protocol": "ndjson"
  }]
}
```

命令从 stdin 读取一行请求，stdout 输出协议事件，stderr 输出诊断，成功后以 0 退出。不经过 shell。包装程序负责将协议转换成自己的 Agent 调用方式。

兼容 `protocol: "text"`：stdin 为编辑规则和要求，stdout 为回复；这种模式需要命令直接编辑本地文件，不支持结构化 resume/session 事件。

## 方式二：HTTP 服务

```json
{
  "runners": [{
    "name": "my-service",
    "transport": "http",
    "url": "http://127.0.0.1:9000/chat",
    "headers": { "Authorization": "Bearer 用户自己的凭证" }
  }]
}
```

GUI 向该地址 POST 通用请求，服务返回 NDJSON 事件流，最后发送 `done`。支持 HTTP/HTTPS；不跟随重定向。配置只从本地文件读取，网页不能提交任意命令或服务地址。凭证保留在本地，不提交到仓库。

这是 ChatResume 协议端点，不是直接填写任意模型 API 地址；已有服务需要把自己的协议转换成上述事件。

## 方式三：外部 Agent 主动连接

适合已经运行中的 Agent、桌面宿主或另一台机器上的 Agent。网页选择「自己的 Agent（外部连接）」，发送要求后等待领取。

1. POST `/api/agent/next`，body 为 `{}`。有任务时返回 `{job:{id,token,request,expiresAt}}`，无任务时为 `{job:null}`。每秒轮询即可。
2. 用自己的 Agent 处理 `request`。
3. POST `/api/agent/events`，body 为 `{id,token,events:[协议事件...]}`。可分批发送，最终发送 `done`。

外部连接的消息队列属于运行中的 GUI 服务；单独运行 CLI `ask --runner external` 不提供消息队列。任务只领取一次；处理程序崩溃时本轮超时失败，需要重新发送。任务队列只存在内存中，服务器重启会丢失待处理任务。重置、关闭对话连接或超时后，任务接口返回 404；连接层应停止对应 Agent 工作。每批 1–100 个事件，整个请求体不超过 9 MB。

本地默认只监听 loopback；接口与 GUI 共用访问保护。启用远程访问后必须先通过 `/login` 登录并携带会话 cookie；任务 token 仅用于已领取任务，不能代替登录。接口不会自行开启公网访问。

仓库提供命令连接器，适配命令仍遵守 NDJSON 协议：

```bash
node scripts/agent-worker.js http://localhost:8790 /absolute/path/to/adapter
```

远程连接可用 `RESUME_AGENT_COOKIE` 提供登录后的 cookie，使用 HTTPS。连接器遇到网络或任务错误会停止并报告，避免重新执行已领取的任务。

## 可选：Claude / Codex

安装并登录对应 CLI 后，网页直接选择，或使用：

```bash
npm run resume -- ask --runner codex "精简工作经历"
npm run resume -- ask --runner claude "突出项目成果"
```

GUI 默认使用 external；CLI 的 `auto` 优先选择可用的 Claude、Codex、自定义连接，均未配置时等待 external。设置 `RESUME_RUNNER` 可固定默认连接。`CLAUDE_BIN` / `CODEX_BIN` 可指定路径。这些适配器依赖对应 CLI 的接口，通用协议不依赖它们的版本。

会话按简历和连接名称隔离。`reset --runner <名称>` 清除该连接会话，不传连接则清除全部会话。模型、费用和认证沿用用户配置。

## 直接操作简历

已有文件或命令工具的 Agent 可读取 [AGENTS.md](../AGENTS.md)，直接修改 HTML，并调用 `npm run resume -- check --json` 检查分页。想接收 GUI 中的用户消息，使用上述三种连接方式之一。
