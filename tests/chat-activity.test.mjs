import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatActivity } from '../runtime/chat/activity.mjs';
import { ChatService } from '../runtime/chat/service.mjs';
import { readEvents } from '../lib/event-stream.js';

const tool = (name, args = {}) => ({ name, arguments: JSON.stringify(args) });
const sse = events => new Response(events.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100 };
async function consume(response) { const result = []; for await (const event of readEvents(response.body)) result.push(JSON.parse(event.data)); return result; }

test('preauthorized streamed tool calls execute without a permission prompt, denied calls return only to the model, and each request is billed', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-tools-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const requests = [];
  const service = new ChatService({ dataDir, activityOptions: { startTimer: false }, fetchImpl: async (url, options) => {
    if (url.endsWith('/user/balance')) return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '10' }] });
    const payload = JSON.parse(options.body); requests.push(payload);
    if (requests.length === 1 || requests.length === 3) {
      const allowed = requests.length === 1;
      const name = allowed ? 'pomodoro_set' : 'delete_files';
      return sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: allowed ? '{"focusMinutes":25,' : '{}' } }] } }] },
        ...(allowed ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"breakMinutes":5,"cycles":2}' } }] } }] }] : []),
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage }
      ]);
    }
    return sse([{ choices: [{ index: 0, delta: { content: requests.length === 2 ? '我安排了两轮。' : '这个操作做不了。' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
  } });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-key', persona: '你是大肥鱼', maxTokens: 256 });
  const first = (await consume(service.start({ id: 'first_chat', text: '帮我安排番茄钟' }))).at(-1).turn;
  assert.equal(first.status, 'completed'); assert.equal(first.text, '我安排了两轮。');
  assert.equal(first.usage.total_tokens, 2200);
  assert.equal(service.activity.snapshot().pomodoro.focusMinutes, 25);
  assert.equal(service.activity.snapshot().pomodoro.cycles, 2);
  assert.equal(requests[0].tools[0].function.name, 'pomodoro_set');
  assert.equal(requests[1].messages.at(-1).role, 'tool');
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).ok, true);
  const second = (await consume(service.start({ id: 'second_chat', text: '做一个未授权操作' }))).at(-1).turn;
  assert.equal(second.status, 'completed');
  assert.equal(JSON.parse(requests[3].messages.at(-1).content).ok, false);
  assert.equal(service.activity.snapshot().pomodoro.focusMinutes, 25);
  assert.equal((await service.billing.summary({ baseUrl: 'https://api.deepseek.com', key: 'synthetic-key' })).recorded, 4);
  assert.ok(!JSON.stringify(service.history()).includes('delete_files'));
});

