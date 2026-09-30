import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';

const DEFAULTS = { enabled: false, start: '09:00', end: '21:00', minMinutes: 45, maxMinutes: 90, dailyLimit: 3 };
const minute = value => { const match = /^(\d\d):(\d\d)$/.exec(value); return match && +match[1] < 24 && +match[2] < 60 ? +match[1] * 60 + +match[2] : null; };
const error = message => ({ ok: false, error: message });
const own = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export const POMODORO_TOOLS = Object.freeze([
  { type: 'function', function: { name: 'pomodoro_set', description: 'Set and immediately start one Pomodoro plan. Use only when the user asks to set or replace a timer. You may adapt the requested durations within reasonable bounds; tell the user the actual plan.', parameters: { type: 'object', properties: { focusMinutes: { type: 'integer', minimum: 1, maximum: 240 }, breakMinutes: { type: 'integer', minimum: 1, maximum: 120 }, cycles: { type: 'integer', minimum: 1, maximum: 12 } }, required: ['focusMinutes', 'breakMinutes', 'cycles'], additionalProperties: false } } },
  { type: 'function', function: { name: 'pomodoro_control', description: 'Control the current Pomodoro. Use only when the user asks or answers a phase reminder.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume', 'start_break', 'start_focus', 'extend_focus', 'stop'] }, minutes: { type: 'integer', minimum: 1, maximum: 60 } }, required: ['action'], additionalProperties: false } } },
  { type: 'function', function: { name: 'pomodoro_status', description: 'Read the current Pomodoro state when needed to answer the user.', parameters: { type: 'object', properties: {}, additionalProperties: false } } },
]);

