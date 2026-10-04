(function (host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else host.WhaleUsagePresentation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // A subscription shows while any of its windows is valid; a window that has
  // reset says so instead of a share.
  function hasSubscription(value) {
    return !!(value && value.available !== false && [value.fiveHour, value.sevenDay].some(window =>
      window && !window.reset && Number.isFinite(Number(window.remainingPercent))));
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
    const share = (name, window) => window?.reset ? name + '已重置' : name + '剩余' + quotaPercent(window);
    const sevenDayReset = '7天重置 ' + (quotaResetTime(value?.sevenDay, true) || '--');
    return { fiveHour: share('5小时', value?.fiveHour), sevenDay: share('7天', value?.sevenDay),
      reset: value?.fiveHour?.reset ? sevenDayReset : '5小时重置' + (quotaResetTime(value?.fiveHour) || '--:--'), sevenDayReset };
  }
  function hasBalance(value) {
    return !!value?.balanceText || value?.balance !== null && value?.balance !== undefined;
  }
  function balanceAmount(value, formatMoney) {
    return value.balanceText || (!hasBalance(value) ? value.status === 'error' ? '--' : '…' : formatMoney(value.balance, value.currency || 'USD'));
  }
  function spentToday(value, formatMoney) {
    return '今日 ' + (value.todayUsage != null ? formatMoney(value.todayUsage, value.currency || 'USD') : '--');
  }
  function balanceRow(value, type, { firstSubscriptionQuota = false, formatMoney } = {}) {
    if (firstSubscriptionQuota && hasSubscription(value.subscription)) {
      const lines = quotaLines(value.subscription);
      return type === 'balance' ? lines.fiveHour + '\n' + lines.sevenDay : lines.reset;
    }
    return type === 'balance' ? balanceAmount(value, formatMoney) : spentToday(value, formatMoney);
  }
  function balanceBubble(value, { firstSubscriptionQuota = false, formatMoney } = {}) {
    if (firstSubscriptionQuota && hasSubscription(value.subscription)) {
      const lines = quotaLines(value.subscription);
      return { amount: lines.fiveHour + '\n' + lines.sevenDay, hint: lines.reset, preLine: true };
    }
    return { amount: balanceAmount(value, formatMoney),
      hint: value.status === 'error' ? (value.message || '获取失败 · 点击重试').slice(0, 20) : !hasBalance(value) ? '加载中…' :
        spentToday(value, formatMoney), preLine: false };
  }
  function taskBubble(notice, formatMoney) {
    if (hasSubscription(notice.subscriptionRateLimits)) return { kind: 'subscription', ...quotaLines(notice.subscriptionRateLimits) };
    return { kind: 'cost', label: notice.label, note: notice.note,
      amount: notice.amount === null ? notice.costState === 'pending' ? '待记账' : '金额未知' : formatMoney(notice.amount, notice.currency),
      hint: (notice.tokens == null ? '' : notice.tokens.toLocaleString('en-US') + ' tokens · ') +
        (notice.costState === 'pending' ? '等待账单确认' : notice.costState === 'unknown' ? '以服务商账单为准' :
          notice.costState === 'estimated' ? '配置价格估算' : '同密钥区间观测') };
  }
  return Object.freeze({ hasBalance, hasSubscription, quotaLines, balanceRow, balanceBubble, taskBubble });
});
