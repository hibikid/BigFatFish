import path from 'node:path';
import fs from 'node:fs';
import { readJson, writeJson } from '../paths.mjs';
import { complete, completionUrl } from './provider.mjs';
import { ChatBilling } from './billing.mjs';
import { billingUsage } from './deepseek-pricing.mjs';
import { Conversations } from './conversations.mjs';

const DEFAULTS = { baseUrl: '', model: 'deepseek-flash', persona: '', maxTokens: 1024 };
const KEY_REF = 'whale_chat_api_key_v1';
const NEXT_KEY_REF = KEY_REF + '_next';
const json = (status, value) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(value)) });
function savedAt(file) { try { return fs.statSync(file).mtimeMs; } catch { return Infinity; } }

export class ChatService {
  constructor({ dataDir, secretVault, fetchImpl = fetch, idleMs = 60000, timeoutMs = 180000 }) {
    this.configFile = path.join(dataDir, 'chat-settings.json');
    const stored = readJson(this.configFile, {});
    this.settings = { ...DEFAULTS, ...stored, keyRef: typeof stored.keyRef === 'string' ? stored.keyRef : stored.baseUrl ? KEY_REF : '' };
    this.settingsSavedAt = savedAt(this.configFile);
    this.conversations = new Conversations(dataDir);
    this.vault = secretVault; this.fetchImpl = fetchImpl; this.memoryKey = ''; this.active = null;
    this.cancelledIds = new Set();
    this.idleMs = idleMs; this.timeoutMs = timeoutMs;
    this.billing = new ChatBilling({ dataDir, fetchImpl });
  }
  key() { return this.memoryKey || (this.settings.keyRef ? this.vault?.read(this.settings.keyRef)?.value : '') || ''; }
  get turns() { return this.conversations.current.turns; }
  recoverBilling(key = this.key()) {
    this.billing.recoverHistory(this.conversations.allTurns(), { baseUrl: this.settings.baseUrl, key, settingsSavedAt: this.settingsSavedAt });
  }
  publicConfig() {
    const { baseUrl, model, persona, maxTokens } = this.settings;
    return { baseUrl, model, persona, maxTokens, hasKey: !!this.key(), keyStorage: this.memoryKey ? 'session' : this.vault?.available?.() ? 'encrypted' : 'session' };
  }
  save(input) {
    if (this.active) throw new Error('请先停止当前回复，再修改会话设置');
    const baseUrl = String(input.baseUrl || '').trim(), model = String(input.model || '').trim();
    completionUrl(baseUrl);
    const persona = String(input.persona || '').trim(), maxTokens = Number(input.maxTokens);
    if (!model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('请填写有效的模型名称');
    if (persona.length > 16000) throw new Error('角色人设最多 16000 个字符');
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 32768) throw new Error('最长回复长度须为 1 到 32768 个 token');
    const newKey = String(input.apiKey || '').trim().replace(/^Bearer\s+/i, '');
    if (newKey.length > 16384 || /[\x00-\x20]/.test(newKey)) throw new Error('API key 格式无效');
    if (this.settings.baseUrl && new URL(baseUrl).origin !== new URL(this.settings.baseUrl).origin && !newKey) throw new Error('更换会话网站时请重新输入该网站的 API key');
    if (!newKey && !this.key()) throw new Error('请输入会话 API key');
    this.recoverBilling();
    let keyRef = this.settings.keyRef;
    const encrypted = newKey && this.vault?.available?.();
    if (newKey) {
      // Write the inactive slot; the atomic settings replacement commits the
      // endpoint and key together. A failed save leaves the active key intact.
      keyRef = encrypted ? keyRef === KEY_REF ? NEXT_KEY_REF : KEY_REF : '';
      if (encrypted) this.vault.write(keyRef, newKey);
    }
    const settings = { baseUrl, model, persona, maxTokens, keyRef };
    writeJson(this.configFile, settings); this.settings = settings;
    this.settingsSavedAt = savedAt(this.configFile);
    if (newKey) this.memoryKey = encrypted ? '' : newKey;
    return this.publicConfig();
  }
  history() { return { turns: structuredClone(this.turns), activeId: this.active?.id || null,
    conversationId: this.conversations.currentId, conversations: this.conversations.list() }; }
  persist() { this.conversations.persist(); }
  changeConversation(action, id) {
    if (this.active) throw new Error('请先停止回复，再操作会话列表');
    this.recoverBilling();
    if (action === 'create') this.conversations.create();
    else if (action === 'select') this.conversations.select(id);
    else this.conversations.remove(id);
  }
  clear() {
    if (this.active) throw new Error('请先停止回复，再新建会话');
    this.changeConversation('delete', this.conversations.currentId);
  }
  stop(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id)) throw new Error('无效的消息标识');
    this.cancelledIds.add(id);
    if (this.cancelledIds.size > 64) this.cancelledIds.delete(this.cancelledIds.values().next().value);
    if (this.active?.id === id) { this.active.controller.abort(); return true; }
    return false;
  }
  start(input, signal) {
    if (this.active) throw new Error('当前回复尚未结束');
    const text = String(input.text || '').trim(), id = input.id;
    if (!text || text.length > 16000) throw new Error('消息不能为空，且最多 16000 个字符');
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(id) || this.conversations.allTurns().some(turn => turn.id === id)) throw new Error('无效或重复的消息标识');
    if (input.conversationId !== undefined && input.conversationId !== this.conversations.currentId) throw new Error('当前会话已切换，请重新发送');
    const key = this.key();
    if (!key) throw new Error('请先在会话设置中填写 API key');
    completionUrl(this.settings.baseUrl);
    this.recoverBilling(key);
    const controller = new AbortController(), settings = { ...this.settings };
    if (this.cancelledIds.has(id)) controller.abort();
    const messages = this.turns.filter(turn => turn.status === 'completed').slice(-20).flatMap(turn => [
      { role: 'user', content: turn.user }, { role: 'assistant', content: turn.text }
    ]);
    const remaining = 48000;
    while (messages.length && messages.reduce((n, message) => n + message.content.length, 0) > remaining) messages.splice(0, 2);
    if (settings.persona) messages.unshift({ role: 'system', content: settings.persona });
    messages.push({ role: 'user', content: text });
    const turn = { id, user: text, text: '', status: 'streaming', createdAt: new Date().toISOString(), model: settings.model };
    this.turns.push(turn); this.persist();
    const billedRequest = !controller.signal.aborted;
    if (billedRequest) this.billing.record(turn, { baseUrl: settings.baseUrl, key });
    this.active = { id, controller };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start: output => {
        let disconnected = false, idle, timedOut = false;
        const emit = event => { if (!disconnected) { try { output.enqueue(encoder.encode('data: ' + JSON.stringify({ ...event, id }) + '\n\n')); } catch { disconnected = true; controller.abort(); } } };
        const resetIdle = () => { clearTimeout(idle); idle = setTimeout(() => { timedOut = true; controller.abort(); }, this.idleMs); };
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
        resetIdle(); emit({ type: 'start' });
        this.active.job = (async () => {
          try {
            for await (const event of complete({ settings, key, messages, fetchImpl: this.fetchImpl, signal: controller.signal })) {
              if (controller.signal.aborted) throw new Error('aborted');
              resetIdle();
              if (event.type === 'delta') {
                turn.text += event.text;
                if (turn.text.length > 128000) throw new Error('回复内容超过本地长度限制');
                emit(event);
              } else if (event.type === 'finish') turn.finishReason = event.reason;
              else if (event.type === 'usage') {
                turn.usage = billingUsage(event.usage) || undefined;
              }
            }
            if (controller.signal.aborted) throw new Error('aborted');
            if (!turn.text) throw new Error('模型没有返回文字回复');
            turn.status = 'completed';
          } catch (error) {
            turn.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
            turn.error = timedOut ? '回复超时，请重试' : controller.signal.aborted ? '已停止生成' :
              error.message.includes(key) ? '会话请求失败，请检查设置后重试' : error.message.startsWith('会话接口') || error.message.startsWith('连接提前') || error.message.startsWith('模型没有') || error.message.startsWith('此会话') || error.message.startsWith('回复内容') ? error.message : '会话连接失败，请检查网络或接口地址';
          } finally {
            clearTimeout(timer); clearTimeout(idle); signal?.removeEventListener('abort', abort);
            if (billedRequest) this.billing.record(turn, { baseUrl: settings.baseUrl, key });
            try { this.persist(); }
            catch { turn.status = 'failed'; turn.error = '回复已收到，但本地历史保存失败'; }
            this.active = null;
            emit({ type: 'done', turn: structuredClone(turn) });
            try { output.close(); } catch {}
          }
        })();
      },
      cancel: () => controller.abort(),
    });
    return { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' }, body };
  }
  async dispatch(url, { method, body, signal }) {
    try {
      const input = () => JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : JSON.stringify(body || {}));
      if (url.pathname === '/api/chat/settings') {
        if (method === 'GET') return json(200, { ok: true, settings: this.publicConfig() });
        if (method === 'PUT') return json(200, { ok: true, settings: this.save(input()) });
      }
      if (url.pathname === '/api/chat/history') {
        if (method === 'GET') return json(200, { ok: true, ...this.history() });
        if (method === 'DELETE') { this.clear(); return json(200, { ok: true, ...this.history() }); }
      }
      if (url.pathname === '/api/chat/conversations') {
        if (method === 'GET') return json(200, { ok: true, conversationId: this.conversations.currentId, conversations: this.conversations.list() });
        if (['POST', 'PUT', 'DELETE'].includes(method)) {
          this.changeConversation(method === 'POST' ? 'create' : method === 'PUT' ? 'select' : 'delete', method === 'POST' ? undefined : input().id);
          return json(200, { ok: true, ...this.history() });
        }
      }
      if (url.pathname === '/api/chat/billing' && method === 'GET') {
        const key = this.key(); this.recoverBilling(key);
        return json(200, { ok: true, billing: await this.billing.summary({ baseUrl: this.settings.baseUrl, key, force: url.searchParams.get('refresh') === '1' }) });
      }
      if (url.pathname === '/api/chat/message' && method === 'POST') return this.start(input(), signal);
      if (url.pathname === '/api/chat/stop' && method === 'POST') return json(200, { ok: true, stopped: this.stop(input().id) });
      return json(405, { ok: false, error: '不支持的会话操作' });
    } catch (error) { return json(400, { ok: false, error: error instanceof SyntaxError ? '会话数据格式无效' : error.message }); }
  }
  async close() { if (this.active) { this.active.controller.abort(); await this.active?.job; } this.memoryKey = ''; }
}
