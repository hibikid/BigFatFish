# 用量请求与展示适配

## 本次范围

对应需求：先分离用量请求和显示适配，完成一个 commit。起点为 `c1a660a` / `codex-v0.2.5-baseline`。

本次抽出前端用量请求与展示数据转换，保持现有 UI、后端协议、数据文件和原始金额精度。后端模块入口的拆分属于后续工作。

## 模块职责

| 文件 | 职责 |
| --- | --- |
| `desktop/ui/usage-client.js` | 用量路由、请求与 JSON 解析、余额刷新超时、任务通知游标与持久化 |
| `desktop/ui/usage-presentation.js` | 余额与订阅显示状态、标题、额度文字、费用气泡文字的转换 |
| `desktop/ui/turn-notice.js` | 已有任务结果快照、通知是否有效及开关规则 |
| `assets/whale-widget.js` | 装配模块，把显示数据应用到现有 DOM、气泡、音效与金额绑定 |

请求模块不访问 DOM、Electron 或全局存储。创建时注入 `fetchImpl`、存储和现有的订阅判定 / 通知判定函数。展示适配是纯函数，不发请求、不操作 DOM，不访问存储；金额格式化通过 `formatMoney` 注入，继续使用现有 `WhaleMoney` 换算与绑定。

## 请求接口

`WhaleUsageClient.create({ fetchImpl, acceptsSubscription, shouldNotify, storage, now?, timeoutMs? })` 返回：

- `overview({ manual?, getSubscription?, onBalanceFallback? })`：先读取订阅快照。可用时返回 `kind: 'subscription'`；读取临时失败时调用 `getSubscription()`，已有可用快照则返回 `kind: 'retained-subscription'`；否则查询 API，返回 `kind: 'balance'`。结果数据位于 `data`。
- `subscription()`：读取额度，用于原有 5 秒本地轮询。
- `records()`：读取用量记录。
- `settings()` / `saveSettings(patch)`：读取及保存用量、音效设置；保存失败拒绝 Promise。
- `pollTurn()`：读取任务结果，返回 `{ record, fresh }`。并发读取期间后来的调用不消费通知；已读结果及启动前历史结果不重复提示。

余额刷新的一轮订阅 / API 请求共用原有 25 秒超时。API 请求发出前调用 `onBalanceFallback()`，由界面清除旧订阅模式。读取结束后不再清除订阅，避免覆盖期间独立轮询收到的新快照。订阅快照读取临时失败时检查最新显示状态，保留已有模式。

通知继续使用 `dshw-last-seq` 与 `dshw-last-turn-id` 存储键。游标读取及写入失败不影响当前进程的通知去重。现有 URL、手动 `?refresh=1` 参数及 `no-store` 语义保持不变。

## 展示接口

`WhaleUsagePresentation` 提供：

- `balance(data)` / `subscription(data)`：返回显示状态补丁 `state`、窗口提示 `title` 和图片描述 `alt`；无效订阅返回 `null`。
- `hasBalance` / `hasSubscription` / `subscriptionFingerprint`：沿用已有的显示判定与变化判定。
- `quotaLines(data)`：返回 5 小时、7 天剩余和 5 小时重置时间文字。
- `balanceBubble(snapshot, { firstSubscriptionQuota, formatMoney })`：返回普通气泡的金额与提示文字。
- `balanceRow(snapshot, type, options)`：转换自定义气泡中的余额 / 今日用量行，与普通气泡共用金额和今日用量文字。
- `taskBubble(notice, formatMoney)`：返回订阅或费用气泡的内容；保留待记账、未知、零金额和估算的区别。

函数返回数据，不修改输入。鲸鱼界面决定渲染时机、样式、队列和播放音效。已有气泡继续使用打开时的数据快照；金额绑定可以按原有机制更新显示币种。

## 验收

- 订阅优先、API 回退与临时失败保留快照保持原行为。
- 手动刷新、超时后恢复、设置保存失败通过请求接口验证。
- 金额不提前取整，配额不转换成金额；待记账和未知金额不显示为零。
- 完成通知每条只消费一次，重启后不重播；现有审批提醒行为保持。
- 真实 Electron 验证新脚本加载、订阅 / API 显示切换及任务结果气泡。

验证入口：`npm test`、`npm run check`、`npm run test:desktop`。桌面测试使用独立临时目录，结果与截图保存到被忽略的 `qa-output/`。

## 验证结果

2026-09-26，macOS 15.6 / Node 24.19.0 / Electron 44.3.0：

- 全部 29 项行为测试通过，包含本次新增的 11 项请求与展示测试。
- 67 个 JavaScript 文件及版本、空白、macOS 启动脚本和 plist 检查通过。
- Electron 初次启动及完整进程重启通过，渲染进程错误为空。验证额度 / API 切换、待记账费用气泡，以及原有审批持久提醒、点击关闭、静音和自定义音效。
- Standards 与 Spec 两项复查通过。API 回退时序与自定义气泡文字重复问题已修复，并由回归测试覆盖。

本地报告与截图：`qa-output/desktop-0.2.5-fQa3n4/`，不提交生成文件。Windows 桌面尚未实测。

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
