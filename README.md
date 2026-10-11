# 简历助手（resume-chat）

通过自然语言修改简历，并在网页中查看 A4 预览。也可以直接在预览上编辑文字，再保存或导出 PDF。

简历的唯一内容来源是一份普通 HTML 文件：网页、命令行和 AI 都操作同一份文件。项目没有数据库，也没有前端构建步骤；后端使用 Node.js，界面使用原生 HTML、CSS 和 JavaScript。

## 当前能力与边界

| 功能 | 当前实现 |
| --- | --- |
| 对话修改 | 本机所选 Agent CLI（Claude / Codex / 自定义）读取当前简历，通过 Read / Edit / Write 等工具修改文件，并流式返回回复 |
| 可视化预览 | 右侧 iframe 展示 A4 简历，支持缩放与适配；文件变化后自动刷新 |
| 手动编辑 | 点击「编辑」后直接修改简历文字，自动保存；点击「完成」结束编辑 |
| 多份简历 | 新建、切换、复制、重命名、删除；禁止删除最后一份 |
| 页数检查 | 无头浏览器测量页数和溢出量，网页在对话后自动检查 |
| PDF 导出 | 网页通过受保护接口生成 PDF 并下载到当前设备；命令行通过无头浏览器生成 PDF 文件 |
| 会话续接 | 每份简历分别保存会话 ID；明确失效的旧会话可自动恢复 |
| 版本管理 | 可通过复制简历保存不同稿件；尚无自动快照、版本时间线、改动对比或回滚 |

**对话记录不是简历版本历史。** `state.json` 保存的是会话 ID，不能据此恢复旧版简历。页面中的聊天消息也没有由本项目持久化，刷新页面后不会重建原来的消息列表。

## 环境要求

- 建议使用 **Node.js 22+**。Node 18/20 可运行基础功能，但页数测量与命令行 PDF 导出需要 Node 22+ 的内置 WebSocket。
- 对话功能需要本机安装并登录 **Claude Code CLI 或 Codex CLI**，也可配置其它 Agent。任意能读写文件或运行命令的外部 Agent 可直接使用本项目 CLI，无需 Claude。
- 页数测量与命令行导出需要本机 Chrome / Chromium 等受支持浏览器。
- 仅在 macOS 上充分验证；Linux / Windows 的浏览器路径表已提供，但未充分实测。

项目没有第三方 npm 运行依赖；`npm install` 主要建立两个 workspace 包之间的链接，可以离线运行。**离线安装不代表 AI 对话可以离线使用**：模型请求仍由 CLI 连接其配置的服务。

本项目不单独管理 API key，也不固定底层模型。认证、模型、供应商和费用由本机 CLI 的配置决定；使用 Claude CLI 不代表实际请求一定使用 Claude 模型。简历文件保存在本地，但 AI 读取的内容可能随请求发送到 CLI 配置的模型服务。

## 快速开始

在项目目录执行：

```bash
npm install
node --version
claude --version
claude auth status
npx resume-chat status --json
npm start
```

默认地址为 `http://localhost:8790`，启动时会打开浏览器。端口被占用时自动尝试后续端口，实际地址以终端输出为准。服务默认只监听 `127.0.0.1`。

macOS 也可以双击 `启动.command`；关闭启动窗口或按 Ctrl+C 可结束服务。

不自动打开浏览器：

```bash
node packages/ui/server.js --no-open
```

`status` 检查数据目录、浏览器和 CLI 可执行文件是否存在，**不验证模型服务是否能成功回复**。排查对话失败时，需要结合具体错误和 CLI 的实际调用结果。

## 网页使用流程

1. 在左上角选择简历。首次运行没有任何简历时，会创建「我的简历」空白模板。
2. 在左侧输入修改要求，例如「精简个人优势，保留已提供的关键数据」。Enter 发送，Shift+Enter 换行。
3. AI 修改当前 HTML 文件，右侧预览自动刷新，并在对话结束后测量页数。
4. 需要手动改文字时，点击右侧「编辑」。结束编辑后再发送新的对话要求。
5. 点击「下载 PDF」，Mac 使用无头浏览器生成 PDF，并由当前访问设备保存；移动浏览器可能提供文件预览或保存到“文件”的操作。

编辑规范要求 AI 保留现有版式，不编造经历、数字、学历或奖项；信息不足时应向用户询问。这是提示词约束，修改结果仍需用户核对。页数检查会报告溢出，**不会自动压缩内容**。

