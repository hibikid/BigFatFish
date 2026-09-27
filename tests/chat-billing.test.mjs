import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatBilling } from '../runtime/chat/billing.mjs';
import { billingUsage, estimateDeepSeek, officialDeepSeek } from '../runtime/chat/deepseek-pricing.mjs';
import { createDispatcher } from '../runtime/dispatcher.mjs';
import { createChatClient } from '../desktop/ui/chat-client.js';
import { formatChatCost } from '../desktop/ui/chat-billing.js';

const baseUrl = 'https://api.deepseek.com', key = 'synthetic-chat-key';
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100 };
const balance = (amount = '110', currency = 'CNY') => Response.json({ balance_infos: [{ currency, total_balance: amount }] });
function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chat-billing-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, billing: new ChatBilling({ dataDir, fetchImpl: async () => balance(), ...options }) };
}
const turn = (id, timestamp, extra = {}) => ({ id, model: 'deepseek-flash', createdAt: new Date(timestamp).toISOString(), status: 'completed', usage, ...extra });

test('chat cost displays the midpoint with exactly two decimal places', () => {
  assert.equal(formatChatCost({ min: 0.0196414, max: 0.020298, currency: 'CNY' }), '¥0.02');
  assert.equal(formatChatCost({ min: 1, max: 2, currency: 'USD' }), '$1.50');
  assert.equal(formatChatCost({ min: 0, max: 0, currency: 'CNY' }), '¥0.00');
  assert.equal(formatChatCost({ min: 0.00001, max: 0.0001, currency: 'CNY' }), '¥0.00');
});

test('DeepSeek estimates distinguish cache, output, peak boundaries, holidays and missing cache data', () => {
  const estimate = at => estimateDeepSeek('deepseek-flash', usage, Date.parse(at));
  assert.equal(estimate('2026-09-21T01:00:00Z').amounts.CNY.max, 0.002408);
  assert.equal(estimate('2026-09-21T03:59:59Z').period, 'peak');
  assert.equal(estimate('2026-09-21T04:00:00Z').amounts.CNY.min, 0.001204);
  assert.equal(estimate('2026-09-21T06:00:00Z').period, 'peak');
  assert.equal(estimate('2026-09-21T10:00:00Z').period, 'off-peak');
  assert.equal(estimate('2026-09-25T01:00:00Z').period, 'off-peak');
  assert.equal(estimate('2026-10-01T01:00:00Z').period, 'off-peak');
  assert.equal(estimate('2026-10-10T01:00:00Z').period, 'off-peak', 'a working Saturday is still off-peak');
  assert.equal(estimate('2026-09-21T01:00:00Z').amounts.USD.max, 0.0003612);
  const missing = estimateDeepSeek('deepseek-flash', { prompt_tokens: 1000, completion_tokens: 100 }, Date.parse('2026-09-21T01:00:00Z'));
  assert.equal(missing.amounts.CNY.min, 0.00084); assert.equal(missing.amounts.CNY.max, 0.0028);
  assert.equal(estimate('2027-01-04T01:00:00Z').period, 'uncertain');
  assert.equal(estimateDeepSeek('unknown-model', usage, Date.now()), null);
  assert.equal(estimateDeepSeek('deepseek-flash', usage, Date.parse('2026-09-01')), null);
  assert.deepEqual(billingUsage({ ...usage, prompt_cache_hit_tokens: undefined, prompt_tokens_details: { cached_tokens: 200 } }), usage);
  assert.equal(billingUsage({ ...usage, prompt_cache_hit_tokens: 2000 }), null);
  assert.equal(billingUsage({ ...usage, completion_tokens: -1 }), null);
  assert.equal(officialDeepSeek('https://api.deepseek.com.evil.test'), false);
});

test('chat ledger retains rolling 30-day costs independently, deduplicates updates and isolates credentials', async t => {
  let now = Date.parse('2026-10-12T00:00:00Z');
  const { dataDir, billing } = fixture(t, { now: () => now });
  const current = turn('current_message', now);
  billing.record(current, { baseUrl, key }); billing.record(current, { baseUrl: baseUrl + '/v1', key });
  billing.record(turn('old_message', now - 31 * 86400000), { baseUrl, key });
  billing.record(turn('boundary_message', now - 30 * 86400000), { baseUrl, key });
  billing.record(turn('other_message', now), { baseUrl, key: 'synthetic-other-key' });
  const first = await billing.summary({ baseUrl, key });
  assert.equal(first.recorded, 2); assert.equal(first.min, 0.002408);
  assert.equal((await billing.summary({ baseUrl, key: 'synthetic-other-key' })).recorded, 1);
  const restarted = new ChatBilling({ dataDir, now: () => now, fetchImpl: async () => balance() });
  assert.deepEqual(await restarted.summary({ baseUrl, key }), first);
  assert.ok(!fs.readFileSync(path.join(dataDir, 'chat-billing.json'), 'utf8').includes(key));
  now += 1;
  assert.equal((await restarted.summary({ baseUrl, key })).recorded, 1);
});

