import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const presentation = browserModule('usage-presentation.js');
const turns = browserModule('turn-notice.js');
const clientModule = browserModule('usage-client.js');
const quota = () => ({ available: true, fiveHour: { remainingPercent: 75 }, sevenDay: { remainingPercent: 40 } });
const create = options => clientModule.create({ acceptsSubscription: presentation.hasSubscription, shouldNotify: turns.shouldNotify, ...options });
const memory = values => ({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) });

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
  const values = new Map(), storage = memory(values);
  let record = { ok: true, seq: 1, id: 'historical', turn: 'old', notificationAt: 99, amount: 1 };
  let reads = 0;
  const options = { now: () => 100, storage, fetchImpl: async url => {
    if (url !== '/dsh-whale/last-turn.json') return Response.json({ available: false });
    reads++; return Response.json(record);
  } };
  const client = create(options), shown = [];
  const handlers = { codex: value => shown.push(value.id) };
  await Promise.all([client.pollCompletions(handlers), client.pollCompletions(handlers)]);
  assert.equal(reads, 1);
  assert.deepEqual(shown, []);
  record = { ...record, seq: 2, id: 'new', turn: 'new', notificationAt: 101 };
  await Promise.all([client.pollCompletions(handlers), client.pollCompletions(handlers)]);
  assert.deepEqual(shown, ['new']);
  assert.equal(values.get('dshw-last-seq'), '2');
  assert.equal(values.get('dshw-last-turn-id'), 'new');
  await client.pollCompletions(handlers);
  await create(options).pollCompletions(handlers);
  assert.deepEqual(shown, ['new']);
});

test('Claude completion polls once, ignores old events and never replays after a restart', async () => {
  const values = new Map(), storage = memory(values);
  let record = { ok: true, available: true, provider: 'Claude', id: 'old', completedAt: 99 };
  let reads = 0;
  const options = { now: () => 100, storage, fetchImpl: async url => {
    if (url !== '/api/claude/last-turn') return Response.json(url.includes('last-turn') ? { ok: false } : { available: false });
    reads++; return Response.json(record);
  } };
  const client = create(options), shown = [];
  const handlers = { claude: value => shown.push(value.id) };
  await client.pollCompletions(handlers);
  record = { ...record, id: 'new', completedAt: 101 };
  await Promise.all([client.pollCompletions(handlers), client.pollCompletions(handlers)]);
  assert.equal(reads, 2);
  assert.deepEqual(shown, ['new']);
  assert.equal(values.get('dshw-last-claude-turn-id'), 'new');
  await create(options).pollCompletions(handlers);
  assert.deepEqual(shown, ['new']);
});

test('the source with the latest activity is shown, and a manual choice holds until a later completion', async () => {
  const values = new Map([['dshw-display-source', 'claude']]), storage = memory(values);
  let clock = 1000, codex = null, claude = null;
  const changes = [];
  const options = { now: () => clock, storage, onSource: source => changes.push(source), fetchImpl: async url => {
    if (url === '/dsh-whale/last-turn.json') return Response.json(codex || { ok: false });
    if (url === '/api/claude/last-turn') return Response.json(claude || { ok: true, available: false });
    return Response.json({ available: false });
  } };
  const client = create(options);
  assert.equal(client.source(), 'claude', 'the last shown source survives a reload');
  codex = { ok: true, seq: 1, id: 'c1', turn: 't', notificationAt: 2000 };
  claude = { ok: true, available: true, id: 'a1', completedAt: 1500 };
  await client.pollCompletions();
  assert.equal(client.source(), 'codex', 'the newer Codex completion wins over the older Claude one');
  assert.deepEqual(changes, ['codex']);
  assert.equal(values.get('dshw-display-source'), 'codex');

  clock = 3000;
  client.select('claude');
  assert.equal(client.source(), 'claude');
  assert.equal(values.get('dshw-display-source-manual-at'), '3000');
  codex = { ...codex, seq: 2, id: 'c2', notificationAt: 2500 };
  await client.pollCompletions();
  assert.equal(client.source(), 'claude', 'an activity older than the manual choice does not switch back');
  const reloaded = create(options);
  await reloaded.pollCompletions();
  assert.equal(reloaded.source(), 'claude', 'the manual choice survives a reload');

  codex = { ...codex, seq: 3, id: 'c3', notificationAt: 3500 };
  await client.pollCompletions();
  assert.equal(client.source(), 'codex');
  assert.equal(values.has('dshw-display-source-manual-at'), false, 'a later completion ends the manual choice');
  client.select('codex'); client.select('other');
  assert.deepEqual(changes, ['codex', 'claude', 'codex'], 'only real changes are announced');
});

test('startup picks Claude from its quota snapshot when nothing newer happened', async () => {
  const values = new Map(), snapshotReads = [];
  const client = create({ storage: memory(values), fetchImpl: async url => {
    if (url === '/api/claude/subscription') { snapshotReads.push(url); return Response.json({ ...quota(), provider: 'Claude', observedAt: new Date(5000).toISOString() }); }
    return Response.json(url === '/dsh-whale/last-turn.json' ? { ok: true, seq: 1, id: 'c', turn: 't', notificationAt: 4000 } : { ok: false });
  } });
  await client.pollCompletions();
  await client.pollCompletions();
  assert.equal(client.source(), 'claude');
  assert.equal(snapshotReads.length, 1, 'the snapshot only chooses the source at startup');
});

test('Claude shows its own quota or waits for it, and never falls back to the API balance', async () => {
  let claude = { ...quota(), provider: 'Claude' };
  const requests = [];
  const client = create({ storage: memory(new Map([['dshw-display-source', 'claude']])), fetchImpl: async url => {
    requests.push(url); return Response.json(url === '/api/claude/subscription' ? claude : { ok: true, totalBalance: 1 });
  } });
  const shown = await client.overview({ manual: true });
  assert.equal(shown.source, 'claude'); assert.equal(shown.kind, 'subscription'); assert.equal(shown.data.fiveHour.remainingPercent, 75);
  assert.equal((await client.pollQuota()).kind, 'subscription');
  claude = { ok: true, available: false };
  assert.equal((await client.overview()).kind, 'missing');
  assert.equal((await client.pollQuota()).kind, 'missing');
  assert.deepEqual([...new Set(requests)], ['/api/claude/subscription']);
  client.select('codex');
  await client.pollQuota();
  assert.equal(requests.at(-1), '/api/subscription-rate-limits');
});

test('a read for a source that is no longer shown is dropped, including its fallback and failure', async () => {
  const tick = () => new Promise(resolve => setImmediate(resolve));
  for (const [switchAfter, settle] of [[0, job => job.resolve(Response.json({ available: false }))], [0, job => job.reject(new Error('offline'))],
    [1, job => job.reject(new Error('offline'))]]) {
    const pending = [];
    const client = create({ fetchImpl: url => new Promise((resolve, reject) => pending.push({ url, resolve, reject })) });
    let fallbacks = 0;
    const refresh = client.overview({ onBalanceFallback: () => fallbacks++ });
    const poll = client.pollQuota();
    await tick();
    if (switchAfter) { pending[0].resolve(Response.json({ available: false })); await tick(); }
    client.select('claude');
    settle(pending[switchAfter ? 2 : 0]);
    pending[1].resolve(Response.json(quota()));
    assert.equal(await refresh, null);
    assert.equal(await poll, null);
    assert.equal(fallbacks, switchAfter, 'the old source must not clear the new display');
    assert.equal(pending.length, 2 + switchAfter, 'no balance request after the source changed');
  }
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
