import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('usage-presentation.js');

test('subscription windows become quota lines; a reset window says so and one valid window is enough', () => {
  const quota = { planType: 'plus', fiveHour: { remainingPercent: 74.6, resetsAt: '2026-09-26T12:00:00Z' },
    sevenDay: { remainingPercent: 40, resetsAt: '2026-10-01T12:00:00Z' } };
  assert.equal(presentation.quotaLines(quota).fiveHour, '5小时剩余75%');
  assert.equal(presentation.quotaLines(quota).sevenDay, '7天剩余40%');
  assert.equal(presentation.quotaLines(quota).reset, '5小时重置' + new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date('2026-09-26T12:00:00Z')));
  const reset = { ...quota, fiveHour: { reset: true } };
  assert.equal(presentation.hasSubscription(reset), true);
  assert.equal(presentation.quotaLines(reset).fiveHour, '5小时已重置');
  assert.match(presentation.quotaLines(reset).reset, /^7天重置 /, 'with the 5h window reset the next reset shown is the 7d one');
  assert.equal(presentation.hasSubscription({ fiveHour: { reset: true }, sevenDay: null }), false);
  assert.equal(presentation.hasSubscription({ ...quota, available: false }), false);
});

test('Claude can show one known subscription window while leaving the other unknown', () => {
  const quota = { provider: 'Claude', fiveHour: { remainingPercent: 76.5, resetsAt: '2026-09-29T06:00:00Z' }, sevenDay: null };
  assert.equal(presentation.hasSubscription(quota), true);
  assert.equal(presentation.quotaLines(quota).fiveHour, '5小时剩余77%');
  assert.equal(presentation.quotaLines(quota).sevenDay, '7天剩余--');
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
  assert.equal(presentation.balanceRow(snapshot, 'today', options), '今日 USD:0.000012');
  currency = 'CNY';
  assert.equal(presentation.balanceRow(snapshot, 'balance', options), 'CNY:12.3456');
  assert.equal(presentation.balanceRow(snapshot, 'today', options), '今日 CNY:0.000012');
  assert.equal(snapshot.balance, 12.3456);
  const subscription = { available: true, fiveHour: { remainingPercent: 75 }, sevenDay: { remainingPercent: 40 } };
  const quotaOptions = { ...options, firstSubscriptionQuota: true };
  assert.equal(presentation.balanceRow({ subscription }, 'balance', quotaOptions), '5小时剩余75%\n7天剩余40%');
  assert.equal(presentation.balanceRow({ subscription }, 'today', quotaOptions), '5小时重置--:--');
  assert.equal(presentation.balanceRow({ balance: null }, 'balance', options), '…');
  assert.equal(presentation.balanceRow({ balance: null }, 'today', options), '今日 --');
});
