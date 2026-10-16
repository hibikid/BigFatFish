# Windows 适配：安装与调试交接

读者：在 Windows 实机上帮用户安装、调试大肥鱼的 agent。`windows-support` 分支里的 Windows 适配是在 macOS 上**按推断写的**，从没在 Windows 上运行过。你的任务是在实机上逐项验证这些推断，不成立的就改，最后向用户汇报每一项的结果。

## 工作约定

- 用中文回复用户。默认做法自己定，只有真正的产品取舍才问用户。
- **零额度**：测试不花 Codex、Claude 的额度。不要为了测试自己启动 Codex 或 Claude 的对话；用 `scripts/windows-check.mjs` 喂合成输入。需要真实会话的检查，请用户在平常使用时观察。
- `npm run test:desktop` 会在屏幕上弹出挂件和对话框一两分钟。运行前告诉用户，请他不要关掉；失败截图里对话框不见了，先问用户是不是关了，再当成 bug 查。
- `~/.claude/settings.json` 和 `~/.codex/hooks.json` 只通过大肥鱼自己的安装命令修改（它们只增删大肥鱼自己的条目）；要手改先问用户。
- 用户要求时才 commit。

## 大肥鱼是什么

独立的桌面宠物：一个全屏透明的 Electron 窗口，只有角色、气泡和面板接收鼠标，其余区域点击穿透。它显示 API 余额与 Codex、Claude 订阅额度，能以角色人设聊天、管理番茄钟，还有一个**任务小窗**：每个开着的 Claude Code、Codex CLI、Codex App 会话一行，显示状态、上下文 token，点一行跳回那个会话。

功能说明以这些文档为准，这里不重复：`README.md`（功能总览）、`CONTEXT.md`（术语）、`docs/AGENTS.md`（任务小窗：状态规则、数据来源、限制）、`docs/QUOTA.md`（额度账户）、`docs/CLAUDE-USAGE.md`（Claude 接入）。

**订阅额度不需要登录绑定**：Codex 订阅读 Codex 写在本机会话日志里的额度快照；Claude 订阅靠 Claude Code 的状态栏把额度交给大肥鱼。大肥鱼不读任何登录凭据，CLI 登录的是哪个账户就显示哪个。

## 开发现状

| 分支 | 内容 | 验证 |
| --- | --- | --- |
| `main` | 0.2.4 之后的全部开发：额度管理、角色会话、三套主题、任务小窗等（README 里有清单） | macOS：`npm test`、`npm run check`、`npm run test:desktop` 全过，用户实际在用 |
| `windows-support`（基于 `main`） | 本文、下面“推断”一节里的 Windows 改动、`scripts/windows-check.mjs`、`node scripts/control.mjs agents` | 只在 macOS 上跑过单元测试；单元测试检查 Windows 命令的拼写，Windows 上实际怎么执行没人试过 |

挂件本体的 Windows 部分（任务计划、启动器、托盘、Ctrl+Alt+W）是 0.2.4 时期做的，从 0.2.6 起没有在 Windows 实机验证（见 `docs/CHANGELOG-0.2.6.md`）。所以第 2、3 步也可能出问题，不只是任务小窗。

## 步骤

每一步做到“完成”写的状态再往下走。出问题先查后面的“排查”一节。

1. **准备环境**：Windows 10/11 x64，Node.js 24+（含 npm），Claude Code 需要的 Git for Windows，Windows Terminal。把仓库 `https://github.com/hibikid/BigFatFish` 克隆到 `%USERPROFILE%\plugins\api-balance-whale`（安装脚本认这个位置；其他位置也能装），切到 `windows-support` 分支。
   完成：`node -v` ≥ 24，`git branch --show-current` 输出 `windows-support`，`node scripts/windows-check.mjs env` 能运行。
2. **单元测试**：`npm test`、`npm run check`。
   完成：全部通过（macOS 上是 146 个测试）。只在 Windows 上失败的测试就是要修的移植问题，修完再往下。
