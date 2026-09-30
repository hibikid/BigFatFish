# 淘汰跟随 Codex 窗口的模式

挂件最初作为 Codex 桌面应用的伴随挂件，跟随 Codex 窗口移动：Windows 依赖 `desktop/WindowApi.cs`、`WhaleLauncher.cs` 与 `supervisor.ps1`，macOS 依赖 `desktop/macos/` 下的窗口探测与 supervisor。2026-09-30 决定不再保留这一模式，只保留独立桌面宠物（free-desktop）模式。跟随模式无法自动测试（冒烟测试只覆盖 `--free-desktop`），又让 `desktop/main.cjs` 充满平台与模式分支，并带来与 PowerShell、C# 共享的文件契约（`follow-config.json`、`pause-until-host-exit.json`）。后续重构直接删除跟随相关代码，不为它建立 seam。

Codex 仍是用量数据来源；淘汰的只是窗口跟随。删除时需要清理或迁移已安装用户的计划任务、LaunchAgent 和上述文件。
