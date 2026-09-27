import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigStore } from '../runtime/config.mjs';
import { WhaleService } from '../runtime/service.mjs';
import { bridgeRequest } from '../runtime/bridge.mjs';

export async function makeFixture(dataDir) {
  const codexHome = process.env.CODEX_HOME;
  assert.ok(codexHome && process.env.WHALE_HOME === dataDir, 'isolated directories are required');
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://fixture.example.test/v1"\nenv_key = "FIXTURE_KEY"\n');
  const config = new ConfigStore({ dataDir, codexHome, env: { FIXTURE_KEY: 'synthetic-test-key' } });
  config.save({ provider: 'custom-json', balancePath: '/balance', balanceField: 'balance', monitorSessions: false });
  const service = new WhaleService({ config, fetchImpl: async () => Response.json({ balance: 12.3456 }) });
  let completedChatCalls = 0;
  const chatFetchImpl = async (url, { body, signal }) => {
    if (url === 'https://api.deepseek.com/user/balance') return Response.json({ is_available: true, balance_infos: [
      { currency: 'CNY', total_balance: (110 - completedChatCalls * 0.001).toFixed(3), granted_balance: '10', topped_up_balance: '100' }
    ] });
    const input = JSON.parse(body), last = input.messages.at(-1).content;
    const text = last.includes('long') ? '这是逐步输出的长回复。'.repeat(90) : '第一行回复\n第二行回复';
    let timer;
    const stream = new ReadableStream({ start(controller) {
      let cursor = 0;
      const abort = () => { clearTimeout(timer); controller.error(new Error('aborted')); };
      signal.addEventListener('abort', abort, { once: true });
      const tick = () => {
        if (signal.aborted) return;
        const delta = text.slice(cursor, cursor + 30); cursor += delta.length;
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: delta } }] }) + '\n\n'));
        if (cursor < text.length) timer = setTimeout(tick, 40);
        else {
          completedChatCalls++;
          controller.enqueue(encoder.encode('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: {
            prompt_tokens: 1000, prompt_cache_hit_tokens: 200, prompt_cache_miss_tokens: 800, completion_tokens: 100, total_tokens: 1100
          } }) + '\n\ndata: [DONE]\n\n'));
          signal.removeEventListener('abort', abort); controller.close();
        }
      };
      timer = setTimeout(tick, 100);
    }, cancel() { clearTimeout(timer); } });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { service, monitor: false, autoRefresh: false, chatFetchImpl, fxFetchImpl: async () => Response.json({ date: new Date().toISOString().slice(0, 10), usd: { cny: 7 } }) };
}

function wav() {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
  return 'data:audio/wav;base64,' + bytes.toString('base64');
}