3. **安装桌面挂件**：双击 `安装桌面组件.cmd`（装 Electron 44.3.0），再双击 `安装开机自启.cmd`（注册任务计划并启动）。
   完成：屏幕上出现角色；`node scripts/control.mjs status` 返回 `"ok": true`。
4. **桌面冒烟**：先告诉用户会弹窗，再运行 `npm run test:desktop`。
   完成：输出 `Desktop smoke passed (initial + process restart)`。截图和日志在 `qa-output\desktop-*`。
5. **Codex 审批提醒**：`npm run install:approvals`，请用户在 Codex CLI 里打开 `/hooks` 信任这条 hook，然后运行 `node scripts/windows-check.mjs codex-hook`。
   完成：三项全是“通过”，大肥鱼弹出“需要批准”的提醒。
6. **Claude 接入**：在大肥鱼的 额度管理 › 账户 里点“接入 Claude Code”（已接入时点“更新接入”），再运行 `node scripts/windows-check.mjs claude`。
   完成：全部“通过”。然后请用户照常用 Claude Code：回复一次后，Claude 底部状态栏显示 `Claude | 5h …% · 7d …%`；发一条消息后，任务小窗出现这个会话的行。
7. **任务小窗与跳转**：请用户照常开一个 Codex CLI 会话和一个 Claude Code 会话（都在 Windows Terminal 里），运行 `node scripts/control.mjs agents` 看行有没有出来；再运行 `node scripts/windows-check.mjs jump <其中一个项目名> claude`（或 `codex`）。用过 Codex App 的话，从 `%USERPROFILE%\.codex\sessions` 里找一个 `originator` 含 desktop 的日志，用它第一行的 `id` 试 `jump <项目名> app <id>`。
   完成：每个会话一行，状态对得上；跳转选中了正确的标签，或者至少把终端切到了前面，并给出提示。
8. **汇报**：按上面的编号列出每项“通过／失败／改了什么”，把下一节表格里每条推断标成“已证实”或“已推翻，改成……”。

## 推断与依据

Windows 适配的每个改动都基于下面的推断。验证完请更新这张表和 `docs/AGENTS.md` 的“限制”一节。

| # | 推断 | 依据 | 若不成立的表现 | 代码 |
| --- | --- | --- | --- | --- |
| 1 | Codex 在 Windows 上用 `%COMSPEC% /C "<命令>"` 执行 hook，所以命令用双引号包每个参数 | Codex 源码 `codex-rs/hooks/src/engine/command_runner.rs`：`default_shell_program` 取 COMSPEC，`build_command` 把整条命令再包一层引号作为原始参数 | `codex-hook` 检查运行失败；Codex `/hooks` 里这条 hook 报失败 | `scripts/manage-approval-hook.mjs` 的 `quote` |
| 2 | Codex 按当前平台实际执行的命令算信任哈希：Windows 第一次装要在 `/hooks` 信任一次，Mac 上的信任不受影响 | Codex 源码 `codex-rs/hooks/src/engine/discovery.rs` 的 `hook_hash` | hook 显示为未信任或已修改，从不运行 | 同上 |
| 3 | Codex 的 PermissionRequest 输入带 `session_id` 和 `cwd` | Codex hooks 官方文档 | 小窗里黄色标错会话，或不标 | `scripts/approval-request-hook.mjs`、`runtime/agents/board.mjs` 的 `codexApproval` |
| 4 | Claude Code 在 Windows 上通过 Git Bash 执行状态栏和 hook 命令，所以命令仍用单引号；Git Bash 会吞掉反斜杠，所以路径写成正斜杠 | Claude Code 文档：Windows 上启动需要 Git Bash；多份 issue 显示 hook 经 `/usr/bin/bash --login -i -c` 执行、未加引号的反斜杠路径被吞 | `claude` 检查失败；状态栏空白；`claude --debug` 里有退出码 126 之类的错误 | `runtime/claude-integration.mjs` 的 `shellPath` |
| 5 | Windows 上用 PATH 或 `%ProgramFiles%\nodejs` 里的 `node.exe` 跑脚本；找不到时退回 Electron 加 `ELECTRON_RUN_AS_NODE=1` 前缀（只在 bash 里有效） | 安装要求 Node 24+ | 命令里出现 `electron.exe` | `findNode` |
| 6 | Codex 在 Windows 上同样把 JSONL 日志写在 `%USERPROFILE%\.codex\sessions`（或 `CODEX_HOME`），Codex App 的 `originator` 含 desktop | macOS 上看到的是 `codex-tui`（CLI）和 `codex_work_desktop`、`Codex Desktop`（App） | Codex 的行不出现，或 App 被标成 CLI | `runtime/session-monitor.mjs` 的 `identify` |
| 7 | Windows 版 Codex App 注册了 `codex://` 链接，`codex://threads/<id>` 打开对应线程；用 `rundll32 url.dll,FileProtocolHandler` 交给系统打开 | macOS 版 App 注册了 `codex` 链接，代码里用 `codex://threads/<id>` | 跳转报“没能打开 Codex 应用”，或打开了 App 但没进线程 | `runtime/agents/jump.mjs` |
| 8 | Windows Terminal 的窗口类名是 `CASCADIA_HOSTING_WINDOW_CLASS`，标签是 UI Automation 的 TabItem，能用 SelectionItemPattern 选中；单独的控制台窗口类名是 `ConsoleWindowClass` | 公开的 UI Automation 资料，未实测 | `jump` 报“没有找到打开的终端窗口”或“没能切到终端” | `WINDOWS_SCRIPT` |
| 9 | Claude Code 把终端标题设成带 ✳ 的文字，可以用来认出它的标签；标题里一般没有项目名 | 未验证的假设 | 开着几个标签时总选错 | `TITLE_HINTS` |
| 10 | 先模拟按一下 Alt，再调 SetForegroundWindow，就能把终端切到前面 | Windows 只允许刚收到用户输入的进程切换前台窗口，这是常见的绕法 | 任务栏图标闪烁，窗口没有切到前面 | `WINDOWS_SCRIPT` |

