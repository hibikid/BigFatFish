import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { UsageLedger } from '../runtime/ledger.mjs';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('usage-presentation.js');
const scope = 'abcdefabcdefabcdefabcdef-USD', meterKey = 'a'.repeat(64);
// The presentation module runs in its own realm; compare plain copies.
const meters = state => JSON.parse(JSON.stringify(presentation.usageMeters(state)));

test('the full balance is the highest balance since the last top-up', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-full-balance-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const ledger = new UsageLedger(dataDir);
  const full = balance => ledger.observe(scope, { totalBalance: balance, meterKey }).fullBalance;
  assert.equal(full(100), 100, 'the first balance seen is full');
  assert.equal(full(60), 100);
  assert.equal(full(60.5), 100, 'a small rise such as a refund is not a top-up');
  assert.equal(full(40), 100);
  assert.equal(full(90), 90, 'a top-up starts a new full balance even below the old one');
  assert.equal(full(120), 120, 'a balance above the full one becomes full');
  assert.equal(ledger.observe(scope, { totalBalance: 80, meterKey: 'f'.repeat(64) }).fullBalance, 80, 'a different meter starts over');
  assert.equal(ledger.records(scope).fullBalance, 80);
});

test('the meter shows remaining 5h and 7d quota for a subscription', () => {
  const subscription = { provider: 'Codex', fiveHour: { remainingPercent: 62.4 }, sevenDay: { remainingPercent: 18 } };
  assert.deepEqual(meters({ subscription, status: 'ok' }),
    [{ label: '5h', percent: 62.4, level: 'ok' }, { label: '7d', percent: 18, level: 'low' }]);
  const claude = { provider: 'Claude', fiveHour: { remainingPercent: 140 }, sevenDay: null };
  assert.deepEqual(meters({ subscription: claude, status: 'ok' }), [{ label: '5h', percent: 100, level: 'ok' }],
    'only known windows are shown, within 0–100');
});

test('the meter shows what is left of an API key quota, or the balance against the full balance', () => {
  const quota = presentation.balance({ ok: true, totalBalance: 7.5, currency: 'USD', primaryRateLimit: { used: 75, limit: 100 }, balanceFull: 9 }).state;
  assert.deepEqual(meters(quota), [{ label: '余额', percent: 25, level: 'warn' }], 'a key quota wins over the full balance');
  const balance = presentation.balance({ ok: true, totalBalance: 45, currency: 'CNY', balanceFull: 50 }).state;
  assert.deepEqual(meters(balance), [{ label: '余额', percent: 90, level: 'ok' }]);
  for (const data of [{ ok: true, unlimited: true, totalBalance: null, balanceFull: null }, { ok: true, totalBalance: 45 }, { ok: false, error: '失败' }, null]) {
    assert.deepEqual(meters(presentation.balance(data).state), [], JSON.stringify(data));
  }
  assert.deepEqual(meters({ status: 'loading', balance: null }), []);
});
