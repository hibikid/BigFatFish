import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_HOME, ROOT, readJson, writeJson } from './paths.mjs';

// Connects Claude Code to the pet: its status line reports the subscription
// quota, and its Stop hook reports each finished reply. Only the pet's own
// commands are ever added or removed; anything else in the settings stays.
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
const ownedCommand = value => typeof value === 'string' && value.includes(quote(path.join(ROOT, 'scripts', 'claude-statusline.mjs')));
const ownedStop = value => value?.type === 'command' && typeof value.command === 'string' &&
  value.command.includes(quote(path.join(ROOT, 'scripts', 'claude-stop.mjs')));
const defaultNodePath = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(candidate => fs.existsSync(candidate)) || process.execPath;
// Inside the desktop app the fallback runtime is Electron, which runs scripts as Node only when told to.
const runner = nodePath => (process.versions.electron && nodePath === process.execPath ? 'ELECTRON_RUN_AS_NODE=1 ' : '') + quote(nodePath);

export function configureClaudeStatusline(action, { claudeHome = path.join(os.homedir(), '.claude'), dataDir = DATA_HOME, nodePath = defaultNodePath } = {}) {
  const settingsFile = path.join(claudeHome, 'settings.json');
  const settings = readJson(settingsFile, {});
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude 设置不是 JSON 对象');
  if (action === 'install') {
    if (settings.statusLine && !ownedCommand(settings.statusLine.command)) throw new Error('Claude 已配置其他状态栏命令，未覆盖');
    const command = runner(nodePath) + ' ' + [path.join(ROOT, 'scripts', 'claude-statusline.mjs'), '--data-dir', dataDir].map(quote).join(' ');
    const hooks = settings.hooks || {};
    if (typeof hooks !== 'object' || Array.isArray(hooks) || hooks.Stop && !Array.isArray(hooks.Stop)) throw new Error('Claude hooks 设置格式无效');
    const stopCommand = runner(nodePath) + ' ' + [path.join(ROOT, 'scripts', 'claude-stop.mjs'), '--data-dir', dataDir].map(quote).join(' ');
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

// Whether Claude Code reports to the pet: its status line and Stop hook are the pet's.
export function claudeIntegrationStatus({ claudeHome = path.join(os.homedir(), '.claude') } = {}) {
  let settings;
  try { settings = readJson(path.join(claudeHome, 'settings.json'), {}); } catch { return { installed: false, statusLine: 'unreadable', stop: false }; }
  const statusLine = !settings?.statusLine ? 'none' : ownedCommand(settings.statusLine.command) ? 'pet' : 'other';
  const stop = Array.isArray(settings?.hooks?.Stop) && settings.hooks.Stop.some(group => Array.isArray(group?.hooks) && group.hooks.some(ownedStop));
  return { installed: statusLine === 'pet' && stop, statusLine, stop };
}