test('Pomodoro clock persists phases, waits at transitions, and rejects out-of-policy operations', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-timer-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.now(); const announced = [];
  const activity = new ChatActivity({ dataDir, now: () => now, startTimer: false,
    onReminder: async state => '角色提醒：' + state.phase, onNotice: item => announced.push(item.kind) });
  assert.equal(activity.tool(tool('pomodoro_set', { focusMinutes: 0, breakMinutes: 5, cycles: 2 }), 'chat_1').ok, false);
  assert.equal(activity.tool(tool('shell', { command: 'ls' }), 'chat_1').ok, false);
  activity.userActivity();
  const stateFile = path.join(dataDir, 'chat-activity-state.json');
  fs.renameSync(stateFile, stateFile + '.saved'); fs.mkdirSync(stateFile);
  assert.throws(() => activity.tool(tool('pomodoro_set', { focusMinutes: 1, breakMinutes: 2, cycles: 2 }), 'chat_1'));
  assert.equal(activity.snapshot().pomodoro.phase, 'idle', 'failed save must not start an in-memory timer');
  fs.rmdirSync(stateFile); fs.renameSync(stateFile + '.saved', stateFile);
  assert.equal(activity.tool(tool('pomodoro_set', { focusMinutes: 1, breakMinutes: 2, cycles: 2 }), 'chat_1').ok, true);
  fs.renameSync(stateFile, stateFile + '.saved'); fs.mkdirSync(stateFile);
  now += 60000; await activity.tick();
  assert.equal(activity.snapshot().pomodoro.phase, 'focus', 'failed phase save must be retried');
  fs.rmdirSync(stateFile); fs.renameSync(stateFile + '.saved', stateFile);
  await activity.tick();
  assert.equal(activity.snapshot().pomodoro.phase, 'await_break');
  assert.equal(activity.snapshot().notices[0].text, '角色提醒：await_break');
  assert.deepEqual(announced, ['pomodoro']);
  const breakReminder = activity.snapshot().notices[0];
  activity.ack(breakReminder.seq);
  fs.renameSync(stateFile, stateFile + '.saved'); fs.mkdirSync(stateFile);
  assert.throws(() => activity.advance(breakReminder.advance));
  assert.equal(activity.snapshot().pomodoro.phase, 'await_break', 'failed click save must leave the phase waiting');
  fs.rmdirSync(stateFile); fs.renameSync(stateFile + '.saved', stateFile);
  assert.equal(activity.advance(breakReminder.advance).advanced, true, 'display acknowledgement must not invalidate the click');
  assert.equal(activity.snapshot().pomodoro.phase, 'break');
  assert.equal(activity.advance(breakReminder.advance).advanced, false, 'duplicate click must not advance twice');
  now += 120000; await activity.tick();
  assert.equal(activity.snapshot().pomodoro.phase, 'await_focus');
  assert.equal(activity.advance(breakReminder.advance).advanced, false, 'old break reminder must not start the next focus');
  const focusReminder = activity.snapshot().notices[0];
  const resumed = new ChatActivity({ dataDir, now: () => now, startTimer: false, onReminder: async () => '完成啦' });
  assert.equal(resumed.snapshot().pomodoro.phase, 'await_focus');
  assert.equal(resumed.advance(focusReminder.advance).pomodoro.cycle, 2);
  now += 60000; await resumed.tick();
  assert.equal(resumed.snapshot().pomodoro.phase, 'completed');
  assert.equal(resumed.snapshot().notices.at(-1).advance, undefined, 'completion has no next phase');
  assert.equal(resumed.tool(tool('pomodoro_control', { action: 'start_break' }), 'chat_1').ok, false);
  activity.close(); resumed.close();
});

test('reminder clicks reject replaced plans and earlier reminders for an extended phase through the local API', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-timer-click-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.now();
  const service = new ChatService({ dataDir, activityOptions: { now: () => now, startTimer: false, onReminder: async () => null } });
  t.after(() => service.close());
  const activity = service.activity;
  const click = async body => JSON.parse((await service.dispatch(new URL('http://local/api/chat/activity/advance'), { method: 'POST', body: Buffer.from(JSON.stringify(body)) })).body);
  activity.tool(tool('pomodoro_set', { focusMinutes: 1, breakMinutes: 1, cycles: 2 }), 'chat_1');
  now += 60000; await activity.tick();
  const first = activity.snapshot().notices.at(-1).advance;
  activity.tool(tool('pomodoro_control', { action: 'extend_focus', minutes: 1 }), 'chat_1');
  now += 60000; await activity.tick();
  const extended = activity.snapshot().notices.at(-1).advance;
  assert.equal((await click(first)).advanced, false, 'old reminder for the same cycle must expire after extension');
  assert.equal((await click({ ...extended, cycle: 2 })).advanced, false);
  assert.equal((await click({ ...extended, action: 'stop' })).advanced, false);
  assert.equal((await click(null)).advanced, false);
  activity.tool(tool('pomodoro_set', { focusMinutes: 1, breakMinutes: 1, cycles: 2 }), 'chat_1');
  now += 60000; await activity.tick();
  assert.equal((await click(extended)).advanced, false, 'replaced plan must not respond to an old click');
  const current = activity.snapshot().notices.at(-1).advance;
  const result = await click(current);
  assert.equal(result.advanced, true); assert.equal(result.pomodoro.phase, 'break');
  assert.equal(result.pomodoro.dueAt, now + 60000);
  assert.equal((await click(current)).advanced, false);
});

