import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../runtime/config.mjs';
import { UsageLedger } from '../runtime/ledger.mjs';
import { SessionParser } from '../runtime/session-monitor.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-multi-source-'));
try {
  const codexHome = path.join(root, '.codex'), dataDir = path.join(codexHome, 'whale-widget');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model_provider = "openai"\nmodel = "personal-model"\n');
  fs.writeFileSync(path.join(codexHome, 'work.config.toml'), [
    'model_provider = "work"', 'model = "work-model"', '', '[model_providers.work]', 'base_url = "https://example.test/v1"', 'env_key = "WORK_CODEX_API_KEY"', '',
  ].join('\n'));
  const store = new ConfigStore({ dataDir, codexHome, env: { WORK_CODEX_API_KEY: 'test-key' } });
  store.save({ sources: [{ id: 'work', name: '工作中转站', configPath: path.join(codexHome, 'work.config.toml'), keyEnv: 'WORK_CODEX_API_KEY', enabled: true }] });
  const source = store.resolveForSession({ modelProvider: 'work' });
  assert.equal(source.sourceId, 'work');
  assert.equal(source.model, 'work-model');
  assert.equal(source.key, 'test-key');
  assert.equal(store.resolveForSession({ modelProvider: 'openai' }).sourceId, 'default');
  assert.equal(store.sourcePublicInfo()[0].status, 'ready');

  const starts = [];
  const parser = new SessionParser({ id: 'session', onStart: event => starts.push(event) });
  parser.accept({ type: 'session_meta', payload: { id: 'session', model_provider: 'work' } });
  parser.accept({ type: 'event_msg', timestamp: Date.now(), payload: { type: 'task_started', turn_id: 'turn' } });
  assert.equal(starts[0].modelProvider, 'work');

  const ledger = new UsageLedger(dataDir), now = Date.now();
  ledger.append(source.accountId + '-USD', { id: 'work-root', ts: now, sourceId: 'work', sourceName: '工作中转站', tokens: 100, cost: 1.25, costState: 'estimated', currency: 'USD' });
  ledger.append(source.accountId + '-USD', { id: 'work-child', ts: now, sourceId: 'work', sourceName: '工作中转站', isSubagent: true, tokens: 40, cost: 0.5, costState: 'estimated', currency: 'USD' });
  ledger.append('aaaaaaaaaaaaaaaaaaaaaaaa-USD', { id: 'personal-root', ts: now, sourceId: 'default', sourceName: '当前 API', tokens: 200, cost: 2, costState: 'observed', currency: 'USD' });
  const overall = ledger.recordsAll(store.sourcePublicInfo(), now);
  assert.equal(overall.all.tokens, 300);
  assert.deepEqual(overall.all.amounts, [{ currency: 'USD', total: 3.25 }]);
  assert.equal(overall.sources.find(item => item.id === 'work').all.tokens, 100);
  assert.equal(overall.sources.find(item => item.id === 'default').all.tokens, 200);
  console.log('multi-source config, classification, and aggregate accounting passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
