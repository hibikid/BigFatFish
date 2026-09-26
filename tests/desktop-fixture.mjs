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
  return { service, monitor: false, autoRefresh: false, fxFetchImpl: async () => Response.json({ date: new Date().toISOString().slice(0, 10), usd: { cny: 7 } }) };
}

function wav() {
  const bytes = Buffer.alloc(44 + 1600);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(1600, 40);
  return 'data:audio/wav;base64,' + bytes.toString('base64');
}

export async function verifyDesktop({ app, window, dispatcher, dataDir, errors, setTestCursor, renderInfo }) {
  const phase = process.env.WHALE_TEST_PHASE, output = process.env.WHALE_TEST_OUTPUT, passed = [];
  const js = source => window.webContents.executeJavaScript(source);
  async function until(source, message) {
    for (let i = 0; i < 100; i++) {
      if (await js(`Boolean(${source})`)) return;
      await delay(100);
    }
    throw new Error(message);
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
  async function click(selector) {
    const point = await js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    setTestCursor(point);
    await delay(200);
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
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

  await until('!!window.__whaleRenderTest && document.querySelector(".dshwv-img").naturalWidth > 0', 'renderer/assets did not load');
  await until('window.__whaleRenderTest.status().balance === 12.3456', 'balance did not load');
  for (let i = 0; !window.isVisible() && i < 150; i++) await delay(100);
  assert.ok(window.isVisible(), 'free desktop should be visible without a Codex window');
  await js('window.__whaleRenderTest.place(300, 300, false)');
  // Observe browser audio requests without playing sounds on the developer desktop.
  await js('window.__playedAudio = []; HTMLMediaElement.prototype.play = function () { window.__playedAudio.push(this.src); return Promise.resolve(); }; undefined;');
  passed.push('free desktop loads visible assets and balance without Codex');

  if (phase === 'restart') {
    const pref = saved();
    assert.ok(pref.on && pref.sel.startsWith('frag:'));
    await until(`(${row}).querySelector('select').value === ${JSON.stringify(pref.sel)}`, 'custom sound selection did not survive restart');
    await approval();
    assert.ok((await js('window.__playedAudio')).some(url => url.includes(pref.sel.slice(5))));
    passed.push('custom approval sound survives a full Electron process restart');
    await capture('restart-approval');
  } else {
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
  fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify({ version: '0.2.5', phase, passed, rendering: renderInfo(), rendererErrors: errors }, null, 2));
  await dispatcher.close();
  app.quit();
}
