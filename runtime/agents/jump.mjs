import { execFile } from 'node:child_process';

// Brings the user to a session: the Ghostty tab whose terminal sits in the
// session's folder, or the thread in the Codex app. macOS asks once whether
// the pet may control Ghostty.
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

export function jumpPlan(row, platform = process.platform) {
  if (platform !== 'darwin' || !row) return null;
  if (row.tool === 'codex' && row.app) {
    return { kind: 'codex-app', command: 'open', args: ['codex://threads/' + encodeURIComponent(row.id.replace(/^codex:/, ''))] };
  }
  if (!row.cwd) return null;
  return { kind: 'ghostty', command: 'osascript', args: ['-e', GHOSTTY_SCRIPT, row.cwd, ...(TITLE_HINTS[row.tool] || [])] };
}

const runFile = (command, args, { timeout = 30000 } = {}) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (error) { error.stderr = stderr; reject(error); } else resolve(stdout);
  });
});

export async function jumpTo(row, { run = runFile, platform = process.platform } = {}) {
  const plan = jumpPlan(row, platform);
  if (!plan) return { ok: false, error: platform === 'darwin' ? '不知道这个会话在哪个文件夹' : '跳转目前只支持 macOS' };
  try {
    const output = String(await run(plan.command, plan.args, { timeout: 30000 })).trim();
    if (plan.kind === 'codex-app') return { ok: true, target: 'codex-app' };
    if (output === 'tab') return { ok: true, target: 'tab' };
    if (output === 'app') return { ok: true, target: 'app', message: '没找到这个文件夹的标签，已切到 Ghostty' };
    return { ok: false, error: 'Ghostty 没有在运行' };
  } catch (error) {
    if (plan.kind === 'codex-app') {
      try { await run('open', ['-b', CODEX_APP_ID], { timeout: 10000 }); return { ok: true, target: 'codex-app' }; } catch {}
      return { ok: false, error: '没能打开 Codex 应用' };
    }
    if (/-1743|not authori[sz]ed|不允许/i.test(String(error?.stderr || '') + String(error?.message || ''))) {
      return { ok: false, error: '需要允许大肥鱼控制 Ghostty：系统设置 › 隐私与安全性 › 自动化' };
    }
    return { ok: false, error: '没能切到 Ghostty' };
  }
}
