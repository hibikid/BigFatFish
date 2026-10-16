# 任务小窗

常驻屏幕的小窗：每个开着的 Claude Code、Codex CLI 或 Codex App 会话一行，写着它在做什么、上下文里有多少 token，点一行就回到那个会话，左右滑动一行把它移走。默认钉在屏幕右上角，浮在全屏终端上面；菜单“桌面”里的 **任务小窗** 可以关掉它。

## 每一行

从左到右：状态点、工具图标、项目（会话所在文件夹的名字）、状态、数字。

| 状态点 | 状态 | 什么时候 |
| --- | --- | --- |
| 绿，呼吸 | 处理中 6m | 这一轮还在跑，后面是已经跑了多久 |
| 绿，不动 | 完成 | 这一轮正常结束 |
| 黄，闪 | 提问 / 要权限 | 在等你回答问题，或批准一个操作 |
| 红，闪 | 卡住 18m | 处理中，但 15 分钟没有任何新进展 |
| 红，闪 | 出错 / 中断 | 这一轮出错停下，或被中断 |
| 灰 | 空闲 | 开着但没在做事：刚打开还没发消息，或完成已经半小时 |

图标：Claude Code 是启动画面里的像素小螃蟹，Codex 是白色的结，Codex App 的结右下角标着 APP。

数字是这个会话的对话现在占用的 token：最近一次请求的输入加输出，也就是上下文里有多少。超过上下文窗口的 80% 时变橙，说明快要压缩了。会话刚开始、还没有用量时，显示这个工具订阅的 5 小时剩余（如“5h 80%”）；也不知道时留空。

底部常驻 Claude 和 Codex 两个订阅的 5 小时、7 天剩余，低于 25% 变橙。

## 顺序与消失

最急的排最上面：红、黄、处理中、完成、空闲。红和黄里等得最久的在前，其余最新的在前。

- 完成 30 分钟后变成灰色的空闲，会话关掉前一直列着。点一行跳过去不会让它消失。
- Claude Code 会话退出时（`SessionEnd`）这一行消失。Codex 不会告诉大肥鱼会话关了没有，所以 Codex 的行 2 小时没有动静就不再显示。
- **左右滑动一行**把它移走，直到这个会话有新动静（发了新消息、回复完成、要权限……）。鼠标按住横着拖，或在触控板上两指横扫都可以；拖得不够远会弹回原位，也不算点击。只是时间过去（变成卡住、变成空闲）不算新动静。
- 子代理不单独成行，它们的权限请求算在父会话上。

“卡住”只说明 15 分钟没有新进展：一条跑很久的命令也会显示卡住。

## 操作

- **点一行**：跳到那个会话。Codex App 的会话用 `codex://threads/<id>` 打开对应线程，打不开时只打开 Codex 应用。其余会话切到 Ghostty 里工作目录等于会话文件夹的那个终端（选中标签并聚焦）；同一文件夹开了几个标签时，优先标题里带 Claude、✳ 或 codex 的；一个都没找到就只把 Ghostty 切到前面。第一次跳转时 macOS 会问是否允许大肥鱼控制 Ghostty，之后在“系统设置 › 隐私与安全性 › 自动化”里可以改。
  Windows 上，Codex App 的会话同样用 `codex://threads/<id>` 打开（交给系统的链接处理程序）。其余会话由 PowerShell 通过 UI Automation 在 Windows Terminal 的标签和单独的控制台窗口里找：标题里有项目名的优先，其次是标题里带 Claude、✳ 或 codex 的，选中那个标签并把窗口切到前面；一个都没找到就只把第一个终端窗口切到前面。Windows Terminal 不公开标签的文件夹，只能看标题。
- **鼠标移到一行上停一下**：旁边弹出详情卡：项目、工具、文件夹、状态和持续时间、token 与上下文占比，以及 **跳过去**。列表变化时滑到静止鼠标下面的行不会弹出卡片。详情卡里没有移除按钮，移除只靠滑动。
- **标题栏的图钉**：在“钉在屏幕上”和“跟着大肥鱼”之间切换。跟着时小窗挂在角色旁边空间更大的一侧。
- **拖动标题栏**：把钉住的小窗挪到别处，位置会记住；跟着大肥鱼时拖动它会改为钉住。钉住的小窗记住离屏幕哪一边多远：在右半边就贴着右边，在左半边就贴着左边。
- **—**：收起成一列点，只留状态点和每个工具的会话数，贴着钉住的那一边；点一下展开。

设置保存在 `dshw-agents`，与其他界面状态一起写入 `ui-state.json`，重启后保留。

## 数据从哪来

只读本机文件和 hook 推送，不向任何服务发请求，不读也不保存对话内容。

