import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('usage-presentation.js');
const turns = browserModule('turn-notice.js');
const clientModule = browserModule('usage-client.js');
const quota = () => ({ available: true, fiveHour: { remainingPercent: 75 }, sevenDay: { remainingPercent: 40 } });
const create = options => clientModule.create({ acceptsSubscription: presentation.hasSubscription, shouldNotify: turns.shouldNotify, ...options });

test('overview prefers subscription and manual API fallback uses the force-refresh route', async () => {
  let subscription = quota();
  const requests = [];
  const client = create({ fetchImpl: async (url, options) => {
    requests.push([url, options.cache]);
    return Response.json(url.includes('subscription') ? subscription : { ok: true, totalBalance: 12.3456 });
  } });
  assert.equal((await client.overview()).kind, 'subscription');
  assert.equal(requests.length, 1);
  subscription = { ok: true, available: false };
  const result = await client.overview({ manual: true });
  assert.equal(result.kind, 'balance');
  assert.equal(result.data.totalBalance, 12.3456);
  assert.deepEqual(requests[2], ['/dsh-whale/balance.json?refresh=1', 'no-store']);
});

test('a temporary quota read failure preserves an existing snapshot, while an unavailable one falls back', async () => {
  const previous = quota();
  let fail = true, balances = 0;
  const client = create({ fetchImpl: async url => {
    if (url.includes('subscription')) {
      if (fail) throw new Error('temporary local failure');
      return Response.json({ available: false });
    }
    balances++;
    return Response.json({ ok: true, totalBalance: 10 });
  } });
  assert.equal((await client.overview({ getSubscription: () => previous })).kind, 'retained-subscription');
  assert.equal(balances, 0);
  fail = false;
  assert.equal((await client.overview({ getSubscription: () => previous })).kind, 'balance');
  assert.equal(balances, 1);
});

test('the deadline aborts a stalled local request and a later refresh can still succeed', async () => {
  let stall = true;
  const client = create({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    if (!stall) return Response.json(quota());
    if (signal.aborted) throw new Error('aborted');
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await assert.rejects(client.overview(), /aborted/);
  stall = false;
  assert.equal((await client.overview()).kind, 'subscription');
});

test('concurrent task polls share one read, persist the cursor, and never replay a completion after restart', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  let record = { ok: true, seq: 1, id: 'historical', turn: 'old', notificationAt: 99, amount: 1 };
  let reads = 0;
  const options = { now: () => 100, storage, fetchImpl: async () => { reads++; return Response.json(record); } };
  const client = create(options);
  const [a, b] = await Promise.all([client.pollTurn(), client.pollTurn()]);
  assert.equal(reads, 1);
  assert.equal(a.fresh, false);
  assert.equal(b.fresh, false);
  record = { ...record, seq: 2, id: 'new', turn: 'new', notificationAt: 101 };
  const completions = await Promise.all([client.pollTurn(), client.pollTurn()]);
  assert.equal(completions.filter(result => result.fresh).length, 1);
  assert.equal(values.get('dshw-last-seq'), '2');
  assert.equal(values.get('dshw-last-turn-id'), 'new');
  assert.equal((await client.pollTurn()).fresh, false);
  assert.equal((await create(options).pollTurn()).fresh, false);
});

test('API fallback transitions before the request and cannot erase a newer polled subscription', async () => {
  for (const fail of [false, true]) {
    let current = quota(), finish;
    const fresh = quota();
    const client = create({ fetchImpl: async url => {
      if (url.includes('subscription')) return Response.json({ available: false });
      assert.equal(current, null, 'old quota must be cleared before the balance request');
      return new Promise((resolve, reject) => { finish = () => fail ? reject(new Error('API unavailable')) : resolve(Response.json({ ok: true })); });
    } });
    const job = client.overview({ getSubscription: () => current, onBalanceFallback: () => { current = null; } });
    await new Promise(resolve => setImmediate(resolve));
    current = fresh;
    finish();
    if (fail) await assert.rejects(job, /API unavailable/);
    else assert.equal((await job).kind, 'balance');
    assert.equal(current, fresh);
  }
});

test('a failed quota read retains a snapshot received by another poll during the request', async () => {
  let current = null, fail;
  const fresh = quota();
  const client = create({ fetchImpl: async url => {
    assert.ok(url.includes('subscription'), 'a new subscription snapshot should prevent API fallback');
    return new Promise((_resolve, reject) => { fail = () => reject(new Error('temporary local failure')); });
  } });
  const job = client.overview({ getSubscription: () => current, onBalanceFallback: () => assert.fail('must retain current quota') });
  current = fresh;
  fail();
  const result = await job;
  assert.equal(result.kind, 'retained-subscription');
  assert.equal(result.data, fresh);
});

test('records and sound settings use the existing routes and report a rejected save', async () => {
  const calls = [];
  let saved = { approvalSound: { on: false, sel: 'frag:custom' } }, reject = false;
  const client = create({ fetchImpl: async (url, options) => {
    calls.push([url, options]);
    if (options.method === 'PUT') {
      if (reject) return Response.json({ ok: false, error: 'save failed' });
      saved = JSON.parse(options.body);
    }
    return Response.json(url.includes('records') ? { ok: true, today: { total: 0.5 } } : { ok: true, settings: saved });
  } });
  assert.equal((await client.records()).today.total, 0.5);
  assert.equal((await client.settings()).settings.approvalSound.sel, 'frag:custom');
  const patch = { approvalSound: { on: true, sel: 'preset:fx1:release' } };
  assert.equal((await client.saveSettings(patch)).settings.approvalSound.on, true);
  assert.equal(calls[2][0], '/dsh-whale/usage-settings.json');
  assert.equal(calls[2][1].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[2][1].body), patch);
  reject = true;
  await assert.rejects(client.saveSettings(patch), /save failed/);
});
