import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CODEX_HOME, DATA_HOME, readJson } from '../runtime/paths.mjs';
import { claudeIntegrationStatus, findNode } from '../runtime/claude-integration.mjs';
import { readClaudeSessions } from '../runtime/agents/claude-hooks.mjs';
import { jumpTo } from '../runtime/agents/jump.mjs';
import { runningService } from '../runtime/process.mjs';

// Checks, on the machine itself, the parts of the pet that depend on how the
// system runs other programs. Each installed command runs the way Codex or
// Claude Code runs it, fed made-up input, so no model quota is spent.
//   node scripts/windows-check.mjs env
//   node scripts/windows-check.mjs codex-hook
//   node scripts/windows-check.mjs claude [--claude-home <folder>]
//   node scripts/windows-check.mjs jump <project> [claude|codex|app <thread id>]
const windows = process.platform === 'win32';
const option = name => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : ''; };
const claudeHome = option('--claude-home') || path.join(os.homedir(), '.claude');
const SESSION = 'windows-check';
// A folder no real session works in, so the check never marks one of them.
const FOLDER = windows ? 'C:\\whale-windows-check' : '/tmp/whale-windows-check';
const say = (ok, label, detail = '') => process.stdout.write((ok ? '通过  ' : '失败  ') + label + (detail ? '\n      ' + String(detail).trim().replaceAll('\n', '\n      ') : '') + '\n');
const isFile = file => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// Git Bash, which Claude Code runs commands in on Windows. bash.exe in
// System32 is WSL's and is never it.
function gitBash() {
  if (!windows) return process.env.SHELL || '/bin/sh';
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  return [process.env.CLAUDE_CODE_GIT_BASH_PATH, ...roots.map(root => path.join(root, 'Git', 'bin', 'bash.exe'))].filter(Boolean).find(isFile) || '';
}
// Exactly how Codex runs a hook: %COMSPEC% /C "<command>" on Windows, sh -lc elsewhere.
function runLikeCodex(command, input) {
  return windows
    ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/C', '"' + command + '"'], { windowsVerbatimArguments: true, input, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    : spawnSync('/bin/sh', ['-lc', command], { input, encoding: 'utf8', timeout: 15000 });
}
function runLikeClaude(command, input) {
  const bash = gitBash();
  if (!bash) return { status: null, stdout: '', stderr: '找不到 Git Bash：Claude Code 在 Windows 上需要 Git for Windows' };
  return spawnSync(bash, ['-c', command], { input, encoding: 'utf8', windowsHide: true, timeout: 15000 });
}
const result = run => `退出码 ${run.status}${run.error ? '，' + run.error.message : ''}${run.stderr ? '\nstderr: ' + run.stderr : ''}`;

async function env() {
  say(true, '系统', `${process.platform} ${os.release()}，Node ${process.version}`);
  say(true, '数据目录', DATA_HOME + (fs.existsSync(DATA_HOME) ? '' : '（还不存在）'));
  say(true, 'Codex 目录', CODEX_HOME + (fs.existsSync(path.join(CODEX_HOME, 'sessions')) ? '，有会话日志' : '，还没有会话日志'));
  const node = findNode();
  say(node !== process.execPath || !process.versions.electron, '给 Claude 用的 Node', node);
  if (windows) say(!!gitBash(), 'Git Bash', gitBash() || '没找到');
  const running = await runningService(DATA_HOME);
  say(!!running, '大肥鱼在运行', running ? `版本 ${running.version}，平台 ${running.platform || '?'}` : '没有响应：运行“启动桌面挂件.cmd”，失败时看数据目录里的 *-error.json');
  const claude = claudeIntegrationStatus({ claudeHome });
  say(claude.installed && claude.tracking, 'Claude 接入', JSON.stringify(claude));
  const hook = codexHook();
  say(!!hook, 'Codex 审批 hook', hook || '没装：npm run install:approvals');
}

function codexHook() {
  let config;
  try { config = readJson(path.join(CODEX_HOME, 'hooks.json'), null); } catch { return ''; }
  const groups = Array.isArray(config?.hooks?.PermissionRequest) ? config.hooks.PermissionRequest : [];
  return groups.flatMap(group => Array.isArray(group?.hooks) ? group.hooks : []).map(hook => hook?.command)
    .find(command => typeof command === 'string' && command.includes('approval-request-hook.mjs')) || '';
}