export async function verifyDesktop({ app, window, dispatcher, dataDir, errors, setTestCursor, setTestViewport, activateChatShortcut, chatShortcutAvailable, renderInfo }) {
  const phase = process.env.WHALE_TEST_PHASE, output = process.env.WHALE_TEST_OUTPUT, passed = [], layouts = [];
  const js = source => window.webContents.executeJavaScript(source);
  async function until(source, message) {
    for (let i = 0; i < 100; i++) {
      if (await js(`Boolean(${source})`)) return;
      await delay(100);
    }
    const state = await js("({ focused: document.activeElement?.id, chatHidden: document.getElementById('chat-composer')?.hidden, chatStatus: document.getElementById('chat-status')?.textContent, viewport: [innerWidth, innerHeight], bounds: ['.dshwv-img', '#chat-composer', '#chat-reply'].map(selector => document.querySelector(selector)?.getBoundingClientRect().toJSON()) })");
    await capture('failure');
    throw new Error(message + ': ' + JSON.stringify({ state, errors }));
  }
  const status = () => js('window.__whaleRenderTest.status()');
  const saved = () => dispatcher.whale.readUsageSettings().approvalSound;
  const row = "[...document.querySelectorAll('.dshwv-menu-row')].find(el => el.textContent.includes('审批提醒音效'))";
  async function approval() {
    await delay(800);
    const result = await bridgeRequest('/internal/approval-request', { method: 'POST', body: { event: 'PermissionRequest' }, dataDir });
    assert.equal(result.ok, true);
    await until("window.__whaleRenderTest.status().scene === 'approval' && document.querySelector('.dshwv-pop-open')", 'approval was not rendered');
  }
  async function click(selector, button = 'left') {
    await delay(350);
    const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    setTestCursor(point);
    await delay(200);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point });
    await delay(300);
  }
  async function capture(name) {
    await delay(200);
    const frame = await window.webContents.capturePage();
    assert.ok(!frame.isEmpty());
    const pixels = frame.toBitmap();
    assert.ok(pixels.some((value, index) => index % 4 === 3 && value > 0), 'transparent/blank frame');
    fs.writeFileSync(path.join(output, name + '.png'), frame.toPNG());
  }
  async function measureLayout(name) {
    const layout = await js(`(() => {
      const state = window.__whaleRenderTest.status();
      const frame = document.querySelector('.dshwv-frame[data-buffer="' + state.front + '"]');
      const box = frame.closest('.dshwv-text').getBoundingClientRect();
      const bounds = rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
      const rows = [...frame.querySelectorAll('.dshwv-trow, .dshwv-label, .dshwv-amount, .dshwv-hint')]
        .filter(el => el.checkVisibility({ visibilityProperty: true }))
        .map(el => ({ text: el.innerText, bounds: bounds(el.getBoundingClientRect()) }));
      return { scene: state.scene, text: frame.innerText, bounds: bounds(box), rows,
        fits: rows.every(row => row.bounds.left >= box.left - 1 && row.bounds.top >= box.top - 1 && row.bounds.right <= box.right + 1 && row.bounds.bottom <= box.bottom + 1) };
    })()`);
    layouts.push({ name, ...layout });
    await capture(name);
    return layout;
  }

  await until('!!window.__whaleRenderTest && document.querySelector(".dshwv-img").naturalWidth > 0', 'renderer/assets did not load');
  await until('window.__whaleRenderTest.status().balance === 12.3456', 'balance did not load');
  for (let i = 0; !window.isVisible() && i < 150; i++) await delay(100);
  assert.ok(window.isVisible(), 'free desktop should be visible without a Codex window');
  await js('window.__whaleRenderTest.place(300, 300, false)');
  // Observe browser audio requests without playing sounds on the developer desktop.
  await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
  passed.push('free desktop loads visible assets and balance without Codex');

  if (process.platform === 'darwin') {
    assert.equal(typeof chatShortcutAvailable, 'boolean');
    activateChatShortcut();
    await until("!document.getElementById('chat-composer').hidden && document.activeElement === document.getElementById('chat-input')", 'Ctrl+0 did not open a focused chat composer');
    await js("document.getElementById('chat-show-history').focus()");
    activateChatShortcut();
    await until("document.activeElement === document.getElementById('chat-input')", 'Ctrl+0 did not refocus an open composer');
    await js("document.getElementById('chat-close').click()");
    passed.push(chatShortcutAvailable ? 'Ctrl+0 registers globally and opens or refocuses chat input' :
      'Ctrl+0 is occupied by another instance; the same shortcut handler opens and refocuses chat input');
  }

  if (phase === 'restart') {
    const config = await dispatcher.dispatch('/api/chat/settings');
    assert.equal(JSON.parse(config.body).settings.hasKey, true, 'chat key did not survive restart');
    await click('.dshwv-img', 'right');
    await until("document.activeElement === document.getElementById('chat-input') && !document.getElementById('chat-composer').hidden", 'chat did not focus after restart');
    await until("document.getElementById('chat-output').textContent.includes('第一行回复')", 'chat history did not survive restart');
    await until("document.querySelector('[data-chat-spent]').textContent.includes('约') && document.querySelector('[data-chat-balance]').textContent.includes('¥110')", 'chat billing did not survive restart');
    assert.ok(JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing.recorded > 0);
    assert.equal(await js("document.querySelector('[data-chat-spent]').textContent.match(/¥\\d+\\.\\d{2}$/) !== null"), true);
    await js("document.getElementById('chat-close').click()");
    passed.push('chat configuration and conversation survive a full process restart');
    const pref = saved();
    assert.ok(pref.on && pref.sel.startsWith('frag:'));
    await until(`(${row}).querySelector('select').value === ${JSON.stringify(pref.sel)}`, 'custom sound selection did not survive restart');
    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(pref.sel.slice(5))));
    passed.push('custom approval sound survives a full Electron process restart');
    await capture('restart-approval');
  } else {
    await click('.dshwv-img', 'right');
    await until("document.activeElement === document.getElementById('chat-input') && !document.getElementById('chat-composer').hidden", 'right click did not open and focus composer');
    assert.equal(await js("document.getElementById('chat-composer').getBoundingClientRect().top >= document.querySelector('.dshwv-img').getBoundingClientRect().bottom"), true, 'composer should be below pet');
    await js("document.getElementById('chat-open-settings').click()");
    await until("document.getElementById('chat-settings').open", 'chat settings did not open');
    await js(`(() => { const form = document.getElementById('chat-settings-form'); const values = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: 'synthetic-chat-key', persona: 'You are a whale.', maxTokens: 1024 }; for (const [key, value] of Object.entries(values)) form.elements.namedItem(key).value = value; form.requestSubmit(); })()`);
    await until("!document.getElementById('chat-settings').open", 'chat settings did not save');
    await click('#chat-input');
    await until("document.activeElement === document.getElementById('chat-input')", 'chat input did not regain focus after settings');
    await window.webContents.insertText('first');
    await until("document.getElementById('chat-input').value === 'first'", 'first line was not committed to chat input');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] });
    await until("document.getElementById('chat-input').value === 'first\\n'", 'Shift+Enter did not add a new line');
    await window.webContents.insertText('second');
    await until("document.getElementById('chat-input').value === 'first\\nsecond'", 'second line was not committed to chat input');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await until("document.getElementById('chat-output').textContent.includes('第二行回复') && document.getElementById('chat-stop').hidden", 'Enter did not stream reply');
    await until("document.querySelector('[data-chat-spent]').textContent.includes('约') && document.querySelector('[data-chat-balance]').textContent.includes('¥109.999')", 'chat cost and balance did not refresh after reply');
    const billed = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
    assert.equal(billed.recorded, 1); assert.ok(billed.min > 0); assert.equal(billed.unknown, 0);
    await capture('chat-short-reply');
    const shortHeight = await js("document.getElementById('chat-reply').offsetHeight");
    await js("document.getElementById('chat-input').value = 'long'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.length > 60 && !document.getElementById('chat-stop').hidden", 'reply was not visible during streaming');
    await until(`document.getElementById('chat-reply').offsetHeight > ${shortHeight}`, 'reply bubble did not grow with content');
    await capture('chat-streaming-reply');
    const hiddenAt = await js("document.getElementById('chat-output').textContent.length");
    await js("document.getElementById('chat-output').click()");
    await until(`document.getElementById('chat-reply').hidden && document.getElementById('chat-output').textContent.length > ${hiddenAt + 30}`, 'stream output reopened a manually hidden reply');
    activateChatShortcut();
    await until("document.activeElement === document.getElementById('chat-input')", 'shortcut did not refocus during streaming');
    assert.equal(await js("document.getElementById('chat-reply').hidden"), true, 'shortcut reopened a dismissed reply');
    await js("document.getElementById('chat-show-history').click()");
    await until("!document.getElementById('chat-reply').hidden && document.getElementById('chat-history').hidden === false", 'opening history did not restore the dismissed reply');
    await js("document.getElementById('chat-output').click()");
    await until("document.getElementById('chat-reply').hidden", 'reply did not dismiss after being restored');
    await js("document.getElementById('chat-stop').click()");
    await until("document.getElementById('chat-stop').hidden && document.getElementById('chat-status').textContent.includes('已停止')", 'stop did not finish generation');
    await js("document.getElementById('chat-input').value = 'next'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.includes('第二行回复') && document.getElementById('chat-stop').hidden", 'could not chat after cancellation');
    window.webContents.debugger.attach('1.3');
    await window.webContents.debugger.sendCommand('Page.enable');
    const injection = await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      window.__chatStreamCutTest = true;
      const original = window.fetch.bind(window); let cut = false;
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (args[0] !== '/api/chat/message' || cut) return response;
        cut = true; const reader = response.body.getReader();
        return new Response(new ReadableStream({ async start(controller) {
          for (let i = 0; i < 2; i++) { const chunk = await reader.read(); if (chunk.done) break; controller.enqueue(chunk.value); }
          controller.close(); await reader.cancel();
        } }), { headers: response.headers, status: response.status });
      };
    })();` });
    window.webContents.reload();
    await until("window.__chatStreamCutTest && !!window.__whaleRenderTest && !!document.getElementById('chat-input')", 'chat reload failed');
    await click('.dshwv-img', 'right');
    await until("document.activeElement === document.getElementById('chat-input') && !document.getElementById('chat-new').disabled", 'chat did not load after renderer restart');
    await js("document.getElementById('chat-input').value = 'long interrupted'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-status').textContent.includes('重新打开') && document.getElementById('chat-stop').hidden", 'stream interruption was not reported');
    await js("document.getElementById('chat-close').click()");
    await click('.dshwv-img', 'right');
    await until("!document.getElementById('chat-new').disabled && document.getElementById('chat-status').textContent.includes('已停止')", 'reopening did not synchronize interrupted history');
    const recovered = JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).turns.at(-1);
    assert.ok(recovered.text.length > 0, 'interrupted stream lost all partial text');
    assert.equal(await js("document.getElementById('chat-output').textContent"), recovered.text);
    await js("document.getElementById('chat-input').value = 'next'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-output').textContent.includes('第二行回复') && document.getElementById('chat-stop').hidden", 'could not send after recovering history');
    await window.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: injection.identifier });
    window.webContents.debugger.detach();
    passed.push('reopening after an interrupted stream synchronizes persisted partial text and permits a later reply');
    const firstConversation = JSON.parse((await dispatcher.dispatch('/api/chat/history')).body);
    await js("document.getElementById('chat-input').value = 'unsent draft'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-new').click();");
    await until("!document.getElementById('chat-new').disabled && document.getElementById('chat-input').value === '' && document.activeElement === document.getElementById('chat-input')", 'new conversation did not reset and focus input');
    const secondConversation = JSON.parse((await dispatcher.dispatch('/api/chat/history')).body);
    assert.notEqual(secondConversation.conversationId, firstConversation.conversationId);
    assert.equal(secondConversation.turns.length, 0); assert.equal(secondConversation.conversations.length, 2);
    await js("document.getElementById('chat-input').value = 'second topic'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-stop').hidden && !document.getElementById('chat-new').disabled", 'second conversation did not finish');
    await js("document.getElementById('chat-show-conversations').click()");
    const firstRow = `.chat-conversation[data-conversation-id="${firstConversation.conversationId}"]`;
    const secondRow = `.chat-conversation[data-conversation-id="${secondConversation.conversationId}"]`;
    await js(`document.querySelector(${JSON.stringify(firstRow + ' .chat-conversation-open')}).click()`);
    await until("!document.getElementById('chat-new').disabled && document.getElementById('chat-input').value === 'unsent draft' && document.activeElement === document.getElementById('chat-input')", 'switching conversation lost its draft or input focus');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).turns.length, firstConversation.turns.length);
    await js("document.getElementById('chat-input').value = 'continue original topic'; document.getElementById('chat-input').dispatchEvent(new Event('input')); document.getElementById('chat-send').click();");
    await until("document.getElementById('chat-stop').hidden && !document.getElementById('chat-new').disabled", 'resumed conversation did not finish');
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).turns.length, firstConversation.turns.length + 1);
    assert.equal(await js("document.querySelector('[data-chat-spent]').textContent.match(/¥\\d+\\.\\d{2}$/) !== null"), true);
    await capture('chat-conversation-list');
    const originalBounds = window.getBounds();
    for (const [width, height] of [[1024, 768], [390, 844]]) {
      setTestViewport({ ...originalBounds, width, height });
      await until(`window.innerWidth === ${width} && window.innerHeight === ${height}`, 'native viewport resize failed');
      await delay(350);
      for (const edge of ['bottom', 'top']) {
        await js(`window.__whaleRenderTest.place(${width - 240}, ${edge === 'bottom' ? height - 240 : 0}, false)`);
        for (const history of [false, true]) {
          await js(`if (document.getElementById('chat-history').hidden !== ${!history}) document.getElementById('chat-show-history').click()`);
          await delay(500);
          await until(`(() => { const pet = document.querySelector('.dshwv-img').getBoundingClientRect(); const box = document.getElementById('chat-composer').getBoundingClientRect(); const reply = document.getElementById('chat-reply').getBoundingClientRect(); const overlap = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top; return box.top >= pet.bottom && !overlap(reply, box) && !overlap(reply, pet) && [box, reply].every(r => r.left >= 0 && r.top >= 0 && r.right <= ${width} && r.bottom <= ${height}); })()`, 'chat surfaces did not fit viewport ' + width + ', edge ' + edge + ', history ' + history);
          await capture('chat-viewport-' + width + '-' + edge + (history ? '-history' : ''));
        }
      }
    }
    setTestViewport(null);
    const beforeDelete = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
    await js(`document.querySelector(${JSON.stringify(secondRow + ' .chat-conversation-delete')}).click()`);
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).conversations.length, 2, 'delete should await explicit confirmation');
    await capture('chat-conversation-delete-confirmation');
    await js(`document.querySelector(${JSON.stringify(secondRow + ' .chat-conversation-confirm')}).click()`);
    await until("document.querySelectorAll('.chat-conversation').length === 1 && !document.getElementById('chat-new').disabled", 'confirmed conversation deletion failed');
    const afterDelete = JSON.parse((await dispatcher.dispatch('/api/chat/billing')).body).billing;
    assert.equal(afterDelete.recorded, beforeDelete.recorded); assert.equal(afterDelete.min, beforeDelete.min);
    assert.equal(JSON.parse((await dispatcher.dispatch('/api/chat/history')).body).conversationId, firstConversation.conversationId);
    await js("document.getElementById('chat-show-conversations').click()");
    passed.push('conversation list creates independent sessions, restores drafts, resumes old history and deletes only the chosen session while preserving billing');
    await js("document.getElementById('chat-history').hidden = true");
    await js('window.__whaleRenderTest.place(300, 300, false)');
    await js("document.getElementById('chat-close').click()");
    passed.push('native right click focuses a below-pet composer; Enter sends, Shift+Enter adds a line, streamed reply grows and stop permits a later reply');

    const now = Date.now();
    const rateLimits = { observedAt: now, planType: 'plus',
      fiveHour: { usedPercent: 25, windowMinutes: 300, resetsAt: now + 3600000 },
      sevenDay: { usedPercent: 60, windowMinutes: 10080, resetsAt: now + 86400000 } };
    dispatcher.whale.updateSubscriptionRateLimits(rateLimits);
    dispatcher.whale.updateSubscriptionRateLimitContext({ observedAt: now, usesSubscription: true });
    await js('window.__whaleRenderTest.refresh(true)');
    await until("document.querySelector('.dshwv-root').title.includes('Codex 订阅额度')", 'subscription did not replace API display');
    await click('.dshwv-img');
    await until("[...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => el.innerText.includes('5小时剩余75%') && Number(getComputedStyle(el).opacity) > 0.99)", 'native subscription click did not become visible');
    await measureLayout('subscription-native-click');
    await js('window.__whaleRenderTest.close()');
    const profile = await dispatcher.dispatch('/dsh-whale/bubble.json', { method: 'POST', body: { v: 1, lib: [], items: [{ kind: 'custom', modules: [
      { type: 'text', text: '当前 API 余额', size: 4 }, { type: 'balance', size: 8 }, { type: 'today', size: 4 }
    ] }] } });
    assert.equal(profile.status, 200);
    window.webContents.reload();
    await until("!!window.__whaleRenderTest && document.querySelector('.dshwv-root').title.includes('Codex 订阅额度')", 'subscription profile did not load after reload');
    await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
    await click('.dshwv-img');
    await until("!window.__whaleRenderTest.status().switching && window.__whaleRenderTest.status().randomPicks.includes('7天剩余40%') && [...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => Number(getComputedStyle(el).opacity) > 0.99)", 'size-8 subscription click did not become visible');
    const profileLayout = await measureLayout('subscription-size-8-click');
    assert.ok(profileLayout.fits, 'size-8 subscription text overflowed its content area');
    await js('window.__whaleRenderTest.close()');
    const quotaTurn = { id: 'fixture:subscription', sessionId: 'fixture', turnId: 'subscription', ts: Date.now(),
      subscriptionRateLimits: rateLimits,
      byModel: { 'test-model': { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } };
    dispatcher.whale.beginTurn(quotaTurn);
    await dispatcher.whale.finishTurn(quotaTurn);
    await js('window.__whaleRenderTest.poll()');
    await until("window.__whaleRenderTest.status().scene === 'cost' && !window.__whaleRenderTest.status().switching && window.__whaleRenderTest.status().randomPicks.includes('5小时剩余75%') && [...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => Number(getComputedStyle(el).opacity) > 0.99)", 'subscription completion did not become visible');
    const completionLayout = await measureLayout('subscription-completion');
    assert.equal(completionLayout.rows.length, 3);
    assert.ok(completionLayout.text.includes('7天剩余40%'));
    assert.ok(!completionLayout.text.includes('待记账'));
    assert.ok(completionLayout.fits, 'subscription completion text overflowed its content area');
    passed.push('size-8 native click and subscription completion text fit their content area; default and legacy layouts are measured separately');
    await js('window.__whaleRenderTest.close()');
    await js('window.__whaleRenderTest.queue([{ kind: "normal" }]); window.__whaleRenderTest.open();');
    await until("window.__whaleRenderTest.status().randomPicks.includes('5小时剩余75%') && window.__whaleRenderTest.status().randomPicks.includes('7天剩余40%')", 'subscription bubble did not use quota text');
    await until("[...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => el.innerText.includes('5小时剩余75%') && Number(getComputedStyle(el).opacity) > 0.99)", 'subscription text did not become visible');
    await measureLayout('subscription-forced-normal');
    await js('window.__whaleRenderTest.close()');
    dispatcher.whale.updateSubscriptionRateLimitContext({ observedAt: now + 1, usesSubscription: false });
    await js('window.__whaleRenderTest.refresh(true)');
    await until("document.querySelector('.dshwv-root').title.includes('自定义 API 余额')", 'API fallback did not restore display');
    const completed = { id: 'fixture:completed', sessionId: 'fixture', turnId: 'completed', ts: Date.now(),
      byModel: { 'test-model': { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } } };
    dispatcher.whale.beginTurn(completed);
    await dispatcher.whale.finishTurn(completed);
    await js('window.__whaleRenderTest.poll()');
    await until("window.__whaleRenderTest.status().scene === 'cost' && window.__whaleRenderTest.status().randomPicks.includes('待记账') && window.__whaleRenderTest.status().randomPicks.includes('120 tokens')", 'task result did not become a cost bubble');
    await until("[...document.querySelectorAll('.dshwv-pop-open .dshwv-text')].some(el => el.innerText.includes('待记账') && Number(getComputedStyle(el).opacity) > 0.99)", 'task cost text did not become visible');
    await capture('task-cost-display');
    await js('window.__whaleRenderTest.close()');
    passed.push('real usage requests switch subscription/API display and map a completion to a pending-cost bubble');

    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes('fx1') && url.includes('release')));
    await delay(13200);
    assert.equal((await status()).scene, 'approval', 'approval expired without a click');
    await js('window.__whaleRenderTest.showCost(1)');
    await delay(300);
    assert.equal((await status()).scene, 'approval', 'completion displaced approval');
    await capture('persistent-approval');
    await click('.dshwv-pop-open');
    assert.notEqual((await status()).scene, 'approval');
    passed.push('approval persists beyond 12 seconds, queues completion, and dismisses on bubble click');

    await approval();
    await click('.dshwv-img');
    assert.notEqual((await status()).scene, 'approval');
    passed.push('native pet click dismisses approval');

    await js(`(${row}).querySelector('input').click()`);
    await until(`(${row}).querySelector('input').checked === false`, 'sound switch did not toggle');
    for (let i = 0; saved().on && i < 50; i++) await delay(100);
    assert.equal(saved().on, false);
    await js('window.__playedAudio = []');
    await approval();
    assert.deepEqual(await js('window.__playedAudio'), []);
    passed.push('approval mute persists and leaves the visual reminder enabled');

    const uploaded = await dispatcher.dispatch('/dsh-whale/audio.json', { method: 'POST', body: { action: 'upload-fragment', name: 'Baseline test sound', audio: wav() } });
    assert.equal(uploaded.status, 200);
    const id = JSON.parse(uploaded.body).id;
    window.webContents.reload();
    await until(`!!window.__whaleRenderTest && !!(${row})?.querySelector('select option[value="frag:${id}"]')`, 'custom sound was not loaded');
    assert.equal(await js(`(${row}).querySelector('input').checked`), false);
    await js(`(${row}).querySelector('input').click(); const select = (${row}).querySelector('select'); select.value = ${JSON.stringify('frag:' + id)}; select.dispatchEvent(new Event('change'));`);
    for (let i = 0; saved().sel !== 'frag:' + id && i < 50; i++) await delay(100);
    assert.deepEqual(saved(), { on: true, sel: 'frag:' + id });
    assert.equal(dispatcher.whale.readUsageSettings().taskEnd.on, false);
    const media = await dispatcher.dispatch('/dsh-whale/audio-fragment.wav?id=' + id);
    assert.equal(media.status, 200);
    assert.ok(media.body.length > 44);
    await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(id)));
    passed.push('imported WAV plays with completion sound disabled and persists for next startup');
    await capture('custom-approval');
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify({ version: '0.2.6', phase, passed, layouts, rendering: renderInfo(), rendererErrors: errors }, null, 2));
  await dispatcher.close();
  app.quit();
}
