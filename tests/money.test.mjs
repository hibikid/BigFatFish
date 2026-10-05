import assert from 'node:assert/strict';
import test from 'node:test';
import { browserModule } from './helpers/browser-module.mjs';

const { createMoneyState } = browserModule('money.js');
const quote = { usdCny: 7, date: '2026-10-05', retrievedAt: new Date().toISOString() };

test('with no currency chosen each amount shows in its own, whichever account is in use', async () => {
  const money = createMoneyState({ loadQuote: async () => quote });
  await money.ready();
  assert.equal(money.state().displayCurrency, null);
  assert.equal(money.formatMoney(130.84, 'USD'), '$130.84');
  assert.equal(money.formatMoney(49.19, 'CNY'), '¥49.19', 'a CNY account does not turn a USD account into yuan, or the other way');
});

test('a chosen currency converts every amount once a rate is known, and choosing none goes back', async () => {
  let saved = null;
  const money = createMoneyState({ loadQuote: async () => quote, savePreference: value => { saved = value; } });
  await money.setDisplayCurrency('USD');
  assert.deepEqual([money.formatMoney(70, 'CNY'), money.formatMoney(130.84, 'USD'), saved], ['$10.00', '$130.84', 'USD']);
  await money.setDisplayCurrency('CNY');
  assert.equal(money.formatMoney(10, 'USD'), '¥70.00');
  await money.setDisplayCurrency(null);
  assert.deepEqual([money.formatMoney(10, 'USD'), money.state().preferredCurrency, saved], ['$10.00', null, '']);
});

test('a chosen currency without a rate shows each amount in its own currency rather than nothing', async () => {
  const money = createMoneyState({ readPreference: () => 'CNY', loadQuote: async () => { throw new Error('offline'); } });
  await money.ready();
  assert.equal(money.state().preferredCurrency, 'CNY');
  assert.deepEqual([money.formatMoney(12.5, 'USD'), money.formatMoney(45.2, 'CNY')], ['$12.50', '¥45.20']);
});
