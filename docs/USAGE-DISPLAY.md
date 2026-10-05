# 额度的请求与展示

挂件只显示额度簿给出的结果，口径见 [额度管理](QUOTA.md)。前端分三层：请求、纯展示和视图；主脚本 `assets/whale-widget.js` 只把当前额度接到气泡上。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `desktop/ui/usage-client.js` | 读额度簿、把“设为当前”交回额度簿、读两路完成事件并去重、读写音效设置；第一次运行时迁移旧版在页面里保存的来源选择 |
| `desktop/ui/quota-presentation.js` | 额度的文字与进度条：账户标题、进度条、浮层每一行、消耗速度、暂时没有数据的原因，以及给气泡用的状态 |
| `desktop/ui/quota-view.js` | 挂件下方的进度条（账户名、条形、▾）和 ▾ 展开的全部额度 |
| `desktop/ui/quota-manager.js` | 额度管理窗口：账户、记录、提醒 |
| `desktop/ui/usage-presentation.js` | 气泡里的额度与花费文字：订阅剩余几行、余额与今日消费、每轮花费 |
| `desktop/ui/turn-notice.js` | 完成事件的快照，以及是否提示 |
| `assets/whale-widget.js` | 每 10 秒和每次完成事件后读一次额度簿，把当前额度交给气泡和视图，弹出新的额度提醒 |

请求模块不碰 DOM；展示模块是纯函数，不发请求、不访问存储，金额格式化由调用方传入（`WhaleMoney`，没有汇率时按账户自己的币种）。

## 请求接口

`WhaleUsageClient.create({ fetchImpl, shouldNotify, storage, now?, timeoutMs? })` 返回：

- `quotas({ manual })`：读 `/api/quotas`。同时发起的读取共用一次请求；`manual` 先让后台重新查询所有 API 账户。受 25 秒超时约束，回答无效时报错。
- `select(id, at?)`：设为当前，交给 `/api/quotas/current`。
- `migrateChoice()`：旧版在页面里保存的手动选择（`dshw-display-source` 与 `dshw-display-source-manual-at`）带着原来的时间交给额度簿，只迁一次；旧键保留，回退到旧版仍可用。
- `pollCompletions({ codex, claude })`：读两路完成事件，每条只交给对应的回调一次；并发读取不重复消费，启动前与已读的不再提示。
- `settings()` / `saveSettings(patch)`：读写音效与提醒设置，保存失败时拒绝。

游标键不变：`dshw-last-seq`、`dshw-last-turn-id`、`dshw-last-claude-turn-id`。

## 展示接口

`WhaleQuotaPresentation`：

- `current(snapshot)`：当前额度的账户。
- `title(account)` / `label(account)`：如“Codex 订阅 · Plus”“labkey · Codex API”“DeepSeek · 大肥鱼”；气泡标题如“Codex 订阅额度”“labkey 额度”“DeepSeek 余额”。
- `meters(account)`：进度条，每条是标签、剩余百分比（0–100）和档位（≥50% 正常、20–50% 偏少、<20% 告急）。订阅给出每个有效窗口；API 有额度上限时给第一条上限，否则给余额占满格的比例；不限额或没有满格时为空。
- `rows(account, { formatMoney, now })`：浮层里每一行的条形、剩余与重置时间；重置时间说成“14:20”“明天 9:05”“周五 10:00”或“10月12日 0:00”。
- `paceText(account, options)`：今日消费与消耗速度的一句话；`today: false` 时不提今日（记录页另有今日金额）。
- `status(account)`：暂时没有数据的原因或查询错误。
- `overview(snapshot)`：浮层列出的账户——有数据的、有问题的，以及当前的。
- `bubbleState(account)`：给气泡用的旧状态字段（订阅窗口、余额、今日消费、币种）。

## 视图

进度条放在白色底板上，第一行是当前额度的账户名和 ▾，下面是条形。宽度与角色可见部分的底边一致，紧贴在底边下方，跟随拖动、翻转和缩放；角色贴近屏幕底边时改到底边上方。底边由点击检测用的透明度蒙版量出（`desktop/ui/pet-geometry.js`）。点 ▾ 打开全部额度，放在角色旁边放得下的位置；点外面或按 Esc 收起。

页面内事件：

| 事件 | 方向 | 作用 |
| --- | --- | --- |
| `whale-quotas` | 主脚本 → 视图 | 每次读到额度簿的快照 |
| `whale-quotas-request` | 视图 → 主脚本 | 视图启动晚于第一次读取时，要最近的快照 |
| `whale-quotas-changed` | 视图、额度管理 → 主脚本 | 设为当前或账户改动后立即重读 |
| `whale-pet-layout` | 主脚本 → 视图 | 角色移动、翻转、缩放或换图后重新摆放 |
| `whale-open-settings` | 菜单、托盘、浮层 → 额度管理 | 打开额度管理，`detail.tab` 指定页面 |
| `whale-notice-settings`、`-request`、`-state` | 额度管理 ↔ 主脚本 | 完成提示的开关、停留秒数与失败 / 取消提示 |

## 验证

`npm test`、`npm run check`、`npm run test:desktop`。桌面测试在独立临时目录里用合成数据，覆盖进度条的账户名与位置、▾ 浮层与“设为当前”、额度管理的三页、额度提醒气泡，以及会话通过额度管理添加的账户发消息。结果与截图保存在被忽略的 `qa-output/`。

## 订阅气泡复核

此前将溢出笼统描述为“订阅气泡问题”不准确。2026-09-26 补充实际鼠标点击、配置保存后重新加载、任务完成通知与文字边界测量，结果如下：

| 场景 | 结果 |
| --- | --- |
| 点击气泡，标题 / 余额 / 今日行字号为 4 / 8 / 4（与当前本地保存的字号相同） | 无溢出 |
| 订阅任务完成后的独立三行额度提醒，字号为 8 / 8 / 4 | 无溢出 |
| 全新配置的默认点击模板，余额行字号为 20 | 长额度文字换行并超出内容区 |
| 测试强制指定 `kind: 'normal'` 的旧余额样式 | 长额度文字换行并超出内容区 |

因此，当前保存字号下的正常显示与上述测试结果一致；默认大字号及旧样式仍存在条件性布局问题。这些场景分别使用自己的布局，不能用一张旧样式截图推断所有订阅提醒都有问题。

复核使用独立临时数据，不修改用户配置，不播放实际声音。Electron 初次启动与重启验证均通过，正常字号的点击气泡和订阅完成提醒新增文字边界断言。报告及四种场景的截图保存在 `qa-output/desktop-0.2.5-s6KNPO/`。