test('stopped and interrupted generations without usage remain unknown rather than zero cost', async t => {
  const now = Date.parse('2026-09-27T00:00:00Z');
  const { dataDir, billing } = fixture(t, { now: () => now });
  billing.record(turn('streaming_message', now, { status: 'streaming', usage: undefined }), { baseUrl, key });
  assert.equal((await billing.summary({ baseUrl, key })).pending, 1);
  const restarted = new ChatBilling({ dataDir, now: () => now, fetchImpl: async () => balance() });
  const recovered = await restarted.summary({ baseUrl, key });
  assert.equal(recovered.pending, 0); assert.equal(recovered.unknown, 1); assert.equal(recovered.complete, false);
  billing.record(turn('streaming_message', now, { status: 'cancelled', usage: undefined }), { baseUrl, key });
  assert.equal((await billing.summary({ baseUrl, key })).unknown, 1);
  billing.record(turn('streaming_message', now, { status: 'failed' }), { baseUrl, key });
  assert.equal((await billing.summary({ baseUrl, key })).recorded, 1, 'observed usage still bills a failed reply');
});

test('balance queries use the official endpoint, share a cache and preserve a stale value on errors', async t => {
  let calls = 0, reject = false;
  const { billing } = fixture(t, { fetchImpl: async (url, request) => {
    calls++; assert.equal(url, baseUrl + '/user/balance'); assert.equal(request.redirect, 'error');
    assert.equal(new Headers(request.headers).get('authorization'), 'Bearer ' + key);
    await new Promise(resolve => setImmediate(resolve));
    return reject ? new Response(key, { status: 401 }) : balance('2.50', 'USD');
  } });
  const results = await Promise.all([billing.summary({ baseUrl, key }), billing.summary({ baseUrl, key, force: true })]);
  assert.equal(calls, 1); assert.equal(results[0].balance.amount, 2.5); assert.equal(results[0].currency, 'USD');
  await billing.summary({ baseUrl, key }); assert.equal(calls, 1);
  reject = true;
  const stale = await billing.summary({ baseUrl, key, force: true });
  assert.equal(stale.balanceStale, true); assert.equal(stale.balance.amount, 2.5); assert.ok(!JSON.stringify(stale).includes(key));
  await billing.summary({ baseUrl, key }); assert.equal(calls, 2, 'failed queries also respect the cooldown');
  await billing.summary({ baseUrl: 'https://other.example.test', key }); assert.equal(calls, 2);
});

test('billing persistence and query failures do not masquerade as successful empty ledgers', async t => {
  const { dataDir, billing } = fixture(t, { timeoutMs: 5, fetchImpl: async (_url, { signal }) =>
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) });
  fs.mkdirSync(billing.file);
  billing.record(turn('current_message', Date.now()), { baseUrl, key });
  const result = await billing.summary({ baseUrl, key });
  assert.equal(result.complete, false); assert.match(result.ledgerError, /保存失败/); assert.equal(result.balance, null);
  const damaged = new ChatBilling({ dataDir, fetchImpl: async () => balance() });
  assert.match((await damaged.summary({ baseUrl, key })).ledgerError, /不可读/);
});

