const decimals = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const costDecimals = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function formatChatCost({ min, max, currency }) {
  return (currency === 'USD' ? '$' : '¥') + costDecimals.format((min + max) / 2);
}
function money(amount, currency) {
  const symbol = currency === 'USD' ? '$' : '¥';
  return amount > 0 && amount < 0.000001 ? '<' + symbol + '0.000001' : symbol + decimals.format(amount);
}

export function createChatBilling({ client, root }) {
  const spent = root.querySelector('[data-chat-spent]'), balance = root.querySelector('[data-chat-balance]');
  const refresh = root.querySelector('button');
  let revision = 0;
  function render(value) {
    const unknown = value.unknown + value.pending;
    if (value.ledgerError || !value.supported || !value.configured) spent.textContent = '本地30天 --';
    else if (unknown && !value.recorded) spent.textContent = '本地30天待核';
    else {
      const amount = formatChatCost(value);
      spent.textContent = (unknown ? '本地30天已计约 ' : '本地30天约 ') + amount;
    }
    spent.title = value.ledgerError || (value.supported ? '当前会话密钥近30天的本地用量估算，含可恢复的历史记录；不是官网账号总消费。' +
      (unknown ? '另有 ' + unknown + ' 次调用尚无完整计费数据。' : '') : '目前仅支持 DeepSeek 官方会话 API 计费');
    balance.textContent = value.balance ? (value.balanceStale ? '余额（旧）' : '余额 ') + money(value.balance.amount, value.balance.currency) : '余额 --';
    balance.title = value.balanceError || (value.balance ? 'DeepSeek 账号余额，含充值及有效赠金；更新于 ' + new Date(value.balance.updatedAt).toLocaleString() : '尚未查询余额');
  }
  async function update({ force = false } = {}) {
    const current = ++revision;
    refresh.disabled = true;
    try {
      const result = await client.billing(force);
      if (current === revision) render(result.billing);
    } catch {
      if (current === revision) { spent.textContent = '本地30天 --'; balance.textContent = '余额 --'; spent.title = balance.title = '会话计费数据读取失败，请刷新'; }
    } finally { if (current === revision) refresh.disabled = false; }
  }
  refresh.addEventListener('click', () => update({ force: true }));
  return Object.freeze({ refresh: update, reset() { revision++; spent.textContent = '本地30天 --'; balance.textContent = '余额 --'; spent.title = ''; balance.title = ''; refresh.disabled = false; } });
}
