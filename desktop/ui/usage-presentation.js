(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleUsagePresentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  function quotaText(value) {
    if (!value || !Number.isFinite(Number(value.limit)) || !Number.isFinite(Number(value.used))) return '';
    const formatter = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
    return formatter.format(Number(value.used)) + '/' + formatter.format(Number(value.limit));
  }
  function balance(data) {
    if (!data?.ok) return { state: { status: 'error', message: data?.error ? String(data.error) : '获取失败' } };
    return {
      state: {
        balance: data.unlimited ? Infinity : data.totalBalance == null ? null : Number(data.totalBalance),
        balanceText: quotaText(data.primaryRateLimit), currency: String(data.currency || 'USD'),
        message: '', todayUsage: data.todayUsage !== undefined ? data.todayUsage : null,
        todayUsageSource: data.todayUsageSource || 'ledger', unlimited: !!data.unlimited,
        providerName: data.providerName || '', balanceScope: data.balanceScope || '', stale: !!data.stale, status: 'ok',
      },
      title: (data.providerName || '') + ' · ' + (data.balanceLabel || 'API 可用余额') + (data.stale ? '（上次成功数据）' : ''),
      alt: '当前 API 余额',
    };
  }
  function hasSubscription(value) {
    if (value?.provider === 'Claude') return !!(value.available !== false && [value.fiveHour, value.sevenDay].some(window =>
      window && Number.isFinite(Number(window.remainingPercent))));
    return !!(value && value.available !== false && value.fiveHour && value.sevenDay &&
      Number.isFinite(Number(value.fiveHour.remainingPercent)) && Number.isFinite(Number(value.sevenDay.remainingPercent)));
  }
  function subscriptionFingerprint(value) {
    if (!hasSubscription(value)) return '';
    return [value.provider || 'Codex', value.planType || '', value.fiveHour?.remainingPercent, value.fiveHour?.resetsAt,
      value.sevenDay?.remainingPercent, value.sevenDay?.resetsAt].join('|');
  }
  function subscription(value) {
    if (!hasSubscription(value)) return null;
    const plan = value.planType ? ' · ' + String(value.planType).toUpperCase() : '';
    const provider = value.provider === 'Claude' ? 'Claude' : 'Codex';
    const origin = provider === 'Claude' ? 'Claude 状态栏快照' : '来自本机会话额度快照';
    return { state: { subscription: value, message: '', status: 'ok' },
      title: provider + ' 订阅额度' + plan + '（' + origin + (provider === 'Claude' && value.observedAt ? ' · ' + new Date(value.observedAt).toLocaleString('zh-CN') : '') + '）', alt: provider + ' 订阅额度' };
  }
  function quotaPercent(window) {
    const value = Number(window?.remainingPercent);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) + '%' : '--';
  }
  function quotaResetTime(window, includeDate = false) {
    const ms = Date.parse(window?.resetsAt || '');
    if (!Number.isFinite(ms)) return '';
    return new Intl.DateTimeFormat('zh-CN', { ...(includeDate ? { month: 'numeric', day: 'numeric' } : {}),
      hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
  }
  function quotaLines(value) {
    return { fiveHour: '5小时剩余' + quotaPercent(value?.fiveHour), sevenDay: '7天剩余' + quotaPercent(value?.sevenDay),
      reset: '5小时重置' + (quotaResetTime(value?.fiveHour) || '--:--'),
      sevenDayReset: '7天重置 ' + (quotaResetTime(value?.sevenDay, true) || '--') };
  }
  function hasBalance(value) {
    return !!value?.balanceText || value?.balance !== null && value?.balance !== undefined;
  }
  function balanceAmount(value, formatMoney) {
    return value.balanceText || (!hasBalance(value) ? value.status === 'error' ? '--' : '…' : formatMoney(value.balance, value.currency || 'USD'));
  }
  function observedToday(value, formatMoney) {
    return '今日已观测 ' + (value.todayUsage != null ? formatMoney(value.todayUsage, value.currency || 'USD') : '--');
  }
  function balanceRow(value, type, { firstSubscriptionQuota = false, formatMoney } = {}) {
    if (firstSubscriptionQuota && hasSubscription(value.subscription)) {
      const lines = quotaLines(value.subscription);
      return type === 'balance' ? lines.fiveHour + '\n' + lines.sevenDay : lines.reset;
    }
    return type === 'balance' ? balanceAmount(value, formatMoney) : observedToday(value, formatMoney);
  }
  function balanceBubble(value, { firstSubscriptionQuota = false, formatMoney } = {}) {
    if (firstSubscriptionQuota && hasSubscription(value.subscription)) {
      const lines = quotaLines(value.subscription);
      return { amount: lines.fiveHour + '\n' + lines.sevenDay, hint: lines.reset, preLine: true };
    }
    return { amount: balanceAmount(value, formatMoney),
      hint: value.status === 'error' ? (value.message || '获取失败 · 点击重试').slice(0, 20) : !hasBalance(value) ? '加载中…' :
        observedToday(value, formatMoney), preLine: false };
  }
  function taskBubble(notice, formatMoney) {
    if (hasSubscription(notice.subscriptionRateLimits)) return { kind: 'subscription', ...quotaLines(notice.subscriptionRateLimits) };
    return { kind: 'cost', label: notice.label, note: notice.note,
      amount: notice.amount === null ? notice.costState === 'pending' ? '待记账' : '金额未知' : formatMoney(notice.amount, notice.currency),
      hint: (notice.tokens == null ? '' : notice.tokens.toLocaleString('en-US') + ' tokens · ') +
        (notice.costState === 'pending' ? '等待账单确认' : notice.costState === 'unknown' ? '以服务商账单为准' :
          notice.costState === 'estimated' ? '配置价格估算' : '同密钥区间观测') };
  }
  return Object.freeze({ balance, hasBalance, hasSubscription, subscription, subscriptionFingerprint, quotaLines, balanceRow, balanceBubble, taskBubble });
});
