(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleUsageClient = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function create({ fetchImpl, acceptsSubscription, shouldNotify, storage, now = Date.now, timeoutMs = 25000 } = {}) {
    let seq = 0, id = '', aligned = false, turnJob = null;
    const startedAt = now();
    try {
      const saved = Number(storage?.getItem('dshw-last-seq') || 0);
      if (Number.isFinite(saved) && saved >= 0) seq = saved;
      id = storage?.getItem('dshw-last-turn-id') || '';
    } catch {}
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
    function overview({ manual = false, getSubscription = () => null, onBalanceFallback = () => {} } = {}) {
      return deadline(async signal => {
        let next;
        try { next = await request('/api/subscription-rate-limits', { signal }); }
        catch { next = undefined; }
        if (acceptsSubscription(next)) return { kind: 'subscription', data: next };
        if (next === undefined) {
          const current = getSubscription();
          if (acceptsSubscription(current)) return { kind: 'retained-subscription', data: current };
        }
        onBalanceFallback();
        return { kind: 'balance', data: await request('/dsh-whale/balance.json' + (manual ? '?refresh=1' : ''), { signal }) };
      });
    }
    function pollTurn() {
      // Only the first caller consumes a completion; joining its result would
      // make each caller independently play the same sound and show a bubble.
      if (turnJob) return Promise.resolve({ record: null, fresh: false });
      turnJob = request('/dsh-whale/last-turn.json').then(record => {
        if (!record?.ok || typeof record.seq !== 'number' || record.seq < seq) return { record: null, fresh: false };
        const fresh = shouldNotify(record, { seq, id, firstPoll: !aligned, startedAt });
        aligned = true; seq = record.seq;
        if (record.id) id = record.id;
        try { storage?.setItem('dshw-last-seq', String(seq)); storage?.setItem('dshw-last-turn-id', id); } catch {}
        return { record, fresh };
      }).finally(() => { turnJob = null; });
      return turnJob;
    }
    const read = url => request(url);
    const subscription = () => read('/api/subscription-rate-limits');
    const records = () => read('/dsh-whale/usage-records.json');
    const settings = () => read('/dsh-whale/usage-settings.json');
    function saveSettings(patch) {
      return request('/dsh-whale/usage-settings.json', { method: 'PUT', body: patch || {} }).then(result => {
        if (result?.ok !== true) throw new Error(result?.error || '保存未完成，请重试');
        return result;
      });
    }
    return Object.freeze({ overview, subscription, records, settings, saveSettings, pollTurn });
  }
  return Object.freeze({ create });
});