**Codex**：额度用的同一个会话监视线程读 `~/.codex/sessions` 里的日志。`session_meta` 给出会话 ID、文件夹（`cwd`）和来源（`originator` 含 desktop 的是 Codex App）；`task_started`、`task_complete`、`turn_aborted` 给出这一轮的状态；`token_count` 的 `last_token_usage` 和 `model_context_window` 给出 token。日志每次变长都算一次进展。这一部分不受“读取本机 Codex 会话记录”开关影响，那个开关只管用量记账。

Codex 的“要权限”来自已有的审批提醒 hook（`scripts/approval-request-hook.mjs`）。Codex 在 macOS 上用 `sh -lc`、在 Windows 上用 `cmd.exe /C` 执行 hook 命令，所以安装时 Windows 上的命令用双引号，其他系统用单引号。它现在把会话 ID 和文件夹一起交给大肥鱼，请求的命令和内容仍然不离开 hook 进程。hook 的命令行没有变，Codex 已经信任的 hook 不需要重新审核。请求两秒以后日志里出现新的 token 记录，或者这一轮结束，就算已经处理。只说了文件夹的请求算在那个文件夹里正在跑的会话上；什么都没说的请求，只有正好一个会话在跑时才算它的。

**Claude Code**：接入时除了状态栏，还给这些事件装上 `scripts/claude-hook.mjs`：`SessionStart`、`UserPromptSubmit`、`Notification`、`PermissionRequest`、`Stop`、`StopFailure`、`SessionEnd`。它什么也不输出（有些事件的输出会进入对话），也从不阻止或改变 Claude 的行为。

| 事件 | 状态 |
| --- | --- |
| `UserPromptSubmit` | 处理中 |
| `PermissionRequest`；`Notification` 的 `permission_prompt` | 要权限 |
| `Notification` 的 `agent_needs_input`、`elicitation_dialog`、`elicitation_url_dialog` | 提问 |
| `Stop` | 完成（同时照旧发出“Claude 回复完成”） |
| `StopFailure` | 出错 |
| `SessionEnd` | 删除这个会话 |

Claude Code 在 Windows 上也通过 Git Bash 执行这些命令，所以命令统一用单引号；Windows 上的路径写成正斜杠（Git Bash 会吞掉反斜杠），并优先用 PATH 或 Program Files 里的 `node.exe`。

状态栏脚本同时记下每个会话 `context_window.current_usage` 的 token 和 `used_percentage`。提问或权限之后两秒以上 token 又变了，就算已经回答，回到处理中。子代理的事件不记录。

每个 Claude 会话在数据目录的 `agents/` 下有两个小文件：hook 写的 `claude-<会话>.state.json` 和状态栏写的 `claude-<会话>.usage.json`，分开写所以互不覆盖。里面只有会话 ID、文件夹、状态、时间和 token 数。一天没有动静的文件自动删除。

早先的接入只有 `Stop` hook。额度管理的 Claude 卡片和任务小窗都会提示 **更新接入**。更新后不用重开会话：已经开着的会话也会用上新的 hooks，在下一次发消息或回复完成时出现。刚打开、还没有任何动静的会话不列出。

## 接口

- `GET /api/agents`：`rows`（每行的 `id`、`tool`、`app`、`name`、`place`、`state`、`color`、`since`、`tokens`、`contextPercent` 等）、`limits`（两个订阅的窗口）、`claude`（接入状态，含 `tracking`）。
- `POST /api/agents/jump`，`{ "id": "claude:<会话>" }`：跳过去。
- `POST /api/agents/hide`，`{ "id": "codex:<会话>" }`：滑走一行，到有新动静为止。

## 限制

- macOS 上按文件夹精确跳转只支持 Ghostty 1.3 及以上（AppleScript）。在 tmux 里运行的会话只能跳到 tmux 所在的标签。
- Windows 上只能按标题找标签：Claude Code 的标题一般带 ✳ 但不带项目名，开着几个 Claude 标签时可能选中其中任意一个；不设标题的工具往往只能把终端窗口切到前面。VS Code 等编辑器里的终端不在范围内。
- Windows 部分（hook 命令、跳转）目前只有单元测试，还没有在 Windows 实机上验证；验证步骤和每条推断的依据见 [Windows 适配交接](WINDOWS-PORT.md)。
- 同一文件夹里同一工具开着几个会话时，可能跳到其中任意一个。
- 在 Claude Code 里按 Esc 拒绝权限不会触发 `Stop`，这一行会保持黄色，直到下一条消息或把它滑走。
- 没有正常退出的 Claude Code 会话（例如直接关掉终端而没有触发 `SessionEnd`）会作为空闲行留着，一天没有动静后自动清掉，也可以滑走。

## 验证

`node --test tests/agents.test.mjs tests/claude-usage.test.mjs tests/approval-hook.test.mjs`、`npm test`、`npm run check`、`npm run test:desktop`。测试用合成的会话文件和日志行；桌面测试里的跳转被替换成记录，不会碰任何终端。Windows 的命令写法和跳转脚本的参数由单元测试检查，PowerShell 脚本本身要在 Windows 上实际运行才能确认。