**跳转脚本从没运行过，连语法都没检查过**：写它的那台 Mac 上没有 PowerShell。它以 `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand <base64>` 运行，开头由 `jumpPlan` 设好 `$name`（项目名）和 `$hints`（标题关键词），stdout 输出 `tab`、`app` 或 `none`。调试时把它解出来单独跑，能看到完整报错：

```
node -e "import('./runtime/agents/jump.mjs').then(m => { const p = m.jumpPlan({ id: 'claude:x', tool: 'claude', name: '项目名', cwd: 'C:/x' }, 'win32'); require('fs').writeFileSync('jump-check.ps1', '\ufeff' + Buffer.from(p.args.at(-1), 'base64').toString('utf16le')); })"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File jump-check.ps1
```

（`-ExecutionPolicy Bypass` 只对这一次命令生效，不改系统设置。用完删掉 `jump-check.ps1`。）

## 排查

| 现象 | 先看 | 常见原因 |
| --- | --- | --- |
| 双击安装后没有角色 | 数据目录里的 `launcher-error.json`、`supervisor-error.json`、`desktop-error.json`；任务计划程序里的“Codex API Balance Whale” | Electron 没装好（重跑 `安装桌面组件.cmd`）；任务计划注册失败（安装脚本会打印原因） |
| `control.mjs status` 说挂件尚未运行 | 数据目录里有没有 `runtime.json` | 挂件没起来；`WHALE_HOME`、`CODEX_HOME` 指向了别的目录 |
| 审批时不弹提醒 | `windows-check.mjs codex-hook`；Codex `/hooks` | hook 没被信任；命令写法不对（推断 1）；挂件没运行 |
| 小窗没有 Claude 的行 | `windows-check.mjs claude`；`claude --debug` 的输出 | 没接入或没更新接入；Git Bash 执行失败（推断 4）；会话还没有任何动静（发一条消息才会出现） |
| 小窗没有 Codex 的行 | `%USERPROFILE%\.codex\sessions` 里有没有新日志 | Codex 跑在 WSL 里：日志在 Linux 文件系统中，Windows 上的大肥鱼看不到（不在当前范围内） |
| 项目名或文件夹显示得很怪 | `control.mjs agents` 输出里的 `cwd` | Windows 上 `cwd` 可能带 `\\?\` 前缀；需要在 `runtime/session-monitor.mjs` 的 `identify` 和 `runtime/agents/claude-hooks.mjs` 里统一处理 |
| 跳转失败或选错标签 | 上面单独运行跳转脚本的办法 | 推断 8–10 |
| 小窗点不动、滑不动，或挡住了下面的点击 | `desktop/ui/input.js` 的 `surfaces` | 点击穿透的切换在 Windows 上表现不同（Windows 靠转发的 mousemove） |
| 状态栏或 hook 运行时闪出命令行窗口 | Claude Code 版本 | Claude Code 在 Windows 上的已知问题，不是大肥鱼的 |

已知缺口：`scripts/uninstall-windows.ps1` 不会移除 Codex 审批 hook（macOS 的 `scripts/uninstall-macos.mjs` 会）；需要时手动运行 `npm run uninstall:approvals`，或者把它补进卸载脚本。

## 代码地图

| 位置 | 作用 |
| --- | --- |
| `安装桌面组件.cmd` → `scripts/install-desktop.mjs` | 把 Electron 装进 `<数据目录>\desktop-runtime` |
| `安装开机自启.cmd` → `scripts/install-windows.ps1` | 编译启动器 `desktop/WhaleLauncher.cs`，注册任务计划；启动器 → `desktop/supervisor.ps1` → `electron.exe desktop/main.cjs` |
| `启动桌面挂件.cmd`、`停止挂件服务.cmd` → `scripts/control.mjs` | 启动／停止；`status`、`agents` 等只读查询 |
| `runtime/bridge.mjs` | 本地管道 `\\.\pipe\codex-whale-<hash>`，令牌在 `runtime.json` |
| `runtime/dispatcher.mjs` | 页面与管道的所有本地接口，包括 `/api/agents` |
| `runtime/session-monitor.mjs`、`runtime/session-worker.mjs` | 在工作线程里读 Codex 日志：用量、额度快照、任务小窗的会话状态 |
| `runtime/agents/` | 任务小窗：`board.mjs` 排序与状态规则，`claude-hooks.mjs` 记录 Claude 会话，`jump.mjs` 跳转（Ghostty 与 Windows 两套） |
| `runtime/claude-integration.mjs`；`scripts/claude-statusline.mjs`、`scripts/claude-hook.mjs` | Claude 接入的安装与两个被 Claude Code 调用的脚本 |
| `scripts/manage-approval-hook.mjs`；`scripts/approval-request-hook.mjs` | Codex 审批 hook 的安装与被 Codex 调用的脚本 |
| `desktop/ui/agents.js`、`agents.css` | 小窗界面；`desktop/ui/input.js` 决定哪些区域接收鼠标 |
| `scripts/windows-check.mjs` | 本文用到的实机检查 |

数据目录默认是 `%USERPROFILE%\.codex\whale-widget`（设了 `WHALE_HOME` 或 `CODEX_HOME` 时跟着变）。除了上面提到的错误文件，还有：`agents\claude-<会话>.state.json` 和 `.usage.json`（Claude 会话），`claude-subscription.json`（Claude 额度），`ui-state.json`（界面设置，含小窗的 `dshw-agents`）。

## 改代码时

- Windows 专属行为用 `platform` 参数分支，测试里注入 `platform: 'win32'`（参考 `tests/agents.test.mjs`、`tests/claude-usage.test.mjs`、`tests/approval-hook.test.mjs`），这样 macOS 上跑测试也能覆盖。
- macOS 上已经生成的命令保持不变，否则用户 Mac 上已经信任的 Codex hook 会失效。
- 每次改完跑 `npm test` 和 `npm run check`；改到界面或启动流程再跑 `npm run test:desktop`（先告诉用户）。
- 推断被证实或推翻后，更新上面的表格和 `docs/AGENTS.md` 的“限制”一节。
