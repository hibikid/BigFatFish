// 额度管理: every account the pet knows, where its key is kept and how its
// quota is read. Each change saves at once; the pet picks it up without a reload.
const METHODS = [['auto', '自动识别'], ['billing', '兼容账单接口（常见中转站）'], ['newapi', 'New API / One API 密钥额度'], ['deepseek', 'DeepSeek 账户余额'],
  ['source-usage', '查询链接（日用量与额度）'], ['custom-json', '自定义 JSON 余额接口']];
const KEY_SOURCES = { keychain: '密钥已存入钥匙串', environment: '密钥来自环境变量', 'codex-config': '使用 Codex 配置里的密钥', session: '密钥只保留到挂件退出' };
const KEY_PROBLEMS = { 'keychain-missing': '钥匙串里没有这个账户的密钥', 'keychain-unavailable': '钥匙串暂时不可用', 'key-unavailable': '缺少密钥' };
const PRICE_FIELDS = [['input', '输入'], ['cachedInput', '缓存命中'], ['output', '输出'], ['cacheWrite', '缓存写入']];

export function createQuotaManager({ dialog, request, money, presentation, toast, onChanged }) {
  const body = dialog.querySelector('[data-quota-body]'), error = dialog.querySelector('[data-quota-error]');
  const currency = dialog.querySelector('[data-quota-currency]');
  let accounts = null, quotas = null, editing = '', adding = false, busy = false;

  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, className, action) => {
    const node = element('button', className || 'quiet', text);
    node.type = 'button';
    node.addEventListener('click', () => run(action, node));
    return node;
  };
  const field = (label, input, hint) => {
    const wrap = element('label', '', label);
    wrap.append(input);
    if (hint) wrap.append(element('small', '', hint));
    return wrap;
  };
  const input = (name, value = '', { type = 'text', placeholder = '' } = {}) => {
    const node = element('input');
    Object.assign(node, { name, type, value: value ?? '', placeholder, autocomplete: type === 'password' ? 'new-password' : 'off' });
    return node;
  };
  const select = (name, options, value) => {
    const node = element('select');
    node.name = name;
    for (const [option, label] of options) node.append(Object.assign(element('option', '', label), { value: option, selected: option === value }));
    return node;
  };
  const format = (amount, unit) => money.convert(amount, unit) === null ? (unit === 'CNY' ? '¥' : unit === 'USD' ? '$' : unit + ' ') + amount.toFixed(2) : money.formatMoney(amount, unit);
  function showError(message) { error.textContent = message || ''; error.hidden = !message; }
  // One action at a time; its own message is the answer when it is refused.
  async function run(action, control) {
    if (busy) return;
    busy = true; showError('');
    if (control) control.disabled = true;
    try { await action(); }
    catch (failure) { showError(failure?.message || '操作未完成，请重试'); }
    finally { busy = false; if (control?.isConnected) control.disabled = false; }
  }
  async function load() {
    [accounts, quotas] = await Promise.all([request('/api/quota-accounts'), request('/api/quotas')]);
    render();
  }
  async function changed() {
    await load();
    onChanged();
  }

  function quotaLines(view) {
    if (!view) return [];
    const options = { formatMoney: format, now: Date.now() };
    const lines = presentation.rows(view, options).map(row => row.label + ' ' + (/%$/.test(row.value) ? '剩余 ' : '') + row.value + (row.note ? ' · ' + row.note : ''));
    const pace = presentation.paceText(view, options), status = presentation.status(view);
    return [...lines, ...(pace ? [pace] : []), ...(status ? [status] : [])];
  }
  function line(text, warn) { return element('p', 'quota-line' + (warn ? ' warn' : ''), text); }
  function quotaOf(id) { return quotas?.accounts.find(account => account.id === id) || null; }

  function subscriptionCard(id, title, details, controls) {
    const card = element('article', 'quota-card'), head = element('div', 'quota-card-head');
    card.dataset.accountId = id;
    head.append(element('strong', '', title));
    card.append(head, ...details);
    if (controls.length) {
      const actions = element('div', 'quota-actions');
      actions.append(...controls);
      card.append(actions);
    }
    return card;
  }
  function renderSubscriptions() {
    const section = element('section', 'quota-section');
    section.append(element('h3', '', '订阅'));
    const codex = quotaOf('codex'), claude = quotaOf('claude'), integration = accounts.claude || {};
    const updated = view => view?.observedAt ? '更新于 ' + presentation.moment(view.observedAt, Date.now()) : '';
    const monitor = Object.assign(element('input'), { type: 'checkbox', checked: accounts.monitorSessions });
    monitor.addEventListener('change', () => run(async () => {
      await request('/api/quota-settings', 'PUT', { monitorSessions: monitor.checked });
      await changed();
    }, monitor));
    const toggle = element('label', 'check');
    toggle.append(monitor, document.createTextNode('读取本机 Codex 会话记录（只读用量与额度，不读对话内容）'));
    const codexLines = codex?.available ? quotaLines(codex).map(text => line(text)) : [line('还没有订阅额度：用 ChatGPT 登录的 Codex 运行一次后出现')];
    section.append(subscriptionCard('codex', codex ? presentation.title(codex) : 'Codex 订阅',
      [...codexLines, line(['来自本机 Codex 会话记录', updated(codex)].filter(Boolean).join(' · '))], [toggle]));
    const claudeLines = claude?.available ? quotaLines(claude).map(text => line(text)) : [];
    const connected = integration.installed ? '已接入 Claude Code' : integration.statusLine === 'other' ? 'Claude Code 已有别的状态栏命令，未接入' : '未接入 Claude Code';
    const action = integration.installed ? button('移除接入', 'quiet', async () => { await request('/api/claude/integration', 'POST', { action: 'uninstall' }); toast('已移除 Claude Code 接入'); await changed(); }) :
      button('接入 Claude Code', 'primary', async () => { await request('/api/claude/integration', 'POST', { action: 'install' }); toast('已接入，Claude Code 下次刷新状态栏时开始显示额度'); await changed(); });
    section.append(subscriptionCard('claude', 'Claude 订阅', [...claudeLines, line([connected, updated(claude)].filter(Boolean).join(' · '), !integration.installed)], [action]));
    return section;
  }

  function uses(account) {
    const tags = account.codexProviders.map(provider => 'Codex：' + provider);
    if (account.pet) tags.push('大肥鱼');
    return tags;
  }
  function keyLine(account) {
    if (account.keyStatus === 'ready') return line(KEY_SOURCES[account.keyStorage] || '密钥已就绪');
    return line(KEY_PROBLEMS[account.keyStatus] || '缺少密钥', true);
  }
  function keyForm(account) {
    const form = element('form', 'quota-inline'), secret = input('key', '', { type: 'password', placeholder: '粘贴这个账户的 API 密钥' });
    form.append(secret, button('保存密钥', 'primary', async () => {
      if (!secret.value.trim()) throw new Error('请先粘贴密钥');
      await request('/api/quota-accounts/' + account.id, 'PUT', { key: secret.value });
      toast('密钥已保存'); await changed();
    }));
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function priceRows(prices) {
    const table = element('div', 'quota-prices');
    const add = (model = '', values = {}) => {
      const row = element('div', 'quota-price-row');
      row.append(input('model', model, { placeholder: '模型名称，与 Codex 记录一致' }),
        ...PRICE_FIELDS.map(([key, label]) => Object.assign(input(key, values[key] ?? '', { type: 'number', placeholder: label }), { min: 0, step: 'any', title: label + '（每百万 token）' })),
        Object.assign(button('删除', 'quiet', () => row.remove()), { title: '删除这行价格' }));
      table.append(row);
    };
    for (const [model, values] of Object.entries(prices)) add(model, values);
    const more = button('添加模型价格', 'quiet', () => add());
    return { table, more, read() {
      const result = {};
      for (const row of table.querySelectorAll('.quota-price-row')) {
        const values = Object.fromEntries([...row.querySelectorAll('input')].map(node => [node.name, node.value.trim()]));
        if (!values.model && PRICE_FIELDS.every(([key]) => !values[key])) continue;
        if (!values.model) throw new Error('请填写价格对应的模型名称');
        result[values.model] = Object.fromEntries(PRICE_FIELDS.filter(([key]) => values[key] !== '').map(([key]) => [key, Number(values[key])]));
      }
      return result;
    } };
  }
  function editForm(account) {
    const form = element('form', 'quota-edit');
    const name = input('name', account.name), key = input('key', '', { type: 'password', placeholder: account.keyStatus === 'ready' ? '已保存，留空不变' : '粘贴这个账户的 API 密钥' });
    const unit = select('currency', [['USD', '美元 USD'], ['CNY', '人民币 CNY']].concat(['USD', 'CNY'].includes(account.currency) ? [] : [[account.currency, account.currency]]), account.currency);
    const prices = priceRows(account.prices);
    const grid = element('div', 'field-grid');
    grid.append(field('名称', name), field('密钥', key, '只存入 macOS 钥匙串，不写进设置文件'), field('币种', unit, '余额接口没有说明币种时，按这个币种记账'));
    const advanced = element('details');
    advanced.append(element('summary', '', '高级：查询方式与 Codex 归属'));
    const method = select('method', METHODS, account.balance.method), queryUrl = input('queryUrl', account.balance.queryUrl, { placeholder: account.endpoint.replace(/\/+$/, '') + '/usage' });
    const balancePath = input('balancePath', account.balance.balancePath, { placeholder: '/api/user/balance' }), balanceField = input('balanceField', account.balance.balanceField);
    const usedField = input('usedField', account.balance.usedField), balanceScale = input('balanceScale', account.balance.balanceScale, { type: 'number' });
    const divisor = input('billingUsageDivisor', account.balance.billingUsageDivisor, { type: 'number' }), perUnit = input('quotaPerUnit', account.balance.quotaPerUnit, { type: 'number' });
    const providers = input('codexProviders', account.codexProviders.join(', '), { placeholder: '例如 OpenAI' });
    const dashboard = input('dashboardUrl', account.dashboardUrl, { type: 'url', placeholder: '账单页面，可留空' });
    const advancedGrid = element('div', 'field-grid');
    advancedGrid.append(field('查询方式', method), field('查询链接', queryUrl, '与 API 地址同域；返回 daily_usage 与 rate_limits'),
      field('余额路径', balancePath, '自定义 JSON 接口使用'), field('金额字段', balanceField), field('已用字段', usedField), field('余额系数', balanceScale),
      field('账单用量换算', divisor), field('额度单位换算', perUnit), field('Codex 的 provider 名称', providers, '会话日志里这些 provider 的任务算作这个账户'), field('账单页面', dashboard));
    advanced.append(advancedGrid);
    const actions = element('div', 'quota-actions');
    actions.append(button('保存', 'primary', async () => {
      const patch = { name: name.value, currency: unit.value, prices: prices.read(), dashboardUrl: dashboard.value.trim(),
        codexProviders: providers.value.split(/[,，\s]+/).map(item => item.trim()).filter(Boolean),
        balance: { method: method.value, queryUrl: queryUrl.value.trim(), balancePath: balancePath.value.trim(), balanceField: balanceField.value.trim(),
          usedField: usedField.value.trim(), balanceScale: balanceScale.value, billingUsageDivisor: divisor.value, quotaPerUnit: perUnit.value } };
      if (key.value.trim()) patch.key = key.value;
      await request('/api/quota-accounts/' + account.id, 'PUT', patch);
      editing = ''; toast('已保存'); await changed();
    }), button('取消', 'quiet', () => { editing = ''; render(); }));
    form.append(grid, element('p', 'quota-subhead', '每百万 token 价格（用于估算 Codex 每轮花费）'), prices.table, prices.more, advanced, actions);
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function apiCard(account) {
    const card = element('article', 'quota-card'), head = element('div', 'quota-card-head'), view = quotaOf(account.id);
    card.dataset.accountId = account.id;
    head.append(element('strong', '', account.name), element('span', 'quota-host', account.host), ...uses(account).map(tag => element('span', 'quota-tag', tag)));
    card.append(head, ...quotaLines(view?.available || view?.error ? view : null).map(text => line(text)), keyLine(account));
    if (account.keyStatus !== 'ready' && editing !== account.id) card.append(keyForm(account));
    if (editing === account.id) card.append(editForm(account));
    else {
      const actions = element('div', 'quota-actions');
      actions.append(button('立即查询', 'quiet', async () => {
        const result = await request('/api/quota-accounts/' + account.id + '/query', 'POST');
        toast(result.quota?.error ? '查询失败：' + result.quota.error : '已更新'); await changed();
      }), button('编辑', 'quiet', () => { editing = account.id; adding = false; render(); }),
      button('隐藏', 'quiet', async () => { await request('/api/quota-accounts/' + account.id, 'PUT', { hidden: true }); await changed(); }));
      card.append(actions);
    }
    return card;
  }
  function addForm() {
    const form = element('form', 'quota-card quota-add'), name = input('name', '', { placeholder: '例如 Kimi、公司中转站' });
    const endpoint = input('endpoint', '', { type: 'url', placeholder: 'https://api.example.com/v1' }), key = input('key', '', { type: 'password', placeholder: '粘贴 API 密钥' });
    const grid = element('div', 'field-grid');
    grid.append(field('名称', name), field('API 地址', endpoint), field('密钥', key, '只存入 macOS 钥匙串'));
    const actions = element('div', 'quota-actions');
    actions.append(button('保存并查询', 'primary', async () => {
      const result = await request('/api/quota-accounts', 'POST', { name: name.value, endpoint: endpoint.value.trim(), key: key.value });
      adding = false;
      toast(result.quota?.error ? '已保存；查询失败：' + result.quota.error : '已保存，额度已更新');
      await changed();
    }), button('取消', 'quiet', () => { adding = false; render(); }));
    form.append(element('strong', '', '添加 API 账户'), grid, actions);
    form.addEventListener('submit', event => event.preventDefault());
    return form;
  }
  function renderAccounts() {
    const section = element('section', 'quota-section'), visible = accounts.accounts.filter(account => !account.hidden), hidden = accounts.accounts.filter(account => account.hidden);
    section.append(element('h3', '', 'API 账户'));
    if (!visible.length) section.append(line('还没有 API 账户。Codex 配置里的 provider 会自动出现；也可以手动添加。'));
    section.append(...visible.map(apiCard));
    section.append(adding ? addForm() : button('添加 API 账户', 'quiet quota-add-button', () => { adding = true; editing = ''; render(); }));
    if (hidden.length) {
      const folded = element('details', 'quota-hidden');
      folded.append(element('summary', '', '已隐藏的账户（' + hidden.length + '）'));
      for (const account of hidden) {
        const row = element('div', 'quota-hidden-row');
        row.append(element('span', '', account.name + ' · ' + account.host),
          button('显示', 'quiet', async () => { await request('/api/quota-accounts/' + account.id, 'PUT', { hidden: false }); await changed(); }));
        folded.append(row);
      }
      section.append(folded);
    }
    return section;
  }
  function render() {
    if (!accounts) return;
    const scroll = body.scrollTop;
    body.replaceChildren(renderSubscriptions(), renderAccounts());
    if (accounts.error) showError(accounts.error);
    body.scrollTop = scroll;
  }

  currency.addEventListener('change', () => run(async () => {
    await money.setDisplayCurrency(currency.value);
    render(); onChanged();
  }, currency));
  money.onChange(state => { currency.value = state.displayCurrency; if (dialog.open) render(); });
  dialog.querySelector('[data-quota-close]').addEventListener('click', () => dialog.close());
  return Object.freeze({
    async open() {
      editing = ''; adding = false; showError('');
      if (!dialog.open) dialog.showModal();
      try { await load(); } catch (failure) { showError(failure?.message || '额度账户暂时无法读取'); }
    },
  });
}
