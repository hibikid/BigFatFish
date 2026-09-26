import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('usage-presentation.js');

test('API usage maps to display values without losing small amounts or stale status', () => {
  const view = presentation.balance({ ok: true, totalBalance: 12.3456, todayUsage: 0.000012, currency: 'USD',
    providerName: 'Work', balanceLabel: 'API balance', stale: true, todayUsageSource: 'source-api',
    primaryRateLimit: { used: 25, limit: 100 } });
  assert.equal(view.state.balance, 12.3456);
  assert.equal(view.state.todayUsage, 0.000012);
  assert.equal(view.state.todayUsageSource, 'source-api');
  assert.equal(view.state.balanceText, '25/100');
  assert.equal(view.state.status, 'ok');
  assert.equal(view.title, 'Work · API balance（上次成功数据）');
  assert.equal(view.alt, '当前 API 余额');
});

test('subscription snapshots become quota lines rather than money and an unavailable snapshot is rejected', () => {
  const quota = { available: true, planType: 'plus', fiveHour: { remainingPercent: 74.6, resetsAt: '2026-09-26T12:00:00Z' },
    sevenDay: { remainingPercent: 40, resetsAt: '2026-10-01T12:00:00Z' } };
  const view = presentation.subscription(quota);
  assert.equal(view.state.subscription, quota);
  assert.equal(view.title, 'Codex 订阅额度 · PLUS（来自本机会话额度快照）');
  assert.equal(presentation.quotaLines(quota).fiveHour, '5小时剩余75%');
  assert.equal(presentation.quotaLines(quota).sevenDay, '7天剩余40%');
  assert.equal(presentation.quotaLines(quota).reset, '5小时重置' + new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date('2026-09-26T12:00:00Z')));
  assert.equal(presentation.subscription({ ...quota, available: false }), null);
  assert.equal(presentation.subscription({ fiveHour: quota.fiveHour }), null);
  assert.notEqual(presentation.subscriptionFingerprint(quota), presentation.subscriptionFingerprint({
    ...quota, fiveHour: { ...quota.fiveHour, remainingPercent: 70 },
  }));
});

test('display snapshots keep loading, pending and unknown amounts distinct from zero', () => {
  const money = value => '$' + value.toFixed(2);
  assert.equal(presentation.balanceBubble({ status: 'loading', balance: null }, { formatMoney: money }).amount, '…');
  assert.equal(presentation.balanceBubble({ status: 'error', message: 'Offline', balance: null }, { formatMoney: money }).hint, 'Offline');
  assert.equal(presentation.balanceBubble({ status: 'ok', balance: 0, todayUsage: 0 }, { formatMoney: money }).amount, '$0.00');
  assert.equal(presentation.taskBubble({ amount: null, costState: 'pending', tokens: 120 }, money).amount, '待记账');
  assert.equal(presentation.taskBubble({ amount: null, costState: 'unknown', tokens: 120 }, money).hint, '120 tokens · 以服务商账单为准');
  const estimated = presentation.taskBubble({ amount: 0, costState: 'estimated', tokens: 120 }, money);
  assert.equal(estimated.amount, '$0.00');
  assert.equal(estimated.hint, '120 tokens · 配置价格估算');
});

test('custom balance rows share display wording and can reformat the captured amounts', () => {
  const snapshot = { balance: 12.3456, currency: 'USD', todayUsage: 0.000012 };
  let currency = 'USD';
  const options = { formatMoney: amount => currency + ':' + amount };
  assert.equal(presentation.balanceRow(snapshot, 'balance', options), 'USD:12.3456');
  assert.equal(presentation.balanceRow(snapshot, 'today', options), '今日已观测 USD:0.000012');
  currency = 'CNY';
  assert.equal(presentation.balanceRow(snapshot, 'balance', options), 'CNY:12.3456');
  assert.equal(presentation.balanceRow(snapshot, 'today', options), '今日已观测 CNY:0.000012');
  assert.equal(snapshot.balance, 12.3456);
  const subscription = { available: true, fiveHour: { remainingPercent: 75 }, sevenDay: { remainingPercent: 40 } };
  const quotaOptions = { ...options, firstSubscriptionQuota: true };
  assert.equal(presentation.balanceRow({ subscription }, 'balance', quotaOptions), '5小时剩余75%\n7天剩余40%');
  assert.equal(presentation.balanceRow({ subscription }, 'today', quotaOptions), '5小时重置--:--');
  assert.equal(presentation.balanceRow({ balance: null }, 'balance', options), '…');
  assert.equal(presentation.balanceRow({ balance: null }, 'today', options), '今日已观测 --');
});