当前保存不同稿件的方法：先在左上角菜单选择「复制当前简历」，再将副本重命名为岗位或日期对应的名称，例如「产品岗-第一稿」。后续修改副本即可保留原稿；每份简历使用独立会话。

## 工作原理

```text
网页输入修改要求
  → POST /api/chat
  → core.ask：校验简历、按简历加锁、读取会话 ID
  → runner：启动所选 Agent CLI 子进程
  → CLI 读取并编辑当前 HTML 简历
  → NDJSON 流返回状态、工具进度、回复或错误
  → 文件监听通过 SSE 通知预览刷新
  → 对话结束后使用无头浏览器检查页数
```

Agent CLI 按请求启动，不需要提前打开 CLI 窗口。网页左下方选择 Agent；默认自动选择本机可用后端。

- **HTTP + NDJSON**：传输每轮对话的生成事件。
- **SSE**：广播文件变化和页数检查结果。
- **iframe**：渲染当前简历并支持就地编辑。手动保存使用内容哈希检查冲突，其他设备已更新时拒绝覆盖。
- **无头浏览器 + CDP**：测量真实内容高度、生成命令行 PDF。

Claude runner 开放 Read、Write、Edit、Glob、Grep，禁用 Bash、WebFetch、WebSearch、Task 和 NotebookEdit。提示词限制 AI 修改当前简历，并要求每轮先重新读取文件，以当前内容为准。

## 会话恢复与错误处理

每份简历的 Claude 会话 ID 存在 `state.json` 的 `sessions` 映射中；Codex 和自定义 Agent 的会话存在 `runnerSessions`，按简历及 Agent 隔离。旧 ID 对应的 CLI 会话如果已被清理，续接可能返回 `No conversation found with session ID`。

当前处理机制：

- 只有明确收到「旧会话不存在」错误，且尚未输出文字或执行任何工具时，才清除旧 ID，并使用新会话自动重试一次。
- 如果新会话也失败，则返回具体错误，不继续重试；其他 API、认证或网络错误也不会触发该恢复逻辑。
- CLI 错误优先展示结果中的 `result`、`errors` 和 stderr 信息；没有完成结果时报告异常。
- 网页收到错误或流提前结束时，不再显示「已处理完成」，而是提示失败。
- 服务日志记录对话开始、结束及 runner 错误，便于排查。

自动恢复会丢失旧会话上下文，但当前 HTML 简历仍保留。也可以手动重置：

```bash
npx resume-chat reset "我的简历"
```

网页「重置对话」也会清除当前会话；**不会回滚或清空简历内容**。

## 命令行用法

在项目目录中使用 `npx resume-chat`。不启动网页也可以管理和修改简历：

```bash
npx resume-chat list --json
npx resume-chat read "我的简历"
npx resume-chat ask "我的简历" "把个人优势压缩到三条以内"
npx resume-chat check "我的简历" --json
npx resume-chat export "我的简历" -o /tmp/resume.pdf
```

完整命令：

```text
简历管理   list  new <名字>  read <名字>  write <名字> [文件]
           duplicate  rename  delete  use  path  home
对话       ask [名字] <要求…>   reset [名字]   session [名字]
渲染       check [名字]        export [名字] [-o 文件]
其它       serve [--port 8790] [--no-open]   runners   status   version   help
```

全局选项：`--json`、`--home <目录>`、`--runner <名字>`、`--prompt-file <文件>`、`-q`。内置 `claude` 和 `codex` runner，默认 `auto`；其它 Agent 可用本地配置接入，见 [Agent 接入说明](docs/agents.md)。完整参数以 `npx resume-chat help` 为准。

`ask` 的回复正文走 stdout，进度和错误走 stderr。`--json` 输出 NDJSON 事件流，事件字段为 `{t, v, name}`，公开对话事件包括 `status`、`tool`、`text`、`error`、`done`；会话事件由内核处理并写入状态文件。

> 当前 CLI 的 `ask` 在消费完事件流后返回 0，即使流里出现过 `error`。自动化调用不能仅凭退出码判断生成成功，应检查错误事件或 stderr，并核对文件结果；`done` 表示流结束，不代表编辑成功。

退出码：0 成功；1 操作失败或页数检查未通过；2 用法错误；3 环境不满足。上述 `ask` 的流式错误是当前例外。

## 数据与直接编辑

