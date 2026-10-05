import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, turn } from './helpers/fixture.mjs';

const prices = { 'test-model': { input: 1000, cachedInput: 100, output: 2000 } };

test('main and late child turns aggregate once and stay isolated across sources', async t => {
  const { service } = fixture(t, { models: prices });
  const main = turn('work', { provider: 'work' });
  service.beginTurn(main);
  await service.finishTurn(main);
  const seq = service.lastTurn().seq;
  const child = turn('child', { provider: 'work', input: 50, output: 10, rootTurnId: 'work', isSubagent: true });
  service.beginTurn(child);
  await service.finishTurn(child);
  await service.finishTurn(child);
  assert.equal(service.lastTurn().tokens, 180);
  assert.equal(service.lastTurn().amount, 0.21);
  assert.equal(service.lastTurn().seq, seq);
  const personal = turn('personal', { input: 200, output: 40 });
  service.beginTurn(personal);
  await service.finishTurn(personal);
  const records = service.usageRecords();
  assert.equal(records.overall.all.tokens, 420);
  assert.equal(records.overall.all.turns, 2);
  assert.deepEqual(records.overall.all.amounts, [{ currency: 'USD', total: 0.49 }]);
  assert.equal(records.overall.sources.find(source => source.name === 'Work').all.tokens, 180);
  assert.equal(records.all.events.length, 1);
});

test('later shared-key debits never become the amount of a previously pending turn', async t => {
  let used = 0;
  const { service, createService } = fixture(t, { used: () => used });
  const meta = turn('pending');
  service.beginTurn(meta);
  await service.finishTurn(meta);
  assert.equal(service.lastTurn().costState, 'pending');
  assert.equal(service.lastTurn().amount, null);
  used = 10;
  await service.getBalance({ force: true });
  assert.equal(service.lastTurn().amount, null);
  await service.close();
  const restarted = createService();
  assert.deepEqual(restarted.prepareRecovery(), []);
  assert.equal(restarted.lastTurn().costState, 'unknown');
  assert.equal(restarted.lastTurn().amount, null);
  assert.equal(restarted.usageRecords().overall.all.tokens, 120);
  assert.deepEqual(restarted.usageRecords().overall.all.amounts, []);
});

test('interrupted turns recover tokens without replaying completion or duplicating records', async t => {
  const { service, createService } = fixture(t, { models: prices });
  const meta = turn('recover', { provider: 'work' });
  service.beginTurn(meta);
  service.updateTurn(meta);
  await service.close();
  const restarted = createService();
  assert.deepEqual(restarted.prepareRecovery(), [meta.id]);
  await restarted.finishTurn({ ...meta, historical: true, outcome: 'interrupted', notify: false });
  await restarted.finishTurn(meta);
  assert.equal(restarted.lastTurn().seq, 0);
  assert.equal(restarted.usageRecords().overall.all.tokens, 120);
  assert.equal(restarted.usageRecords().overall.all.turns, 1);
  assert.deepEqual(createService().prepareRecovery(), []);
});

test('approval and Pomodoro sound settings persist independently from task completion sound', async t => {
  const { service, createService } = fixture(t);
  assert.deepEqual(service.readUsageSettings().approvalSound, { on: true, sel: 'preset:fx1:release' });
  assert.deepEqual(service.readUsageSettings().pomodoroSound, { on: true, sel: 'preset:fx1:release' });
  service.writeUsageSettings({ taskEnd: { on: false }, approvalSound: { on: false, sel: 'frag:custom' }, pomodoroSound: { on: true, sel: 'frag:timer' } });
  const settings = createService().readUsageSettings();
  assert.equal(settings.taskEnd.on, false);
  assert.deepEqual(settings.approvalSound, { on: false, sel: 'frag:custom' });
  assert.deepEqual(settings.pomodoroSound, { on: true, sel: 'frag:timer' });
  service.writeUsageSettings({ pomodoroSound: { on: false } });
  assert.deepEqual(createService().readUsageSettings().pomodoroSound, { on: false, sel: 'frag:timer' });
  assert.throws(() => service.writeUsageSettings({ budget: { amount: -1 } }), /非负/);
  assert.equal(createService().readUsageSettings().budget.amount, settings.budget.amount);
});