function codex() {
  const command = codexHook();
  if (!command) return say(false, 'Codex 审批 hook', '没装：npm run install:approvals');
  say(true, 'hook 命令', command);
  let trusted = '';
  try { trusted = fs.readFileSync(path.join(CODEX_HOME, 'config.toml'), 'utf8').match(/hooks\.json:permission_request:[^\]"]*/g)?.join(', ') || ''; } catch {}
  say(!!trusted, 'Codex 记录了信任', trusted || '在 Codex CLI 里打开 /hooks 信任这条 hook，否则 Codex 不会运行它');
  const run = runLikeCodex(command, JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: SESSION, cwd: FOLDER,
    tool_name: 'Bash', tool_input: { command: 'echo windows-check' } }));
  say(run.status === 0 && !run.stdout.trim(), '按 Codex 的方式运行', result(run));
  process.stdout.write('      大肥鱼在运行时，现在应弹出“需要批准”的提醒（点一下关闭）。\n');
}

function claude() {
  let settings;
  try { settings = readJson(path.join(claudeHome, 'settings.json'), {}); } catch (error) { return say(false, 'Claude 设置', error.message); }
  const status = settings?.statusLine?.command, hook = (settings?.hooks?.UserPromptSubmit || [])
    .flatMap(group => group?.hooks || []).map(item => item?.command).find(command => typeof command === 'string' && command.includes('claude-hook.mjs'));
  if (!status || !hook) return say(false, 'Claude 接入', '先在额度管理里点“接入 Claude Code”或“更新接入”');
  say(true, '状态栏命令', status);
  say(true, 'hook 命令', hook);
  const usage = { session_id: SESSION, cwd: FOLDER, context_window: { context_window_size: 200000, used_percentage: 10,
    current_usage: { input_tokens: 19000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1000 } } };
  const line = runLikeClaude(status, JSON.stringify(usage));
  say(line.status === 0 && /^Claude/.test(line.stdout), '按 Claude Code 的方式运行状态栏', result(line) + '\nstdout: ' + line.stdout);
  const prompt = runLikeClaude(hook, JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: SESSION, cwd: FOLDER, prompt: 'windows-check' }));
  say(prompt.status === 0 && !prompt.stdout, '按 Claude Code 的方式运行 hook', result(prompt) + (prompt.stdout ? '\nstdout 应为空: ' + prompt.stdout : ''));
  const seen = readClaudeSessions(DATA_HOME).find(item => item.sessionId === SESSION);
  say(seen?.state?.state === 'running' && seen?.usage?.tokens === 20000, '任务小窗读到了这个会话', JSON.stringify(seen || '数据目录里没有：看命令里的 --data-dir 是否就是 ' + DATA_HOME));
  runLikeClaude(hook, JSON.stringify({ hook_event_name: 'SessionEnd', session_id: SESSION, cwd: FOLDER, reason: 'other' }));
  say(!readClaudeSessions(DATA_HOME).some(item => item.sessionId === SESSION), 'SessionEnd 清掉了测试会话');
}

async function jump() {
  const [name, kind = 'claude', thread = 'windows-check'] = process.argv.slice(3);
  if (!name) return say(false, '用法', 'node scripts/windows-check.mjs jump <项目名> [claude|codex|app <线程 id>]');
  const row = kind === 'app' ? { id: 'codex:' + thread, tool: 'codex', app: true, name, cwd: FOLDER } : { id: kind + ':' + SESSION, tool: kind, app: false, name, cwd: FOLDER };
  const outcome = await jumpTo(row);
  say(outcome.ok, '跳转', JSON.stringify(outcome));
}

const commands = { env, 'codex-hook': codex, claude, jump };
const command = commands[process.argv[2]];
if (!command) { process.stderr.write('用法：node scripts/windows-check.mjs env | codex-hook | claude | jump <项目名> [claude|codex|app <线程 id>]\n'); process.exitCode = 1; }
else await command();
