(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleUsageClient = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const SOURCES = ['codex', 'claude'];
  const QUOTA_URL = { codex: '/api/subscription-rate-limits', claude: '/api/claude/subscription' };
  // Owns the usage source the pet shows. Codex shows its subscription quota,
  // else the API balance; Claude shows only its subscription quota. The source
  // with the latest activity is shown; a manual choice holds until a later one.
  // Every read reports the source it was made for and yields null once another
  // source is shown, so callers never apply one source's data to another.
  function create({ fetchImpl, acceptsSubscription, shouldNotify, storage, now = Date.now, timeoutMs = 25000, onSource = () => {} } = {}) {
    const load = key => { try { return storage?.getItem(key) || ''; } catch { return ''; } };
    const save = (key, value) => { try { storage?.setItem(key, value); } catch {} };
    const forget = key => { try { storage?.removeItem(key); } catch {} };
    let seq = Number(load('dshw-last-seq') || 0), id = load('dshw-last-turn-id'), aligned = false, codexJob = null;
    let claudeId = load('dshw-last-claude-turn-id'), claudeAligned = false, claudeJob = null;
    let current = load('dshw-display-source') === 'claude' ? 'claude' : 'codex';
    let lastActivityAt = Number(load('dshw-display-source-manual-at') || 0), quotaJob = null, snapshotChecked = false;
    if (!Number.isFinite(seq) || seq < 0) seq = 0;
    if (!Number.isFinite(lastActivityAt) || lastActivityAt < 0) lastActivityAt = 0;
    const startedAt = now();

    function show(source) {
      if (source === current) return;
      current = source;
      save('dshw-display-source', source);
      onSource(source);
    }
    function consider(source, timestamp) {
      const at = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
      if (!Number.isFinite(at) || at <= lastActivityAt) return;
      lastActivityAt = at;
      forget('dshw-display-source-manual-at');
      show(source);
    }
    function select(source) {
      if (!SOURCES.includes(source)) return;
      lastActivityAt = now();
      save('dshw-display-source-manual-at', String(lastActivityAt));
      show(source);
    }
    async function request(url, { signal, method = 'GET', body } = {}) {
      const response = await fetchImpl(url, { cache: 'no-store', signal, method,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
      return response.json();
    }
    async function deadline(work) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try { return await work(controller.signal); }
      finally { clearTimeout(timer); }
    }
    const quotaKind = data => acceptsSubscription(data) ? 'subscription' : 'missing';
    // One refresh of the shown source, under one deadline. Codex tries its
    // quota first and falls back to the API balance; a temporary quota failure
    // keeps a quota already on display.
    function overview({ manual = false, getSubscription = () => null, onBalanceFallback = () => {} } = {}) {
      const source = current, shown = () => current === source;
      return deadline(async signal => {
        if (source === 'claude') {
          const data = await request(QUOTA_URL.claude, { signal });
          return shown() ? { source, kind: quotaKind(data), data } : null;
        }
        let next;
        try { next = await request(QUOTA_URL.codex, { signal }); }
        catch { next = undefined; }
        if (!shown()) return null;
        if (acceptsSubscription(next)) return { source, kind: 'subscription', data: next };
        if (next === undefined) {
          const retained = getSubscription();
          if (acceptsSubscription(retained)) return { source, kind: 'retained-subscription', data: retained };
        }
        onBalanceFallback();
        const data = await request('/dsh-whale/balance.json' + (manual ? '?refresh=1' : ''), { signal });
        return shown() ? { source, kind: 'balance', data } : null;
      }).catch(error => {
        if (!shown()) return null;
        throw error;
      });
    }
    // The frequent quota check for the shown source; null when a check is
    // already running, the read failed, or the source changed meanwhile.
    function pollQuota() {
      if (quotaJob) return Promise.resolve(null);
      const source = current;
      quotaJob = request(QUOTA_URL[source])
        .then(data => current === source ? { source, kind: quotaKind(data), data } : null, () => null)
        .finally(() => { quotaJob = null; });
      return quotaJob;
    }
    function pollCodexCompletion() {
      // Only the first caller consumes a completion; joining its result would
      // make each caller independently play the same sound and show a bubble.
      if (codexJob) return Promise.resolve({ record: null, fresh: false });
      codexJob = request('/dsh-whale/last-turn.json').then(record => {
        if (!record?.ok || typeof record.seq !== 'number' || record.seq < seq) return { record: null, fresh: false };
        const fresh = shouldNotify(record, { seq, id, firstPoll: !aligned, startedAt });
        aligned = true; seq = record.seq;
        if (record.id) id = record.id;
        save('dshw-last-seq', String(seq)); save('dshw-last-turn-id', id);
        return { record, fresh };
      }).finally(() => { codexJob = null; });
      return codexJob;
    }
    function pollClaudeCompletion() {
      if (claudeJob) return Promise.resolve({ record: null, fresh: false });
      claudeJob = request('/api/claude/last-turn').then(record => {
        if (!record?.ok || !record.available || !record.id) return { record: null, fresh: false };
        const fresh = record.id !== claudeId && (claudeAligned || record.completedAt >= startedAt);
        claudeAligned = true;
        claudeId = record.id;
        save('dshw-last-claude-turn-id', claudeId);
        return { record, fresh };
      }).finally(() => { claudeJob = null; });
      return claudeJob;
    }
    // Reads both completion streams. Every completion counts as activity for
    // its source; each new one is passed once to that source's handler. At
    // startup the Claude quota snapshot time also counts as Claude activity.
    function pollCompletions({ codex = () => {}, claude = () => {} } = {}) {
      const jobs = [
        pollCodexCompletion().then(({ record, fresh }) => {
          if (record) consider('codex', record.notificationAt || record.ts);
          if (fresh) codex(record);
        }),
        pollClaudeCompletion().then(({ record, fresh }) => {
          if (record) consider('claude', record.completedAt);
          if (fresh) claude(record);
        }),
      ];
      if (!snapshotChecked) {
        snapshotChecked = true;
        jobs.push(request(QUOTA_URL.claude).then(data => { if (acceptsSubscription(data)) consider('claude', data.observedAt); }));
      }
      return Promise.allSettled(jobs).then(() => undefined);
    }
    const records = () => request('/dsh-whale/usage-records.json');
    const settings = () => request('/dsh-whale/usage-settings.json');
    function saveSettings(patch) {
      return request('/dsh-whale/usage-settings.json', { method: 'PUT', body: patch || {} }).then(result => {
        if (result?.ok !== true) throw new Error(result?.error || '保存未完成，请重试');
        return result;
      });
    }
    return Object.freeze({ source: () => current, select, overview, pollQuota, pollCompletions, records, settings, saveSettings });
  }
  return Object.freeze({ create });
});