test('chat dispatch records streamed usage, refreshes balance, and clearing history preserves billing', async t => {
  const { dataDir } = fixture(t);
  let requests = 0;
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false, chatFetchImpl: async (url, request) => {
    if (url.endsWith('/user/balance')) return balance((110 - requests * 0.001).toFixed(3));
    const payload = JSON.parse(request.body); assert.equal(payload.stream_options.include_usage, true); requests++;
    return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Hello' } }] }) + '\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(() => dispatcher.close());
  const client = createChatClient(async (url, request) => {
    const result = await dispatcher.dispatch(url, { method: request.method, body: request.body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  });
  await client.save({ baseUrl, model: 'deepseek-flash', apiKey: key, maxTokens: 1024 });
  assert.equal((await client.billing()).billing.balance.amount, 110);
  await client.send('current_message', 'Hi', () => {});
  const first = (await client.billing()).billing;
  assert.equal(first.recorded, 1); assert.ok(first.min > 0); assert.equal(first.balance.amount, 109.999);
  await client.clear(); assert.equal((await client.history()).turns.length, 0);
  assert.equal((await client.billing()).billing.min, first.min);
  assert.equal(fs.existsSync(path.join(dataDir, 'ledgers')), false, 'chat billing must not write the Codex ledger');
});

test('existing chat usage is recovered into a missing billing ledger once, and survives history clearing', async t => {
  const { dataDir } = fixture(t);
  const timestamp = Date.now() - 1000;
  const settingsFile = path.join(dataDir, 'chat-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ baseUrl, model: 'deepseek-flash', maxTokens: 1024, keyRef: 'fixture_chat_key' }));
  fs.utimesSync(settingsFile, new Date(timestamp - 1000), new Date(timestamp - 1000));
  fs.writeFileSync(path.join(dataDir, 'chat-history.json'), JSON.stringify({ version: 1, turns: [
    turn('legacy_message', timestamp, { user: 'Hi', text: 'Hello', usage: { prompt_tokens: 670, completion_tokens: 4907, total_tokens: 5577 } })
  ] }));
  const vault = { read: () => ({ value: key }), available: () => true };
  const makeDispatcher = () => createDispatcher({ dataDir, secretVault: vault, monitor: false, autoRefresh: false, chatFetchImpl: async () => balance() });
  const dispatcher = makeDispatcher(); t.after(() => dispatcher.close());
  const readBilling = async runtime => JSON.parse((await runtime.dispatch('/api/chat/billing')).body).billing;
  const recovered = await readBilling(dispatcher);
  assert.equal(recovered.recorded, 1, 'a completed legacy chat with known usage must not display zero recorded cost');
  assert.ok(recovered.min > 0); assert.ok(recovered.max >= recovered.min);
  assert.equal(fs.existsSync(path.join(dataDir, 'chat-billing.json')), true);
  assert.equal((await readBilling(dispatcher)).recorded, 1);
  await dispatcher.dispatch('/api/chat/history', { method: 'DELETE' });
  assert.equal((await readBilling(dispatcher)).min, recovered.min);
  await dispatcher.close();
  const restarted = makeDispatcher(); t.after(() => restarted.close());
  assert.equal((await readBilling(restarted)).recorded, 1);
});

test('legacy recovery respects the current credential save time and never reassigns another key ledger', async t => {
  const now = Date.parse('2026-09-27T02:13:25Z');
  const { billing } = fixture(t, { now: () => now });
  const existing = turn('other_key_message', now - 100);
  billing.record(existing, { baseUrl, key: 'synthetic-other-key' });
  const credentials = { baseUrl, key, settingsSavedAt: now - 1000 };
  const turns = [existing, turn('before_settings', now - 1001), turn('recover_message', now),
    turn('future_message', now + 1), turn('expired_message', now - 31 * 86400000)];
  billing.recoverHistory(turns, credentials);
  assert.equal((await billing.summary({ baseUrl, key })).recorded, 1);
  assert.equal((await billing.summary({ baseUrl, key: 'synthetic-other-key' })).recorded, 1);
  assert.deepEqual(billing.entries.map(row => row.id).sort(), ['other_key_message', 'recover_message']);
  billing.recoverHistory([turn('no_config_timestamp', now)], { baseUrl, key });
  billing.recoverHistory([turn('third_party_message', now)], { ...credentials, baseUrl: 'https://other.example.test' });
  assert.equal(billing.entries.length, 2);
});

test('clearing legacy chat before opening billing still preserves its known usage', async t => {
  const { dataDir } = fixture(t);
  const timestamp = Date.now() - 1000, settingsFile = path.join(dataDir, 'chat-settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ baseUrl, model: 'deepseek-flash', keyRef: 'fixture_chat_key' }));
  fs.utimesSync(settingsFile, new Date(timestamp - 1000), new Date(timestamp - 1000));
  fs.writeFileSync(path.join(dataDir, 'chat-history.json'), JSON.stringify({ turns: [turn('legacy_message', timestamp)] }));
  const dispatcher = createDispatcher({ dataDir, secretVault: { read: () => ({ value: key }) }, monitor: false, autoRefresh: false, chatFetchImpl: async () => balance() });
  t.after(() => dispatcher.close());
  await dispatcher.dispatch('/api/chat/history', { method: 'DELETE' });
  const result = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
  assert.equal(result.recorded, 1); assert.ok(result.min > 0);
});

test('creating, switching and deleting conversations never resets their independent billing', async t => {
  const { dataDir } = fixture(t);
  const dispatcher = createDispatcher({ dataDir, monitor: false, autoRefresh: false, chatFetchImpl: async url => {
    if (url.endsWith('/user/balance')) return balance();
    return new Response('data: {"choices":[{"delta":{"content":"Reply"}}]}\n\n' +
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  } });
  t.after(() => dispatcher.close());
  const client = createChatClient(async (url, request) => {
    const result = await dispatcher.dispatch(url, { method: request.method, body: request.body });
    return new Response(result.body, { status: result.status, headers: result.headers });
  });
  await client.save({ baseUrl, model: 'deepseek-flash', apiKey: key, maxTokens: 1024 });
  const first = (await client.history()).conversationId;
  await client.send('first_message', 'First topic', () => {}, first);
  const second = (await client.createConversation()).conversationId;
  await client.send('second_message', 'Second topic', () => {}, second);
  const before = (await client.billing()).billing;
  assert.equal(before.recorded, 2);
  await client.selectConversation(first); assert.equal((await client.history()).turns[0].user, 'First topic');
  await client.deleteConversation(first); assert.equal((await client.history()).conversationId, second);
  await client.deleteConversation(second); assert.equal((await client.history()).turns.length, 0);
  const after = (await client.billing()).billing;
  assert.equal(after.recorded, 2); assert.equal(after.min, before.min); assert.equal(after.max, before.max);
});