test('a slow reminder cannot delay the clock or display after the user changes phase', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-timer-slow-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = Date.now(), release;
  const activity = new ChatActivity({ dataDir, now: () => now, startTimer: false,
    onReminder: state => state.phase === 'await_break' ? new Promise(resolve => { release = resolve; }) : Promise.resolve('下一轮开始吗？') });
  activity.tool(tool('pomodoro_set', { focusMinutes: 1, breakMinutes: 1, cycles: 2 }), 'chat_1');
  now += 60000; const firstReminder = activity.tick();
  assert.equal(activity.snapshot().pomodoro.phase, 'await_break');
  activity.tool(tool('pomodoro_control', { action: 'start_break' }), 'chat_1');
  now += 60000; await activity.tick();
  assert.equal(activity.snapshot().pomodoro.phase, 'await_focus');
  release('过期提醒'); await firstReminder;
  assert.deepEqual(activity.snapshot().notices.map(item => item.text), ['下一轮开始吗？']);
  activity.close();
});

test('proactive chat stays within the configured window and daily cap, and does not run during a Pomodoro', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-proactive-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const local = new Date(); local.setHours(10, 0, 0, 0);
  let now = local.getTime(), calls = 0;
  const activity = new ChatActivity({ dataDir, now: () => now, random: () => 0, startTimer: false,
    onProactive: async () => { calls++; return { text: '今天想聊些什么？', conversationId: 'spontaneous_1' }; } });
  activity.saveSettings({ enabled: true, start: '09:00', end: '21:00', minMinutes: 15, maxMinutes: 15, dailyLimit: 1 });
  now += 15 * 60000; activity.setPresence({ busy: true }); await activity.tick();
  assert.equal(calls, 0, 'open chat or approval bubble suppresses proactive calls');
  activity.setPresence({ busy: false });
  now += 30000; await activity.tick();
  assert.equal(calls, 1); assert.equal(activity.snapshot().notices[0].kind, 'proactive');
  activity.ack(activity.snapshot().notices[0].seq);
  now += 15 * 60000; await activity.tick(); assert.equal(calls, 1);
  activity.tool(tool('pomodoro_set', { focusMinutes: 25, breakMinutes: 5, cycles: 2 }), 'chat_1');
  now += 24 * 3600000; await activity.tick(); assert.equal(calls, 1);
  assert.equal(activity.inWindow(new Date(local.getFullYear(), local.getMonth(), local.getDate(), 22).getTime()), false);
  activity.close();
});

