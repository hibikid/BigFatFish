import { parentPort, workerData } from 'node:worker_threads';
import { SessionReader } from './session-monitor.mjs';

let enabled = workerData.enabled !== false, initial = true, events = [], rootEnds = [];
let recoveryReported = false;
const reader = new SessionReader({ ...workerData,
  onStart: meta => events.push({ type: 'start', meta }),
  onEnd: meta => events.push({ type: 'end', meta }),
  onUpdate: meta => events.push({ type: 'update', meta }),
  onRateLimits: snapshot => events.push({ type: 'rate-limits', snapshot }),
  onRateLimitContext: context => events.push({ type: 'rate-limit-context', context }),
});
function tick() {
  events = [];
  // Subscription rate-limit snapshots are a separate, local read-only feature.
  // Keep collecting them even if a user disables token/cost turn monitoring.
  reader.tick(initial); initial = false;
  const emitted = enabled ? events : events.filter(event => event.type === 'rate-limits' || event.type === 'rate-limit-context');
  // Child records precede root endings discovered in the same scan, so the
  // final estimate can include each child's independently recorded usage.
  if (!enabled) rootEnds = [];
  rootEnds.push(...emitted.filter(x => x.type === 'end' && !x.meta.isSubagent));
  const endingIds = new Set(emitted.filter(x => x.type === 'end').map(x => x.meta.id));
  const latestUpdates = new Map(emitted.filter(x => x.type === 'update').map(x => [x.meta.id, x]));
  const rest = emitted.filter(x => (x.type !== 'end' || x.meta.isSubagent) &&
    (x.type !== 'update' || (!endingIds.has(x.meta.id) && latestUpdates.get(x.meta.id) === x)));
  const status = reader.status();
  const recoveryComplete = enabled && !initial && !status.error && !status.catchingUp && !recoveryReported;
  if (recoveryComplete) recoveryReported = true;
  parentPort.postMessage({ status, recoveryComplete, events: status.catchingUp ? rest : [...rest, ...rootEnds] });
  if (!status.catchingUp) rootEnds = [];
  else if (enabled) setImmediate(tick);
}
parentPort.on('message', state => { enabled = state.enabled !== false; reader.defaultModel = state.defaultModel || ''; });
tick();
setInterval(tick, workerData.intervalMs).unref();
