import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, dayKey, rounded } from './paths.mjs';

const initialLedger = () => ({ version: 1, date: '', observed: 0, firstObservation: null, lastObservation: null, history: {}, events: [] });
const emptySessionSummary = () => ({ tokens: 0, turns: 0, amounts: new Map() });
const addAmount = (summary, currency, value) => {
  if (!/^[A-Z]{3}$/.test(currency || '') || !Number.isFinite(value)) return;
  summary.amounts.set(currency, rounded((summary.amounts.get(currency) || 0) + value));
};
const publicSessionSummary = summary => ({ tokens: Math.max(0, Math.floor(summary.tokens)), turns: summary.turns,
  amounts: [...summary.amounts].map(([currency, total]) => ({ currency, total: rounded(total) })).sort((a, b) => a.currency.localeCompare(b.currency)) });

export class UsageLedger {
  constructor(dataDir) { this.dataDir = dataDir; }
  file(scope) {
    if (!/^[a-f0-9]{24}-[A-Z]{3}$/.test(scope)) throw new Error('记账账户标识无效');
    return path.join(this.dataDir, 'ledgers', scope + '.json');
  }
  load(scope) { return readJson(this.file(scope), initialLedger()); }
  save(scope, ledger) { writeJson(this.file(scope), ledger); }
  rollover(led, now) {
    const today = dayKey(now);
    if (led.date !== today) {
      if (led.date) led.history[led.date] = { total: led.observed, since: led.firstObservation };
      // Keep the last meter reading across midnight. The interval spanning
      // midnight belongs to its observation date; it is not a per-request bill.
      led.date = today; led.observed = 0; led.firstObservation = null;
    }
    return led;
  }
  observe(scope, sample, now = Date.now()) {
    const led = this.rollover(this.load(scope), now);
    const balance = Number.isFinite(sample.totalBalance) ? sample.totalBalance : null;
    const used = Number.isFinite(sample.totalUsed) ? sample.totalUsed : null;
    const last = led.lastObservation;
    let delta = 0;
    const meterKey = typeof sample.meterKey === 'string' && /^[a-f0-9]{64}$/.test(sample.meterKey) ? sample.meterKey : null;
    // A newer reading can legitimately reset to zero. Ordering is handled by
    // the service, while a changed adapter/scale starts a new meter baseline.
    if (last && (!meterKey || !last.meterKey || last.meterKey === meterKey)) {
      if (used !== null && last.used !== null && used >= last.used) delta = used - last.used;
      else if (used === null && last.used === null && balance !== null && last.balance !== null) delta = Math.max(0, last.balance - balance);
    }
    led.observed = rounded(led.observed + delta);
    led.firstObservation ||= now;
    led.lastObservation = { balance, used, at: now, ...(meterKey ? { meterKey } : {}) };
    this.save(scope, led); return led;
  }
  append(scope, event) {
    const led = this.load(scope);
    if (led.events.some(e => this.sameEvent(e, event))) return false;
    led.events.push({ ...event, day: dayKey(event.ts) });
    led.events = led.events.slice(-8000);
    this.save(scope, led); return true;
  }
  sameEvent(existing, event) {
    return existing.id === event.id || !!(event.sessionId && event.turnId &&
      existing.id?.endsWith(event.sessionId + ':' + event.turnId));
  }
  find(scope, event) { return this.load(scope).events.find(e => this.sameEvent(e, event)) || null; }
  revise(scope, id, patch) {
    const led = this.load(scope), index = led.events.findIndex(e => e.id === id);
    if (index < 0) return null;
    const before = led.events[index];
    if (Object.entries(patch).every(([key, value]) => JSON.stringify(before[key]) === JSON.stringify(value))) return before;
    const next = { ...before, ...patch, id: before.id, ts: before.ts, day: before.day, revision: (before.revision || 0) + 1 };
    led.events[index] = next; this.save(scope, led); return next;
  }
  records(scope, now = Date.now()) {
    const led = this.rollover(this.load(scope), now);
    const today = dayKey(now);
    const modelsFor = day => {
      const models = new Map();
      for (const e of led.events) {
        if (e.day !== day || e.source !== 'configured-pricing-estimate') continue;
        models.set(e.model, (models.get(e.model) || 0) + (e.cost || 0));
      }
      return [...models].map(([model, cost]) => ({ model: model + '（估算）', cost: rounded(cost) })).sort((a, b) => b.cost - a.cost);
    };
    const totalDay = day => day === today ? led.observed : Object.hasOwn(led.history, day) ? Number(led.history[day].total || 0) : null;
    const days7 = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const date = dayKey(d), total = totalDay(date);
      days7.push({ date, total, totalState: total === null ? 'unknown' : 'observed', models: modelsFor(date) });
    }
    const days = [...new Set([today, ...Object.keys(led.history), ...led.events.map(e => e.day)])].sort().reverse();
    const missingSummaryDays = days.filter(date => totalDay(date) === null);
    return { ok: true, today: { total: led.observed, models: modelsFor(today), since: led.firstObservation }, days7,
      total7: rounded(days7.reduce((n, d) => n + (d.total || 0), 0)),
      total7Complete: days7.every(d => d.total !== null),
      all: { days: days.map(date => ({ date, total: totalDay(date), totalState: totalDay(date) === null ? 'unknown' : 'observed', models: modelsFor(date) })),
        total: rounded(days.reduce((n, day) => n + (totalDay(day) || 0), 0)), totalComplete: missingSummaryDays.length === 0,
        missingSummaryDays, events: led.events.slice(-500).reverse(), storedEventCount: led.events.length, detailLimit: 500 },
      usageSource: 'observed-api-debits', note: '每日合计来自同密钥累计消耗或余额差值；停机或跨午夜的观测间隔归入再次观测日，不能拆成精确逐请求账单。日汇总长期保留，明细最多保留 8000 条、页面提供最近 500 条。旧版已删除的日汇总显示未知，不冒充零消费；模型金额为配置价格估算。' };
  }
  recordsAll(sourceInfo = [], now = Date.now()) {
    const sourceNames = new Map([['default', '当前 API']]);
    for (const item of sourceInfo) if (item?.id && item?.name) sourceNames.set(item.id, item.name);
    const today = dayKey(now), dayKeys = [];
    for (let i = 0; i < 7; i++) { const d = new Date(now); d.setDate(d.getDate() - i); dayKeys.push(dayKey(d)); }
    const daySet = new Set(dayKeys), overall = { today: emptySessionSummary(), total7: emptySessionSummary(), all: emptySessionSummary() };
    const bySource = new Map(), observed = new Map(), seenEvents = new Set();
    const sourceSummary = id => {
      if (!bySource.has(id)) bySource.set(id, { id, name: sourceNames.get(id) || '历史未标记 API', today: emptySessionSummary(), total7: emptySessionSummary(), all: emptySessionSummary() });
      return bySource.get(id);
    };
    const addEvent = (summary, event) => {
      const tokens = Number(event.tokens);
      summary.turns += 1;
      if (Number.isFinite(tokens) && tokens >= 0) summary.tokens += Math.floor(tokens);
      const cost = Number(event.cost ?? event.amount);
      if (Number.isFinite(cost) && !['unknown', 'pending'].includes(event.costState)) addAmount(summary, event.currency, cost);
    };
    const addObserved = (currency, period, value) => {
      if (!Number.isFinite(value)) return;
      const row = observed.get(currency) || { currency, today: 0, total7: 0, all: 0, knownDays: 0, totalDays: 0 };
      row[period] = rounded(row[period] + value); observed.set(currency, row);
    };
    let files = [];
    try { files = fs.readdirSync(path.join(this.dataDir, 'ledgers'), { withFileTypes: true }).filter(entry => entry.isFile() && /^[a-f0-9]{24}-[A-Z]{3}\.json$/.test(entry.name)).map(entry => entry.name); }
    catch {}
    for (const name of files) {
      const scope = name.slice(0, -5);
      let records, ledger;
      try { ledger = this.load(scope); records = this.records(scope, now); } catch { continue; }
      const currency = scope.slice(-3);
      const observedDays = new Map((records.all?.days || []).map(row => [row.date, row]));
      for (const [date, row] of observedDays) {
        if (row?.totalState !== 'observed' || !Number.isFinite(row.total)) continue;
        addObserved(currency, 'all', row.total);
        if (daySet.has(date)) addObserved(currency, 'total7', row.total);
        if (date === today) addObserved(currency, 'today', row.total);
      }
      for (const event of ledger.events || []) {
        if (event?.isSubagent || !event?.id || seenEvents.has(event.id)) continue;
        seenEvents.add(event.id);
        const id = typeof event.sourceId === 'string' && sourceNames.has(event.sourceId) ? event.sourceId :
          typeof event.sourceId === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(event.sourceId) ? event.sourceId : 'legacy-' + scope.slice(0, 8);
        const source = sourceSummary(id);
        if (event.sourceName && id !== 'default') source.name = String(event.sourceName).slice(0, 40);
        addEvent(source.all, event); addEvent(overall.all, event);
        if (daySet.has(event.day)) { addEvent(source.total7, event); addEvent(overall.total7, event); }
        if (event.day === today) { addEvent(source.today, event); addEvent(overall.today, event); }
      }
    }
    for (const item of sourceInfo) if (item?.id) sourceSummary(item.id);
    return { ok: true, today: publicSessionSummary(overall.today), total7: publicSessionSummary(overall.total7), all: publicSessionSummary(overall.all),
      sources: [...bySource.values()].map(row => ({ id: row.id, name: row.name, today: publicSessionSummary(row.today), total7: publicSessionSummary(row.total7), all: publicSessionSummary(row.all) })).sort((a, b) => a.name.localeCompare(b.name)),
      observed: [...observed.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      note: '总 Token 只统计主会话；子任务已计入所属主会话，避免重复累计。金额按币种分开显示：会话金额来自已知估算或期间扣费，观测金额来自各 API 余额表的累计变化。' };
  }
}

export function usageDefaults() {
  return {
    taskEnd: { on: false, sel: '' },
    approvalSound: { on: true, sel: 'preset:fx1:release' },
    outcomeNotice: { failed: true, cancelled: true },
    alert: { on: true, below: 5, msg: '余额已低于 {currency}{below}', lines: [
      { type: 'text', text: '老大～你的 API 余额', size: 5, bold: true },
      { type: 'text', text: '已经不足 {currency}{below} 啦', size: 6, bold: true, rgb: 'rouge' },
      { type: 'image', imgId: 'bimg_yue_money', size: 6, imgScale: 0.3 },
      { type: 'link', text: '打开当前 API 账单', url: '/provider-dashboard', size: 2, color: '#ffffff', bgRgb: 'indigo' },
    ], autoClose: false, ttlSec: 6 },
    budget: { on: true, amount: 10, msg: '今日已观测用量达到 {currency}{amount}', lines: [
      { type: 'text', text: '今天已观测用量超过', size: 6, bold: true },
      { type: 'text', text: '{currency}{amount}', size: 7, bold: true, rgb: 'rouge' },
    ], autoClose: false, ttlSec: 6 },
  };
}