默认数据目录是 `~/.resume-chat/`，与项目代码分开：

```text
~/.resume-chat/
├── resumes/          每份简历一个 .html，文件名为展示名
├── assets/           简历引用的图片
├── templates/        用户可修改的空白模板
├── exports/          命令行 export 的默认输出位置
├── state.json        当前简历和各份简历的会话 ID
└── resume-chat.log   服务日志，含用户请求与错误摘要
```

可直接修改 `resumes/<名字>.html`，无需经过 AI。保持完整的单文件 HTML、内联 `<style>` 和 A4 版式；图片使用 `../assets/文件名`，兼容网页预览与本地文件渲染。打印样式中 `.page` 的 `min-height` 应为 `0`，避免分页误差。

直接编辑后执行 `npx resume-chat check "我的简历" --json`。结果包含 `fits`、`pages` 和 `overflowPx`；`fits: false` 表示内容超出一页，需要调整后再交付。不要把个人简历数据放进代码仓库。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `RESUME_HOME` | 数据目录，默认 `~/.resume-chat` |
| `PORT` | 网页端口，默认 8790，被占用会尝试后续端口 |
| `CLAUDE_BIN` | Claude CLI 可执行文件的完整路径 |
| `CODEX_BIN` | Codex CLI 可执行文件的完整路径 |
| `RESUME_RUNNER` | 默认对话 Agent，默认 auto |
| `RESUME_RUNNERS_FILE` | 自定义 Agent 配置路径，默认数据目录的 runners.json |
| `RESUME_BROWSER` | 页数测量和命令行 PDF 导出使用的浏览器路径 |
| `RESUME_PROMPT_FILE` | 追加到 system prompt 的自定义编辑规范文件 |

## 跨设备访问与 macOS 自动启动

模型调用、HTML 源文件、PDF 生成仍在 Mac 本机。其他设备通过 HTTPS 隧道访问同一个应用；Mac 必须开机、联网且未休眠。启动项是用户级 LaunchAgent，在用户登录后运行，不等同于登录前启动的系统服务。

远程模式保护页面、简历、图片、全部 API 和 PDF 下载，使用随机访问密码和七天有效的 HttpOnly / SameSite cookie；HTTPS 访问附带 Secure。密码验证使用 scrypt，登录有限流，修改接口检查请求来源。简历预览与素材禁用脚本，避免简历 HTML 执行登录后的接口请求。简历图片和下载响应不允许公共缓存。

```bash
node scripts/remote-setup.js init
node scripts/remote-setup.js temporary
node scripts/remote-setup.js install
node scripts/remote-setup.js status
```

安装前先停止占用 8790 的旧进程。自动服务固定监听 `127.0.0.1:8790`，不会自动换端口，以免隧道连接到错误的服务。

### 临时试用地址

`temporary` 启用 Cloudflare Quick Tunnel，需要本机已有 `cloudflared`（默认路径 `/opt/homebrew/bin/cloudflared`）。不需要账号或域名；实际网址由 `status` 显示。隧道重启后地址可能变化，没有生产可用性保证。

Quick Tunnel 不支持 SSE，因此此模式下使用五秒轮询通知文件变化；对话仍通过 NDJSON 请求返回。页面切到后台、AI 正在处理或手动编辑时暂停轮询。

[Cloudflare Quick Tunnel 官方限制](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)。

### 固定网址

需要 Cloudflare 账号、托管域名和已创建的 named tunnel。在 Cloudflare 中配置子域名指向 `http://127.0.0.1:8790`，保留该子域名的 Host，不要将 origin Host 覆盖为 localhost。将 tunnel token 保存为本地文件，再执行：

```bash
node scripts/remote-setup.js configure https://resume.example.com /本地/token文件
node scripts/remote-setup.js restart
```

配置后的 named tunnel 使用 SSE 通知。应用访问密码仍然生效；也可额外配置 Cloudflare Access。Cloudflare 账号的创建、登录与域名授权由用户完成。

### 密码、运行状态与停止

访问密码保存在数据目录的 `访问密码.txt`；认证配置、token、CLI 运行环境文件权限均为 0600，均不进入项目代码。更换密码后重启服务，旧登录会失效：

```bash
node scripts/remote-setup.js rotate-password
node scripts/remote-setup.js restart
node scripts/remote-setup.js status
node scripts/remote-setup.js uninstall
```