export class ChatActivity {
  constructor({ dataDir, now = Date.now, random = Math.random, onProactive = async () => null, onReminder = async () => null, onNotice = () => {}, canProactive = () => true, startTimer = true }) {
    this.configFile = path.join(dataDir, 'chat-activity.json');
    this.stateFile = path.join(dataDir, 'chat-activity-state.json');
    this.now = now; this.random = random; this.onProactive = onProactive; this.onReminder = onReminder; this.onNotice = onNotice; this.canProactive = canProactive;
    this.config = { ...DEFAULTS, ...readJson(this.configFile, {}) };
    const stored = readJson(this.stateFile, {});
    this.pomodoro = stored.pomodoro || { phase: 'idle' };
    this.notices = Array.isArray(stored.notices) ? stored.notices.slice(-20) : [];
    this.sequence = Number.isSafeInteger(stored.sequence) ? stored.sequence : 0;
    this.acked = Number.isSafeInteger(stored.acked) ? stored.acked : 0;
    this.nextAt = Number.isFinite(stored.nextAt) ? stored.nextAt : 0;
    this.day = stored.day || ''; this.dailyCount = stored.dailyCount || 0;
    this.lastUserAt = stored.lastUserAt || 0;
    this.busy = false; this.closed = false; this.proactiveJob = false; this.lastProactiveCheck = 0;
    this.presence = { busy: false, at: 0 };
    this.timer = startTimer ? setInterval(() => { void this.tick(); }, 1000) : null;
    this.timer?.unref();
    if (startTimer) void this.tick();
  }
  persist() { writeJson(this.stateFile, { pomodoro: this.pomodoro, notices: this.notices, sequence: this.sequence, acked: this.acked, nextAt: this.nextAt, day: this.day, dailyCount: this.dailyCount, lastUserAt: this.lastUserAt }); }
  settings() { return { ...this.config }; }
  saveSettings(input) {
    const config = { enabled: input.enabled === true, start: String(input.start || ''), end: String(input.end || ''), minMinutes: Number(input.minMinutes), maxMinutes: Number(input.maxMinutes), dailyLimit: Number(input.dailyLimit) };
    if (minute(config.start) === null || minute(config.end) === null || config.start === config.end ||
      !Number.isInteger(config.minMinutes) || config.minMinutes < 15 || config.minMinutes > 240 ||
      !Number.isInteger(config.maxMinutes) || config.maxMinutes < config.minMinutes || config.maxMinutes > 360 ||
      !Number.isInteger(config.dailyLimit) || config.dailyLimit < 1 || config.dailyLimit > 12) throw new Error('主动闲聊的时间段或频率无效');
    writeJson(this.configFile, config); this.config = config;
    this.nextAt = this.now() + this.intervalMs(); this.persist();
    return this.settings();
  }
  intervalMs() { const { minMinutes, maxMinutes } = this.config; return Math.round((minMinutes + this.random() * (maxMinutes - minMinutes)) * 60000); }
  inWindow(timestamp) {
    const date = new Date(timestamp), current = date.getHours() * 60 + date.getMinutes();
    const start = minute(this.config.start), end = minute(this.config.end);
    return start < end ? current >= start && current < end : current >= start || current < end;
  }
  userActivity() { this.lastUserAt = this.now(); this.nextAt = Math.max(this.nextAt, this.lastUserAt + 20 * 60000); this.persist(); }
  setPresence(input) { this.presence = { busy: input.busy === true, at: this.now() }; }
  snapshot() {
    const state = { ...this.pomodoro };
    if (['focus', 'break'].includes(state.phase)) state.remainingSeconds = Math.max(0, Math.ceil((state.dueAt - this.now()) / 1000));
    if (state.phase === 'paused') state.remainingSeconds = Math.max(0, Math.ceil(state.remainingMs / 1000));
    return { settings: this.settings(), pomodoro: state, notices: this.notices.filter(item => item.seq > this.acked) };
  }
  ack(seq) { if (Number.isSafeInteger(seq) && seq > this.acked && seq <= this.sequence) { this.acked = seq; this.notices = this.notices.filter(item => item.seq > seq); this.persist(); } }
  notice(kind, text, conversationId, advance = null) {
    const item = { seq: ++this.sequence, kind, text, conversationId: conversationId || null, createdAt: new Date(this.now()).toISOString(), ...(advance ? { advance } : {}) };
    const previous = this.notices;
    this.notices = [...this.notices, item].slice(-20);
    try { this.persist(); }
    catch (failure) { this.sequence--; this.notices = previous; throw failure; }
    try { this.onNotice(item); } catch {}
    return item;
  }
  advance(input) {
    const current = this.pomodoro;
    // The reminder remains actionable after display acknowledgement, but only for its original transition.
    if (!own(input, ['planId', 'reminderId', 'phase', 'cycle']) || !input.reminderId ||
      !['await_break', 'await_focus'].includes(current.phase) ||
      ['planId', 'reminderId', 'phase', 'cycle'].some(key => input[key] !== current[key])) {
      return { ok: true, advanced: false, pomodoro: this.snapshot().pomodoro };
    }
    const result = this.tool({ name: 'pomodoro_control', arguments: JSON.stringify({ action: current.phase === 'await_break' ? 'start_break' : 'start_focus' }) }, current.conversationId);
    return { ...result, advanced: result.ok };
  }
  tool(call, conversationId) {
    if (!call || typeof call !== 'object' || !POMODORO_TOOLS.some(tool => tool.function.name === call.name) || typeof call.arguments !== 'string' || call.arguments.length > 4096) return error('此操作不在预授权范围内');
    let args;
    try { args = JSON.parse(call.arguments); } catch { return error('操作参数格式无效'); }
    const now = this.now(), current = this.pomodoro;
    if (call.name === 'pomodoro_status') return own(args, []) ? { ok: true, pomodoro: this.snapshot().pomodoro } : error('操作参数格式无效');
    if (call.name === 'pomodoro_set') {
      if (!own(args, ['focusMinutes', 'breakMinutes', 'cycles']) || !Number.isInteger(args.focusMinutes) || args.focusMinutes < 1 || args.focusMinutes > 240 ||
        !Number.isInteger(args.breakMinutes) || args.breakMinutes < 1 || args.breakMinutes > 120 || !Number.isInteger(args.cycles) || args.cycles < 1 || args.cycles > 12 ||
        args.focusMinutes * args.cycles + args.breakMinutes * (args.cycles - 1) > 24 * 60) return error('番茄钟数值超出预授权范围');
      this.pomodoro = { phase: 'focus', planId: randomUUID(), focusMinutes: args.focusMinutes, breakMinutes: args.breakMinutes, cycles: args.cycles, cycle: 1, dueAt: now + args.focusMinutes * 60000, conversationId };
    } else {
      if (!own(args, ['action', 'minutes']) || !['pause', 'resume', 'start_break', 'start_focus', 'extend_focus', 'stop'].includes(args.action)) return error('此操作不在预授权范围内');
      if (args.action === 'pause' && ['focus', 'break'].includes(current.phase)) this.pomodoro = { ...current, phase: 'paused', pausedFrom: current.phase, remainingMs: Math.max(0, current.dueAt - now), dueAt: null };
      else if (args.action === 'resume' && current.phase === 'paused') this.pomodoro = { ...current, phase: current.pausedFrom, dueAt: now + current.remainingMs, pausedFrom: null, remainingMs: null };
      else if (args.action === 'start_break' && ['focus', 'await_break'].includes(current.phase) && current.cycle < current.cycles) this.pomodoro = { ...current, phase: 'break', dueAt: now + current.breakMinutes * 60000 };
      else if (args.action === 'start_focus' && ['break', 'await_focus'].includes(current.phase) && current.cycle < current.cycles) this.pomodoro = { ...current, phase: 'focus', cycle: current.cycle + 1, dueAt: now + current.focusMinutes * 60000 };
      else if (args.action === 'extend_focus' && ['focus', 'await_break'].includes(current.phase) && Number.isInteger(args.minutes) && args.minutes >= 1 && args.minutes <= 60) this.pomodoro = { ...current, phase: 'focus', dueAt: Math.max(now, current.dueAt || now) + args.minutes * 60000 };
      else if (args.action === 'stop' && !['idle', 'completed'].includes(current.phase)) this.pomodoro = { phase: 'idle' };
      else return error('当前阶段不能执行此操作');
    }
    try { this.persist(); }
    catch (failure) { this.pomodoro = current; throw failure; }
    return { ok: true, pomodoro: this.snapshot().pomodoro };
  }
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    const jobs = [];
    try {
      const now = this.now(), timer = this.pomodoro;
      if (['focus', 'break'].includes(timer.phase) && now >= timer.dueAt) {
        const next = timer.phase === 'focus' ? timer.cycle === timer.cycles ? 'completed' : 'await_break' : 'await_focus';
        this.pomodoro = { ...timer, phase: next, dueAt: null, reminderId: randomUUID() };
        try { this.persist(); }
        catch { this.pomodoro = timer; return; }
        const reminderId = this.pomodoro.reminderId;
        const fallback = next === 'completed' ? '这轮专注完成了，辛苦啦。' : next === 'await_break' ? '专注时间到了，准备休息一下吧。' : '休息时间到了，准备开始下一轮专注吧。';
        jobs.push((async () => {
          const generated = await this.onReminder({ ...this.pomodoro, fallback }).catch(() => null);
          if (this.closed || this.pomodoro.planId !== timer.planId || this.pomodoro.phase !== next || this.pomodoro.cycle !== timer.cycle || this.pomodoro.reminderId !== reminderId) return;
          const advance = next === 'completed' ? null : { planId: timer.planId, reminderId, phase: next, cycle: timer.cycle };
          this.notice('pomodoro', (typeof generated === 'string' ? generated : generated?.text) || fallback, generated?.conversationId || timer.conversationId, advance);
        })());
      }
      if (now - this.lastProactiveCheck >= 30000) {
        this.lastProactiveCheck = now;
        if (this.config.enabled && this.inWindow(now) && ['idle', 'completed'].includes(this.pomodoro.phase) && this.canProactive() && !this.proactiveJob &&
          !(this.presence.busy && now - this.presence.at < 10000)) {
          const day = new Date(now).toLocaleDateString('en-CA');
          if (this.day !== day) { this.day = day; this.dailyCount = 0; }
          if (!this.nextAt || this.nextAt < now - 2 * 3600000) { this.nextAt = now + this.intervalMs(); this.persist(); }
          else if (now >= this.nextAt && this.dailyCount < this.config.dailyLimit && now - this.lastUserAt >= 20 * 60000 && !this.notices.some(item => item.seq > this.acked)) {
            this.nextAt = now + this.intervalMs(); this.dailyCount++; this.proactiveJob = true; this.persist();
            jobs.push((async () => {
              try {
                const generated = await this.onProactive().catch(() => null);
                if (!this.closed && generated?.text && ['idle', 'completed'].includes(this.pomodoro.phase)) this.notice('proactive', generated.text, generated.conversationId);
                else { this.dailyCount--; this.persist(); }
              } finally { this.proactiveJob = false; }
            })());
          }
        }
      }
    } finally { this.busy = false; }
    await Promise.allSettled(jobs);
  }
  close() { this.closed = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
}
