import path from 'node:path';
import { createHash } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';
import { BalanceProvider } from '../providers.mjs';
import { billingUsage, estimateDeepSeek, officialDeepSeek } from './deepseek-pricing.mjs';

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const accountId = (baseUrl, key) => createHash('sha256').update(new URL(baseUrl).origin + '\0' + key).digest('hex');

export class ChatBilling {
  constructor({ dataDir, fetchImpl = fetch, now = Date.now, timeoutMs = 12000, balanceTtlMs = 60000 }) {
    this.file = path.join(dataDir, 'chat-billing.json'); this.now = now; this.balanceTtlMs = balanceTtlMs;
    this.provider = new BalanceProvider({ fetchImpl, timeoutMs }); this.balances = new Map();
    this.error = ''; this.readFailed = false;
    try {
      this.entries = readJson(this.file, { entries: [] }).entries;
      if (!Array.isArray(this.entries) || this.entries.some(row => !row || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/.test(row.scope) || !Number.isFinite(row.timestamp))) throw new Error('invalid ledger');
      this.entries = this.entries.map(row => row.status === 'streaming' ? { ...row, status: 'interrupted' } : row);
    } catch { this.entries = []; this.readFailed = true; this.error = '本地会话计费记录不可读'; }
  }
  recoverHistory(turns, { baseUrl, key, settingsSavedAt }) {
    if (!officialDeepSeek(baseUrl) || !key || !Number.isFinite(settingsSavedAt)) return;
    const now = this.now();
    for (const turn of turns.flatMap(turn => Array.isArray(turn.requests) && turn.requests.length ? turn.requests : [turn])) {
      const timestamp = Date.parse(turn.createdAt);
      // Legacy history has no account identity. Only recover calls made after
      // the current credentials were saved, and never reassign an existing row.
      if (typeof turn.id !== 'string' || !Number.isFinite(timestamp) || timestamp < settingsSavedAt ||
          timestamp < now - WINDOW_MS || timestamp > now || this.entries.some(row => row.id === turn.id)) continue;
      this.record(turn, { baseUrl, key });
    }
  }
  record(turn, { baseUrl, key }) {
    if (!officialDeepSeek(baseUrl) || !key) return;
    const scope = accountId(baseUrl, key), timestamp = Date.parse(turn.createdAt);
    if (!Number.isFinite(timestamp)) return;
    const usage = billingUsage(turn.usage);
    const entry = { id: turn.id, scope, timestamp, model: turn.model, status: turn.status,
      usage, estimate: estimateDeepSeek(turn.model, usage, timestamp) };
    const index = this.entries.findIndex(row => row.id === entry.id && row.scope === scope);
    if (index < 0) this.entries.push(entry); else this.entries[index] = entry;
    this.entries = this.entries.filter(row => row.timestamp >= this.now() - WINDOW_MS);
    if (turn.status !== 'streaming') {
      const cached = this.balances.get(scope);
      if (cached) { cached.expiresAt = 0; cached.version++; }
    }
    if (this.readFailed) return;
    try { writeJson(this.file, { version: 1, entries: this.entries }); this.error = ''; }
    catch { this.error = '本地会话计费记录保存失败'; }
  }
  async balance(scope, credentials, force) {
    let cache = this.balances.get(scope);
    if (!cache) {
      cache = { value: null, error: '', expiresAt: 0, job: null, version: 0, queriedVersion: 0 }; this.balances.set(scope, cache);
      if (this.balances.size > 16) this.balances.delete(this.balances.keys().next().value);
    }
    if (cache.job) {
      await cache.job;
      return cache.version === cache.queriedVersion ? cache : this.balance(scope, credentials, false);
    } else if (!force && cache.expiresAt > this.now()) return cache;
    const version = cache.version;
    cache.job = (async () => {
      try {
        const result = await this.provider.deepseek({ baseUrl: 'https://api.deepseek.com', key: credentials.key, setting: { currency: 'CNY' } });
        if (!['CNY', 'USD'].includes(result.currency)) throw new Error('invalid currency');
        cache.value = { amount: result.totalBalance, currency: result.currency, updatedAt: new Date(this.now()).toISOString() };
        cache.error = '';
      } catch { cache.error = '余额查询失败，请稍后刷新'; }
      cache.queriedVersion = version;
      cache.expiresAt = cache.version === version ? this.now() + this.balanceTtlMs : 0;
    })().finally(() => { cache.job = null; });
    await cache.job;
    return cache.version === cache.queriedVersion ? cache : this.balance(scope, credentials, false);
  }
  async summary({ baseUrl, key, force = false }) {
    const supported = officialDeepSeek(baseUrl);
    const empty = { supported, configured: !!key, days: 30, currency: 'CNY', min: 0, max: 0, recorded: 0, pending: 0, unknown: 0, complete: !this.error,
      ledgerError: this.error, balance: null, balanceStale: false, balanceError: '' };
    if (!supported || !key) return { ...empty, complete: false, balanceError: supported ? '尚未配置会话密钥' : '此会话网站暂不支持余额查询' };
    const scope = accountId(baseUrl, key), cache = await this.balance(scope, { key }, force);
    const currency = cache.value?.currency || 'CNY', now = this.now();
    const rows = this.entries.filter(row => row.scope === scope && row.timestamp >= now - WINDOW_MS && row.timestamp <= now);
    let min = 0, max = 0, recorded = 0, pending = 0, unknown = 0;
    for (const row of rows) {
      const amount = row.estimate?.amounts?.[currency];
      if (row.status === 'streaming') pending++;
      else if (amount && Number.isFinite(amount.min) && Number.isFinite(amount.max) && amount.min >= 0 && amount.max >= amount.min) {
        min += amount.min; max += amount.max; recorded++;
      } else unknown++;
    }
    return { supported, configured: true, days: 30, currency, min, max, recorded, pending, unknown, complete: !this.error && !pending && !unknown,
      ledgerError: this.error, balance: cache.value, balanceStale: !!cache.error, balanceError: cache.error };
  }
}