`uninstall` 停止自动服务与隧道并移除启动项，保留简历与配置。通过网页「退出」可清除当前设备的登录 cookie。运行日志为 `~/.resume-chat/service.log` 与 `service-error.log`；CLI 子进程仍复用本机环境。

没有 Cloudflare 或无法连通隧道时，本地后台服务仍可使用。临时模式当前网址记录在 `remote-origin.json` 中；离线期间旧网址不可用。

## 常见问题

**页面打不开**：确认服务进程仍在运行，检查终端输出的实际端口。修改后端代码需要重启服务，修改网页代码需要刷新页面。

**找不到 Claude CLI**：执行 `claude --version`，或通过 `CLAUDE_BIN` 指定路径。CLI 已存在仍生成失败时，检查登录状态、CLI 模型服务配置及完整错误信息。

**旧会话不存在**：符合恢复条件时会自动重新建立会话；必要时使用「重置对话」。重置只清理会话，不恢复旧稿件。

**邮箱显示为 `[email protected]`**：Cloudflare 的邮箱混淆需要解码脚本，而简历预览禁止脚本。服务为 HTML 预览和 PDF 返回 `Cache-Control: private, no-store, no-transform`，阻止 Cloudflare 改写。不要为还原邮箱放开预览脚本。PDF 由 Mac 上原始 HTML 生成；已经打开的页面需要刷新。若手动编辑曾把混淆占位符保存到源文件，则需另行恢复源文件邮箱。

**显示未测量 / 导出失败**：检查 Node 版本与浏览器路径。无头浏览器需要可启动的运行环境，受限沙箱可能阻止启动。

**看起来是一页但 PDF 多了一页**：执行 `check`，查看 `overflowPx`，减少内容或调整排版，并检查打印样式。

服务日志：

```bash
tail -n 50 ~/.resume-chat/resume-chat.log
```

## 代码结构与开发验证

```text
packages/core/                 内核，不含 HTTP 或界面
  lib/workspace.js             数据目录、状态、文件监听和日志
  lib/resumes.js               简历文件的增删改查
  lib/prompt.js                AI 编辑规范
  lib/chat.js                  按简历加锁、会话管理、对话编排
  lib/runners/claude.js         Claude 子进程、事件解析、失效会话恢复
  lib/runners/codex.js          Codex exec / resume 事件适配
  lib/runners/custom.js         本地自定义 Agent 配置与协议
  lib/browser.js               浏览器发现和常驻无头实例
  lib/render.js                页数测量、PDF 导出
  cli.js                       命令行命令
packages/ui/
  server.js                    HTTP、NDJSON 对话流与 SSE 通知
  public/index.html            页面结构
  public/app.js                对话、简历切换、手动编辑与打印
  public/style.css             界面样式和移动端对话/预览切换
  auth.js                      访问密码、签名会话 cookie、请求来源检查
scripts/
  syntax.js                    JavaScript 语法和控制字符扫描
  smoke.js                     临时数据目录中的 CLI 冒烟流程
  chat-regression.js           模拟 CLI 的会话与错误处理回归验证
```

```bash
npm run syntax
npm run smoke
node scripts/chat-regression.js
node scripts/remote-regression.js --with-pdf
```

回归脚本不请求真实模型、不修改真实简历，覆盖旧会话恢复、恢复失败、API 错误、空响应、执行工具后不重试，以及网页失败/断流/正常完成提示。冒烟脚本使用临时简历验证管理、页数测量和 PDF 导出，需要允许无头浏览器启动。

如需真实模型集成验证，可执行 `node scripts/smoke.js --with-ask`，会消耗模型额度；默认不运行。

两个包通过 npm workspaces 链接，跨包引用使用 `@resume-chat/core`，修改后无需构建。新增模型后端可实现 runner 的 `name`、`description`、`available()` 和异步生成器 `run()`，并在 runner 注册表中注册。

已知其他边界：同一份简历不能同时运行多轮对话；单次 CLI 调用超时为 10 分钟；尚无修改审批、事务回滚或完整版本管理。

## License

MIT

## Agent 兼容性

任何能操作本地文件或命令行的 Agent 都可以通过 `AGENTS.md` 使用 ChatResume。
网页和 `ask` 内置 Claude、Codex，支持通过本地命令适配其它 Agent；无需修改源码。
具体命令、协议、权限边界及配置示例见 [Agent 接入说明](docs/agents.md)。
