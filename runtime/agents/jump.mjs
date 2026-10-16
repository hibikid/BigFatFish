import { execFile } from 'node:child_process';

// Brings the user to a session. On macOS: the Ghostty tab whose terminal sits
// in the session's folder, or the thread in the Codex app; macOS asks once
// whether the pet may control Ghostty. On Windows: the Windows Terminal tab
// or console window whose title names the project or the tool, or the
// thread in the Codex app.
const GHOSTTY_ID = 'com.mitchellh.ghostty';
const CODEX_APP_ID = 'com.openai.codex';
// argv: the folder, then words the terminal's title may hold for this tool,
// to choose between tabs open in the same folder.
export const GHOSTTY_SCRIPT = `on run argv
  set target to item 1 of argv
  set hints to rest of argv
  if not (application id "${GHOSTTY_ID}" is running) then return "none"
  tell application id "${GHOSTTY_ID}"
    set exact to {}
    set inside to {}
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in terminals of t
          try
            set d to working directory of s
            if d is target or d is (target & "/") then
              set end of exact to {t, s}
            else if d starts with (target & "/") then
              set end of inside to {t, s}
            end if
          end try
        end repeat
      end repeat
    end repeat
    set found to exact
    if found is {} then set found to inside
    if found is {} then
      activate
      return "app"
    end if
    set pick to item 1 of found
    set matched to false
    repeat with candidate in found
      if matched then exit repeat
      try
        set tabTitle to name of (item 2 of candidate)
        repeat with h in hints
          if tabTitle contains (h as text) then
            set pick to candidate
            set matched to true
            exit repeat
          end if
        end repeat
      end try
    end repeat
    select tab (item 1 of pick)
    focus (item 2 of pick)
    activate
    return "tab"
  end tell
end run`;
const TITLE_HINTS = { claude: ['Claude', '✳'], codex: ['codex', 'Codex'] };

// Windows Terminal says nothing about a tab's folder, only its title, so the
// tab whose title names the project wins, then one that names the tool.
// Console windows outside Windows Terminal count as tabs of their own. With
// no match the first terminal window comes forward. Windows lets a process
// bring a window forward only just after user input; a tap of Alt counts.
export const WINDOWS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace Whale -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
'@
$auto = [System.Windows.Automation.AutomationElement]
$scope = [System.Windows.Automation.TreeScope]
$windows = @($auto::RootElement.FindAll($scope::Children, [System.Windows.Automation.Condition]::TrueCondition) |
  Where-Object { @('CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass') -contains $_.Current.ClassName })
if ($windows.Count -eq 0) { 'none'; return }
$tabType = New-Object System.Windows.Automation.PropertyCondition($auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
$best = $null; $bestScore = 0
foreach ($window in $windows) {
  $items = if ($window.Current.ClassName -eq 'ConsoleWindowClass') { @($window) } else { @($window.FindAll($scope::Descendants, $tabType)) }
  foreach ($item in $items) {
    $title = [string]$item.Current.Name
    $score = 0
    if ($name -and $title.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $score += 2 }
    foreach ($hint in $hints) { if ($title.IndexOf($hint, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $score += 1; break } }
    if ($score -gt $bestScore) { $best = @($window, $item); $bestScore = $score }
  }
}
$target = if ($best) { $best[0] } else { $windows[0] }
$handle = [IntPtr]$target.Current.NativeWindowHandle
if ([Whale.Win]::IsIconic($handle)) { [void][Whale.Win]::ShowWindow($handle, 9) }
[Whale.Win]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[Whale.Win]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][Whale.Win]::SetForegroundWindow($handle)
if (-not $best) { 'app'; return }
if (-not [object]::ReferenceEquals($best[0], $best[1])) {
  try { $best[1].GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() } catch { 'app'; return }
}
'tab'`;
// A PowerShell string literal: single quotes, with each one doubled.
const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
function windowsCommand(row) {
  const prelude = '$name = ' + literal(row.name || '') + '\n$hints = @(' + (TITLE_HINTS[row.tool] || []).map(literal).join(', ') + ')\n';
  // Encoded, the script needs no quoting and runs whatever the execution policy.
  return Buffer.from(prelude + WINDOWS_SCRIPT, 'utf16le').toString('base64');
}

const codexThread = row => 'codex://threads/' + encodeURIComponent(row.id.replace(/^codex:/, ''));
export function jumpPlan(row, platform = process.platform) {
  if (!row || !['darwin', 'win32'].includes(platform)) return null;
  if (row.tool === 'codex' && row.app) {
    return platform === 'darwin' ? { kind: 'codex-app', command: 'open', args: [codexThread(row)] }
      : { kind: 'codex-app', command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', codexThread(row)] };
  }
  if (platform === 'win32') {
    return { kind: 'windows-terminal', command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', windowsCommand(row)] };
  }
  if (!row.cwd) return null;
  return { kind: 'ghostty', command: 'osascript', args: ['-e', GHOSTTY_SCRIPT, row.cwd, ...(TITLE_HINTS[row.tool] || [])] };
}

const runFile = (command, args, { timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
    if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
  });
});

const TERMINAL = { ghostty: 'Ghostty', 'windows-terminal': '终端' };
export async function jumpTo(row, { run = runFile, platform = process.platform } = {}) {
  const plan = jumpPlan(row, platform);
  if (!plan) return { ok: false, error: ['darwin', 'win32'].includes(platform) ? '不知道这个会话在哪个文件夹' : '跳转目前只支持 macOS 和 Windows' };
  const terminal = TERMINAL[plan.kind];
  try {
    const output = String(await run(plan.command, plan.args, { timeout: 30000 })).trim();
    if (plan.kind === 'codex-app') return { ok: true, target: 'codex-app' };
    if (output === 'tab') return { ok: true, target: 'tab' };
    if (output === 'app') return { ok: true, target: 'app', message: plan.kind === 'ghostty' ? '没找到这个文件夹的标签，已切到 Ghostty' : '没找到这个会话的标签，已切到终端' };
    return { ok: false, error: plan.kind === 'ghostty' ? 'Ghostty 没有在运行' : '没有找到打开的终端窗口' };
  } catch (error) {
    if (plan.kind === 'codex-app') {
      if (platform === 'darwin') try { await run('open', ['-b', CODEX_APP_ID], { timeout: 10000 }); return { ok: true, target: 'codex-app' }; } catch {}
      return { ok: false, error: '没能打开 Codex 应用' };
    }
    if (/-1743|not authori[sz]ed|不允许/i.test(String(error?.stderr || '') + String(error?.message || ''))) {
      return { ok: false, error: '需要允许大肥鱼控制 Ghostty：系统设置 › 隐私与安全性 › 自动化' };
    }
    return { ok: false, error: '没能切到' + terminal };
  }
}
