import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './paths.mjs';

const FILE = 'claude-subscription.json';
const TURN_FILE = 'claude-last-turn.json';
const windowValue = (value, now) => {
  const usedPercent = value?.used_percentage, resetSeconds = value?.resets_at;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
    typeof resetSeconds !== 'number' || !Number.isSafeInteger(resetSeconds)) return null;
  const resetsAt = resetSeconds * 1000;
  if (resetsAt <= now || !Number.isFinite(resetsAt)) return null;
  return { usedPercent, resetsAt };
};

export function captureClaudeUsage(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const limits = input.rate_limits;
  return { source: 'claude-statusline', observedAt: now,
    fiveHour: windowValue(limits?.five_hour, now), sevenDay: windowValue(limits?.seven_day, now) };
}

export function saveClaudeUsage(dataDir, input, now = Date.now()) {
  const snapshot = captureClaudeUsage(input, now);
  if (!snapshot) return false;
  writeJson(path.join(dataDir, FILE), snapshot);
  return true;
}

function publicWindow(value, now) {
  if (!value || typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent) ||
    value.usedPercent < 0 || value.usedPercent > 100 || !Number.isFinite(value.resetsAt) || value.resetsAt <= now) return null;
  return { usedPercent: value.usedPercent, remainingPercent: 100 - value.usedPercent, resetsAt: new Date(value.resetsAt).toISOString() };
}

export function claudeSubscription(dataDir, now = Date.now()) {
  let snapshot;
  try { snapshot = readJson(path.join(dataDir, FILE), null); } catch { return { ok: true, available: false, source: 'claude-statusline' }; }
  if (snapshot?.source !== 'claude-statusline' || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now + 60000) {
    return { ok: true, available: false, source: 'claude-statusline' };
  }
  const fiveHour = publicWindow(snapshot.fiveHour, now), sevenDay = publicWindow(snapshot.sevenDay, now);
  return { ok: true, available: !!(fiveHour || sevenDay), source: 'claude-statusline', provider: 'Claude',
    observedAt: new Date(snapshot.observedAt).toISOString(), fiveHour, sevenDay };
}

export function saveClaudeTurn(dataDir, input, now = Date.now()) {
  if (!input || input.hook_event_name !== 'Stop' || typeof input.session_id !== 'string' || !input.session_id ||
    !Number.isFinite(now) || now <= 0) return false;
  writeJson(path.join(dataDir, TURN_FILE), { source: 'claude-stop', id: randomUUID(), completedAt: now });
  return true;
}

export function claudeLastTurn(dataDir, now = Date.now()) {
  let turn;
  try { turn = readJson(path.join(dataDir, TURN_FILE), null); } catch { turn = null; }
  if (!turn || turn.source !== 'claude-stop' || typeof turn.id !== 'string' || !Number.isFinite(turn.completedAt) ||
    turn.completedAt > now + 60000) return { ok: true, available: false, provider: 'Claude' };
  return { ok: true, available: true, provider: 'Claude', id: turn.id, completedAt: turn.completedAt,
    subscription: claudeSubscription(dataDir, now) };
}
