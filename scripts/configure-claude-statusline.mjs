import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_HOME, ROOT, readJson, writeJson } from '../runtime/paths.mjs';

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const ownedCommand = value => typeof value === 'string' && value.includes(quote(path.join(ROOT, 'scripts', 'claude-statusline.mjs')));
const ownedStop = value => value?.type === 'command' && typeof value.command === 'string' &&
  value.command.includes(quote(path.join(ROOT, 'scripts', 'claude-stop.mjs')));
const defaultNodePath = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(candidate => fs.existsSync(candidate)) || process.execPath;

export function configureClaudeStatusline(action, { claudeHome = path.join(os.homedir(), '.claude'), dataDir = DATA_HOME, nodePath = defaultNodePath } = {}) {
  const settingsFile = path.join(claudeHome, 'settings.json');
  const settings = readJson(settingsFile, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude 设置不是 JSON 对象');
  if (action === 'install') {
    if (settings.statusLine && !ownedCommand(settings.statusLine.command)) throw new Error('Claude 已配置其他状态栏命令，未覆盖');
    const command = [nodePath, path.join(ROOT, 'scripts', 'claude-statusline.mjs'), '--data-dir', dataDir].map(quote).join(' ');
    const hooks = settings.hooks || {};
    if (typeof hooks !== 'object' || Array.isArray(hooks) || hooks.Stop && !Array.isArray(hooks.Stop)) throw new Error('Claude hooks 设置格式无效');
    const stopCommand = [nodePath, path.join(ROOT, 'scripts', 'claude-stop.mjs'), '--data-dir', dataDir].map(quote).join(' ');
    const stopHooks = (hooks.Stop || []).map(group => ({ ...group,
      hooks: Array.isArray(group?.hooks) ? group.hooks.filter(hook => !ownedStop(hook)) : group?.hooks
    })).filter(group => !Array.isArray(group.hooks) || group.hooks.length);
    stopHooks.push({ hooks: [{ type: 'command', command: stopCommand, timeout: 5 }] });
    const next = { ...settings, statusLine: { type: 'command', command }, hooks: { ...hooks, Stop: stopHooks } };
    if (JSON.stringify(settings) === JSON.stringify(next)) return 'already-installed';
    writeJson(settingsFile, next);
    return 'installed';
  }
  if (action === 'uninstall') {
    const removeStatusLine = ownedCommand(settings.statusLine?.command);
    const hooks = settings.hooks;
    const stop = Array.isArray(hooks?.Stop) ? hooks.Stop.map(group => ({ ...group,
      hooks: Array.isArray(group?.hooks) ? group.hooks.filter(hook => !ownedStop(hook)) : group?.hooks
    })).filter(group => !Array.isArray(group.hooks) || group.hooks.length) : null;
    const removedStop = stop && JSON.stringify(stop) !== JSON.stringify(hooks.Stop);
    if (!removeStatusLine && !removedStop) return 'not-installed';
    const rest = { ...settings };
    if (removeStatusLine) delete rest.statusLine;
    if (removedStop) {
      const nextHooks = { ...hooks };
      if (stop.length) nextHooks.Stop = stop; else delete nextHooks.Stop;
      if (Object.keys(nextHooks).length) rest.hooks = nextHooks; else delete rest.hooks;
    }
    writeJson(settingsFile, rest);
    return 'uninstalled';
  }
  throw new Error('Use install or uninstall');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(configureClaudeStatusline(process.argv[2]) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
