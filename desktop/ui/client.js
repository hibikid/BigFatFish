(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let currentConfig = null, toastTimer, sourceInfo = new Map();
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
  window.whaleToast = toast;
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    const result = await response.json();
    if (result.ok === false) throw new Error(result.error || '操作未完成');
    return result;
  }
  const form = $('settings-form'), sourceList = $('source-list');
  const element = name => form.elements.namedItem(name);
  function nextSourceId(sources) {
    const used = new Set(sources.map(item => item.id));
    for (let n = 1; n <= 99; n++) { const id = 'source' + n; if (!used.has(id)) return id; }
    return 'source' + Date.now().toString(36).slice(-5);
  }
  function nextKeyRef() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
    return 'whale' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function sourceStatus(source) {
    const info = sourceInfo.get(source.id);
    if (!info) return { text: '保存后读取配置文件并验证', kind: '' };
    const base = '已识别 ' + (info.provider || 'provider') + (info.model ? ' · ' + info.model : '');
    if (info.status === 'ready') return { text: base + (info.keyMode === 'keychain' ? ' · 钥匙串密钥已就绪' : ' · 可读环境变量'), kind: 'ready' };
    if (info.status === 'keychain-missing') return { text: base + ' · 钥匙串中尚未保存密钥（仍统计 Token）', kind: 'warn' };
    if (info.status === 'keychain-unavailable') return { text: base + ' · macOS 钥匙串当前不可用（仍统计 Token）', kind: 'warn' };
    if (info.status === 'key-unavailable') return { text: base + ' · 小鲸鱼未读到 ' + (info.keyEnv || '密钥变量') + '（仍统计 Token）', kind: 'warn' };
    return { text: '配置异常：' + info.status, kind: 'warn' };
  }
  function sourceField(label, field, value, placeholder, type = 'text') {
    const wrap = document.createElement('label'); wrap.textContent = label;
    const input = document.createElement('input'); input.type = type; input.dataset.sourceField = field; input.value = value || ''; input.placeholder = placeholder || '';
    if (field === 'keyEnv' || field === 'secret') input.autocomplete = 'off';
    wrap.appendChild(input); return wrap;
  }
  function sourceModeField(source) {
    const wrap = document.createElement('label'); wrap.textContent = '密钥来源';
    const select = document.createElement('select'); select.dataset.sourceField = 'keyMode';
    for (const [value, label] of [['keychain', 'macOS 钥匙串（推荐）'], ['environment', '环境变量（兼容）']]) {
      const option = document.createElement('option'); option.value = value; option.textContent = label; select.appendChild(option);
    }
    select.value = source.keyMode || (source.keyEnv ? 'environment' : 'keychain'); wrap.appendChild(select); return wrap;
  }
  function updateKeyFields(card) {
    const keychain = card.querySelector('[data-source-field="keyMode"]').value === 'keychain';
    card.querySelector('[data-source-keychain]').hidden = !keychain;
    card.querySelector('[data-source-environment]').hidden = keychain;
  }
  function sourceCard(source) {
    const card = document.createElement('section'); card.className = 'source-card'; card.dataset.sourceId = source.id;
    card.dataset.sourceKeyRef = source.keyRef || nextKeyRef();
    const head = document.createElement('div'); head.className = 'source-head';
    const title = document.createElement('span'); title.textContent = 'Codex API 配置源'; head.appendChild(title);
    const status = sourceStatus(source), state = document.createElement('span'); state.className = 'source-status ' + status.kind; state.textContent = status.text; state.title = status.text; head.appendChild(state);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'source-remove'; remove.textContent = '移除'; remove.addEventListener('click', () => card.remove()); head.appendChild(remove);
    card.appendChild(head);
    const grid = document.createElement('div'); grid.className = 'field-grid';
    grid.appendChild(sourceField('名称', 'name', source.name, '例如 工作中转站'));
    grid.appendChild(sourceField('配置文件路径', 'configPath', source.configPath, '~/.codex/work.config.toml'));
    const query = sourceField('查询链接（可选）', 'queryUrl', source.queryUrl, '留空：使用 TOML 的 API 地址自动探测', 'url');
    const queryHint = document.createElement('small'); queryHint.textContent = '填写时直接请求该完整链接；必须与 TOML 的 API 地址同域。认证和静态请求头从 TOML 自动读取。'; query.appendChild(queryHint); grid.appendChild(query);
    const mode = sourceModeField(source); grid.appendChild(mode);
    const keychain = sourceField('直接输入 / 更新密钥', 'secret', '', '留空则继续使用已保存的钥匙串密钥', 'password'); keychain.dataset.sourceKeychain = ''; keychain.querySelector('input').autocomplete = 'new-password';
    const keychainHint = document.createElement('small'); keychainHint.textContent = '保存时使用 macOS 钥匙串加密；密钥不会写进小鲸鱼设置、日志或界面。'; keychain.appendChild(keychainHint); grid.appendChild(keychain);
    const environment = sourceField('密钥环境变量名', 'keyEnv', source.keyEnv, '例如 WORK_CODEX_API_KEY'); environment.dataset.sourceEnvironment = '';
    const environmentHint = document.createElement('small'); environmentHint.textContent = '兼容已有方案；该变量必须在小鲸鱼的 LaunchAgent 环境中可见。'; environment.appendChild(environmentHint); grid.appendChild(environment);
    const hint = document.createElement('label'); hint.textContent = '会话识别';
    const value = document.createElement('input'); value.type = 'text'; value.value = sourceInfo.get(source.id)?.provider || '保存后从配置文件的 model_provider 自动读取'; value.disabled = true; hint.appendChild(value); grid.appendChild(hint);
    card.appendChild(grid); mode.querySelector('select').addEventListener('change', () => updateKeyFields(card)); updateKeyFields(card); return card;
  }
  function renderSources(sources) {
    sourceList.replaceChildren();
    if (!sources.length) {
      const empty = document.createElement('p'); empty.className = 'help'; empty.textContent = '尚未添加额外 API 数据源；当前 API 与个人订阅显示保持原有行为。'; sourceList.appendChild(empty); return;
    }
    sources.forEach(source => sourceList.appendChild(sourceCard(source)));
  }
  function readSourceEntries() {
    return [...sourceList.querySelectorAll('.source-card')].map(card => {
      const field = name => card.querySelector('[data-source-field="' + name + '"]').value.trim();
      const keyMode = field('keyMode');
      return { source: { id: card.dataset.sourceId, name: field('name'), configPath: field('configPath'), keyMode,
        keyEnv: keyMode === 'environment' ? field('keyEnv') : '', keyRef: card.dataset.sourceKeyRef, queryUrl: field('queryUrl'), enabled: true }, secret: keyMode === 'keychain' ? field('secret') : '' };
    });
  }
  const readSources = () => readSourceEntries().map(entry => entry.source);
  $('add-source').addEventListener('click', () => {
    const sources = readSources();
    const source = { id: nextSourceId(sources), name: '新的 API 数据源', configPath: '', keyMode: 'keychain', keyEnv: '', keyRef: nextKeyRef(), queryUrl: '', enabled: true };
    const empty = sourceList.querySelector('.help'); if (empty) empty.remove(); sourceList.appendChild(sourceCard(source));
  });
  async function openSettings() {
    try {
      const info = await api('/api/config'); currentConfig = info.settings;
      sourceInfo = new Map((info.sources || []).map(item => [item.id, item]));
      for (const key of ['provider', 'baseUrl', 'keyEnv', 'profile', 'projectDir', 'currency', 'dashboardUrl', 'balancePath', 'balanceField', 'usedField', 'balanceScale', 'billingUsageDivisor', 'quotaPerUnit']) element(key).value = currentConfig[key] ?? '';
      element('baseUrl').placeholder = info.baseUrl;
      element('monitorSessions').checked = currentConfig.monitorSessions;
      const model = info.model || '';
      element('priceModel').value = model;
      const prices = currentConfig.models[model] || {};
      for (const [name, key] of [['priceInput', 'input'], ['priceCached', 'cachedInput'], ['priceOutput', 'output'], ['priceWrite', 'cacheWrite']]) element(name).value = prices[key] ?? '';
      renderSources(currentConfig.sources || []);
      $('settings-error').hidden = true; $('settings-dialog').showModal();
    } catch (error) { toast(error.message); }
  }
  window.addEventListener('whale-open-settings', openSettings);
  for (const id of ['close-settings', 'cancel-settings']) $(id).addEventListener('click', () => $('settings-dialog').close());
  form.addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const settings = structuredClone(currentConfig);
      for (const key of ['provider', 'baseUrl', 'keyEnv', 'profile', 'projectDir', 'currency', 'dashboardUrl', 'balancePath', 'balanceField', 'usedField']) settings[key] = element(key).value.trim();
      for (const key of ['balanceScale', 'billingUsageDivisor', 'quotaPerUnit']) settings[key] = Number(element(key).value);
      settings.monitorSessions = element('monitorSessions').checked;
      const entries = readSourceEntries();
      settings.sources = entries.map(entry => entry.source);
      const sourceSecrets = Object.fromEntries(entries.filter(entry => entry.secret).map(entry => [entry.source.id, entry.secret]));
      const fields = ['priceInput', 'priceCached', 'priceOutput'];
      const hasPrice = fields.some(key => element(key).value !== '');
      const model = element('priceModel').value.trim();
      if (hasPrice) {
        if (!model || fields.some(key => element(key).value === '')) throw new Error('请完整填写模型名称、输入、缓存命中和输出价格');
        const prices = { input: Number(element('priceInput').value), cachedInput: Number(element('priceCached').value), output: Number(element('priceOutput').value) };
        if (element('priceWrite').value !== '') prices.cacheWrite = Number(element('priceWrite').value);
        settings.models[model] = prices;
      } else if (model) delete settings.models[model];
      await api('/api/config', 'PUT', { ...settings, sourceSecrets }); location.reload();
    } catch (error) { $('settings-error').hidden = false; $('settings-error').textContent = error.message; }
  });
})();