test('scheduled messages alternate between remembered and fresh topics without changing the selected chat, and count in billing', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-scheduled-chat-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const local = new Date(); local.setHours(10, 0, 0, 0);
  let now = local.getTime(), random = 0;
  const requests = [];
  const service = new ChatService({ dataDir, activityOptions: { now: () => now, random: () => random, startTimer: false }, fetchImpl: async (url, options) => {
    if (url.endsWith('/user/balance')) return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '10' }] });
    const payload = JSON.parse(options.body); requests.push(payload);
    const text = requests.length === 1 ? '记住咖啡了' : requests.length === 2 ? '再聊聊咖啡？' : '今天想聊点新鲜事。';
    return sse([{ choices: [{ index: 0, delta: { content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
  } });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-key', persona: '你是大肥鱼', maxTokens: 256 });
  const selected = service.history().conversationId;
  await consume(service.start({ id: 'coffee_chat', text: '昨天的咖啡很好喝' }));
  service.activity.saveSettings({ enabled: true, start: '09:00', end: '21:00', minMinutes: 15, maxMinutes: 15, dailyLimit: 2 });
  now += 20 * 60000; await service.activity.tick();
  assert.equal(service.history().conversationId, selected);
  assert.equal(service.history().conversations.length, 2);
  assert.ok(requests[1].messages.some(message => message.content === '昨天的咖啡很好喝'));
  assert.equal(requests[1].tools, undefined, 'automatic messages cannot call timer tools');
  const firstNotice = service.activity.snapshot().notices[0];
  assert.equal(firstNotice.kind, 'proactive');
  service.activity.ack(firstNotice.seq);
  random = 0.9; now += 15 * 60000; await service.activity.tick();
  assert.equal(requests[2].messages.some(message => message.content === '昨天的咖啡很好喝'), false);
  assert.equal(service.history().conversations.length, 2, 'one dedicated spontaneous conversation is reused');
  assert.equal((await service.billing.summary({ baseUrl: 'https://api.deepseek.com', key: 'synthetic-key' })).recorded, 3);
});

test('chat and automatic replies receive fresh local time without persisting it in conversation history', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-chat-time-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = new Date(2026, 8, 28, 1, 0).getTime();
  const requests = [];
  const service = new ChatService({ dataDir, now: () => now, activityOptions: { startTimer: false }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sse([{ choices: [{ index: 0, delta: { content: requests.length === 1 ? '已经很晚了，先休息好吗？' : '晚饭吃了什么？' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
  } });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-key', persona: '你是大肥鱼', maxTokens: 256 });

  await consume(service.start({ id: 'late_timer', text: '现在开始一小时番茄钟' }));
  const first = requests[0].messages;
  assert.equal(first[0].content, '你是大肥鱼');
  assert.match(first[1].content, /2026-09-28 01:00/);
  assert.ok(first[1].content.includes(Intl.DateTimeFormat().resolvedOptions().timeZone));
  assert.match(first[2].content, /深夜请求开始番茄钟/);
  assert.equal(service.activity.snapshot().pomodoro.phase, 'idle', 'a reply without a tool call must not start the timer');

  now = new Date(2026, 8, 28, 19, 10).getTime();
  await consume(service.start({ id: 'evening_chat', text: '随便聊聊' }));
  const second = requests[1].messages;
  assert.match(second[1].content, /2026-09-28 19:10/);
  assert.equal(second.filter(message => message.content?.startsWith('当前用户设备本地时间：')).length, 1);
  assert.ok(second.some(message => message.content === '已经很晚了，先休息好吗？'));
  assert.equal(JSON.stringify(service.history()).includes('当前用户设备本地时间：'), false);

  now = new Date(2026, 8, 28, 20, 30).getTime();
  await service.proactive();
  assert.match(requests[2].messages[1].content, /2026-09-28 20:30/);
  assert.equal(requests[2].tools, undefined);
  now = new Date(2026, 8, 28, 21, 0).getTime();
  await service.reminder({ phase: 'await_break', cycle: 1, cycles: 2, focusMinutes: 25, breakMinutes: 5 });
  assert.match(requests[3].messages[1].content, /2026-09-28 21:00/);
  assert.equal(requests[3].tools, undefined);
});

test('proactive chat and Pomodoro reminders use their own reply length, not the foreground one', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-background-length-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const requests = [], long = '长'.repeat(2500);
  const service = new ChatService({ dataDir, activityOptions: { startTimer: false }, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return sse([{ choices: [{ index: 0, delta: { content: long } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
  } });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-key', persona: '你是大肥鱼', maxTokens: 256, backgroundMaxTokens: 4000 });
  await consume(service.start({ id: 'foreground_chat', text: '你好' }));
  const proactive = await service.proactive();
  const reminder = await service.reminder({ phase: 'await_break', cycle: 1, cycles: 2, focusMinutes: 25, breakMinutes: 5 });
  assert.deepEqual(requests.map(request => request.max_tokens), [256, 4000, 4000]);
  assert.equal(proactive?.text, long, 'a long reply within the token setting is kept whole');
  assert.equal(reminder?.text, long);
});

test('a Pomodoro reminder waits up to 30 seconds for the model, like proactive chat', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reminder-wait-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let respond = null;
  const service = new ChatService({ dataDir, activityOptions: { startTimer: false }, fetchImpl: () => new Promise(resolve => { respond = resolve; }) });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://chat.example.test/v1', model: 'dsv4.1flash', apiKey: 'synthetic-key', persona: '你是大肥鱼', maxTokens: 256 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const reminder = service.reminder({ phase: 'await_break', cycle: 1, cycles: 2, focusMinutes: 25, breakMinutes: 5 });
  while (!respond) await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(29000);
  respond(sse([{ choices: [{ index: 0, delta: { content: '该休息啦' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]));
  assert.equal((await reminder)?.text, '该休息啦');
});

test('a background reply that became stale while generating is neither shown nor kept in conversation history, but is still billed', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-stale-reply-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const local = new Date(); local.setHours(10, 0, 0, 0);
  let now = local.getTime(), release = null;
  const service = new ChatService({ dataDir, activityOptions: { now: () => now, random: () => 0.9, startTimer: false }, fetchImpl: async (url) => {
    if (url.endsWith('/user/balance')) return Response.json({ balance_infos: [{ currency: 'CNY', total_balance: '10' }] });
    await new Promise(resolve => { release = resolve; });
    return sse([{ choices: [{ index: 0, delta: { content: '过期的角色回复' } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage }]);
  } });
  t.after(() => service.close());
  service.save({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-key', persona: '你是大肥鱼', maxTokens: 256 });
  const conversationId = service.history().conversationId;
  const generating = async () => { while (!release) await new Promise(resolve => setImmediate(resolve)); };
  const finish = () => { const done = release; release = null; done(); };

  service.activity.tool(tool('pomodoro_set', { focusMinutes: 1, breakMinutes: 1, cycles: 2 }), conversationId);
  now += 60000; const reminder = service.activity.tick();
  await generating();
  service.activity.tool(tool('pomodoro_control', { action: 'start_break' }), conversationId);
  finish(); await reminder;

  service.activity.tool(tool('pomodoro_control', { action: 'stop' }), conversationId);
  service.activity.saveSettings({ enabled: true, start: '09:00', end: '21:00', minMinutes: 15, maxMinutes: 15, dailyLimit: 1 });
  now += 20 * 60000; const proactive = service.activity.tick();
  await generating();
  service.activity.tool(tool('pomodoro_set', { focusMinutes: 25, breakMinutes: 5, cycles: 2 }), conversationId);
  finish(); await proactive;

  assert.deepEqual(service.activity.snapshot().notices, []);
  assert.equal(service.conversations.allTurns().length, 0, 'stale replies must not be written to any conversation');
  assert.equal(service.history().conversations.length, 1, 'a stale proactive reply must not create the spontaneous conversation');
  assert.equal(service.activity.dailyCount, 0, 'the unused proactive attempt is refunded');
  assert.equal((await service.billing.summary({ baseUrl: 'https://api.deepseek.com', key: 'synthetic-key' })).recorded, 2);
});

test('unreadable activity files fall back to a stopped timer and default settings instead of disabling chat', async t => {
  // Garbled bytes, and valid JSON that does not hold an object.
  for (const [settings, state] of [['{"enabled": tru', '\u0000\u0000'], ['null', 'null'], ['[]', '"text"']]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-activity-corrupt-'));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dataDir, 'chat-activity.json'), settings);
    fs.writeFileSync(path.join(dataDir, 'chat-activity-state.json'), state);
    const service = new ChatService({ dataDir, activityOptions: { startTimer: false } });
    t.after(() => service.close());
    const response = await service.dispatch(new URL('http://local/api/chat/activity'), { method: 'GET' });
    assert.equal(response.status, 200, state);
    const body = JSON.parse(response.body);
    assert.equal(body.pomodoro.phase, 'idle'); assert.equal(body.settings.enabled, false); assert.deepEqual(body.notices, []);
    assert.equal(body.settings.start, '09:00', 'settings that are not an object are ignored whole');
    assert.equal(service.activity.tool(tool('pomodoro_set', { focusMinutes: 25, breakMinutes: 5, cycles: 1 }), 'chat_1').ok, true, 'the next save replaces the unreadable state');
    assert.equal(new ChatActivity({ dataDir, startTimer: false }).snapshot().pomodoro.phase, 'focus');
  }
});
