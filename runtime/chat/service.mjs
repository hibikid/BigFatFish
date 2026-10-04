import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from '../paths.mjs';
import { completionUrl } from './provider.mjs';
import { ChatBilling } from './billing.mjs';
import { Conversations } from './conversations.mjs';
import { ChatActivity } from './activity.mjs';
import { POMODORO_TOOLS, POMODORO_POLICY } from './pomodoro.mjs';
import { generateReply } from './reply.mjs';

const DEFAULTS = { baseUrl: '', model: 'deepseek-flash', persona: '', maxTokens: 1024, backgroundMaxTokens: 1024 };
// A runaway guard only; the token settings decide how long a reply may be.
const MAX_REPLY_CHARS = 128000;
const KEY_REF = 'whale_chat_api_key_v1';
const NEXT_KEY_REF = KEY_REF + '_next';
const json = (status, value) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify(value)) });
const BACKGROUND_INSTRUCTION = '按角色人设说一两句自然、简短的话。沿用过往对话的语言；没有上下文时用中文。不要声称看到了用户正在做什么，也不要假装执行了工具。';
const DECLINE_MARK = '[不打扰]';
const DECLINE_OFFER = '如果按聊天记录现在不适合打扰我，比如刚道过晚安、我说要出门或在忙，或者你说过自己要去睡了，就只回复 ' + DECLINE_MARK + '，不要写别的。';
// The marker anywhere, in either bracket style, or a few words starting with it.
function declined(text) {
  const bare = text.replace(/[\s\p{P}]/gu, '');
  return /[[【]不打扰[\]】]/.test(text) || bare.startsWith('不打扰') && bare.length <= 8;
}
function savedAt(file) { try { return fs.statSync(file).mtimeMs; } catch { return Infinity; } }

export class ChatService {
  constructor({ dataDir, secretVault, fetchImpl = fetch, idleMs = 60000, timeoutMs = 180000, canProactive = () => true, onNotice = () => {}, now = Date.now, activityOptions = {} }) {
    this.configFile = path.join(dataDir, 'chat-settings.json');
    const stored = readJson(this.configFile, {});
    this.settings = { ...DEFAULTS, ...stored, keyRef: typeof stored.keyRef === 'string' ? stored.keyRef : stored.baseUrl ? KEY_REF : '' };
    this.settingsSavedAt = savedAt(this.configFile);
    this.conversations = new Conversations(dataDir);
    this.vault = secretVault; this.fetchImpl = fetchImpl; this.memoryKey = ''; this.active = null; this.background = null;
    this.cancelledIds = new Set();
    this.idleMs = idleMs; this.timeoutMs = timeoutMs;
    this.now = activityOptions.now || now;
    this.billing = new ChatBilling({ dataDir, fetchImpl });
    this.activity = new ChatActivity({ dataDir, canProactive: () => canProactive() && !this.active && !this.background,
      onProactive: () => this.proactive(), onReminder: state => this.reminder(state), onNotice, now: this.now, ...activityOptions });
  }
  key() { return this.memoryKey || (this.settings.keyRef ? this.vault?.read(this.settings.keyRef)?.value : '') || ''; }
  get turns() { return this.conversations.current.turns; }
  recoverBilling(key = this.key()) {
    this.billing.recoverHistory(this.conversations.allTurns(), { baseUrl: this.settings.baseUrl, key, settingsSavedAt: this.settingsSavedAt });
  }
  publicConfig() {
    const { baseUrl, model, persona, maxTokens, backgroundMaxTokens } = this.settings;
    return { baseUrl, model, persona, maxTokens, backgroundMaxTokens, hasKey: !!this.key(), keyStorage: this.memoryKey ? 'session' : this.vault?.available?.() ? 'encrypted' : 'session' };
  }
  save(input) {
    if (this.active) throw new Error('请先停止当前回复，再修改会话设置');
    const baseUrl = String(input.baseUrl || '').trim(), model = String(input.model || '').trim();
    completionUrl(baseUrl);
    const persona = String(input.persona || '').trim(), maxTokens = Number(input.maxTokens);
    const tokenLimit = value => Number.isInteger(value) && value >= 1 && value <= 32768;
    const backgroundMaxTokens = input.backgroundMaxTokens === undefined ? this.settings.backgroundMaxTokens : Number(input.backgroundMaxTokens);
    if (!model || model.length > 200 || /[\x00-\x1f]/.test(model)) throw new Error('请填写有效的模型名称');
    if (persona.length > 16000) throw new Error('角色人设最多 16000 个字符');
    if (!tokenLimit(maxTokens)) throw new Error('最长回复长度须为 1 到 32768 个 token');
    if (!tokenLimit(backgroundMaxTokens)) throw new Error('主动消息最长回复须为 1 到 32768 个 token');
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
    const settings = { baseUrl, model, persona, maxTokens, backgroundMaxTokens, keyRef };
    writeJson(this.configFile, settings); this.settings = settings;
    this.settingsSavedAt = savedAt(this.configFile);
    if (newKey) this.memoryKey = encrypted ? '' : newKey;
    return this.publicConfig();
  }
  history() { return { turns: structuredClone(this.turns), activeId: this.active?.id || null,
    conversationId: this.conversations.currentId, conversations: this.conversations.list() }; }
  activitySnapshot() { return this.activity.snapshot(); }
  // Recent exchanges: every conversation's turns in time order; a reply keeps the latest ones.
  recentExchanges() {
    return this.conversations.allTurns().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }
  // What the character remembers when replying in a conversation: a normal one
  // remembers itself, the companion conversation the recent exchanges.
  memoryOf(conversation) {
    return conversation?.kind === 'spontaneous' ? this.recentExchanges() : [...conversation?.turns || []];
  }
  reply(settings, key, options) {
    return generateReply({ endpoint: { baseUrl: settings.baseUrl, model: settings.model, maxTokens: settings.maxTokens, key }, persona: settings.persona,
      now: this.now(), fetchImpl: this.fetchImpl, record: (request, credentials) => this.billing.record(request, credentials), ...options });
  }
  // Generates without touching history. A non-null result carries commit(),
  // which appends the reply to conversation `conversationId` (the spontaneous
  // one when that is absent or deleted), dated at that moment, and returns where
  // it went; the caller commits only if the reply still applies when it is due.
  async backgroundReply({ prompt, source, history = [], conversationId }) {
    if (this.active || this.background || !this.key() || !this.settings.baseUrl) return null;
    const key = this.key(), settings = { ...this.settings, maxTokens: this.settings.backgroundMaxTokens };
    const controller = new AbortController(), id = randomUUID();
    const background = { controller };
    background.done = new Promise(resolve => { background.resolve = resolve; });
    this.background = background;
    try {
      const reply = await this.reply(settings, key, { instruction: BACKGROUND_INSTRUCTION, history, prompt, id, signal: controller.signal,
        timeoutMs: Math.min(30000, this.timeoutMs), maxChars: MAX_REPLY_CHARS });
      const text = reply.text.trim();
      if (reply.status !== 'completed' || !text) return null;
      return { text, commit: () => {
        const target = this.conversations.find(conversationId) || this.conversations.spontaneous();
        this.conversations.appendTo(target.id, { id, user: '', text, status: 'completed', source, createdAt: new Date(this.now()).toISOString(), model: settings.model, usage: reply.usage, requests: reply.requests });
        return target.id;
      } };
    } finally {
      if (this.background === background) this.background = null;
      background.resolve();
    }
  }
  // Remembers the recent exchanges, like the companion conversation it lands in. Half
  // the time it follows one of them up; otherwise it opens a new topic. The
  // character may decline instead; a declined message is never kept or shown.
  async proactive() {
    const prompt = this.activity.random() < 0.5 ? '结合我们最近聊过的一件事，主动和我随便聊一句。' : '按你的人设，主动发起一个轻松的新话题。';
    const generated = await this.backgroundReply({ source: 'proactive', history: this.recentExchanges(), prompt: prompt + '不要推测我现在正在做什么。' + DECLINE_OFFER });
    return generated && declined(generated.text) ? null : generated;
  }
  async reminder(state) {
    const prompt = `番茄钟状态：${state.phase}；第 ${state.cycle}/${state.cycles} 轮；专注 ${state.focusMinutes} 分钟，休息 ${state.breakMinutes} 分钟。请按人设简短提醒我${state.phase === 'await_break' ? '专注结束，可以准备休息了' : state.phase === 'await_focus' ? '休息结束，可以准备下一轮专注了' : '本次专注已经完成'}。阶段尚未开始，不要宣称已经开始，不要要求我发送消息确认，也不要解释界面操作。`;
    return this.backgroundReply({ source: 'pomodoro', prompt, history: this.memoryOf(this.conversations.find(state.conversationId)), conversationId: state.conversationId });
  }
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
    this.background?.controller.abort();
    const conversationId = this.conversations.currentId, history = this.memoryOf(this.conversations.current);
    const tools = { definitions: POMODORO_TOOLS, policy: POMODORO_POLICY, execute: call => this.activity.tool(call, conversationId) };
    const turn = { id, user: text, text: '', status: 'streaming', source: 'user', createdAt: new Date(this.now()).toISOString(), model: settings.model, requests: [] };
    this.turns.push(turn); this.persist();
    try { this.activity.userActivity(); } catch {}
    this.active = { id, controller };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start: output => {
        let disconnected = false;
        const emit = event => { if (!disconnected) { try { output.enqueue(encoder.encode('data: ' + JSON.stringify({ ...event, id }) + '\n\n')); } catch { disconnected = true; controller.abort(); } } };
        emit({ type: 'start' });
        this.active.job = (async () => {
          try {
            const reply = await this.reply(settings, key, { history, prompt: text, tools, id, signal: controller.signal,
              timeoutMs: this.timeoutMs, idleMs: this.idleMs, maxChars: MAX_REPLY_CHARS, onDelta: delta => { turn.text += delta; emit({ type: 'delta', text: delta }); } });
            Object.assign(turn, { text: reply.text, status: reply.status, requests: reply.requests },
              reply.usage ? { usage: reply.usage } : {}, reply.finishReason ? { finishReason: reply.finishReason } : {}, reply.error ? { error: reply.error } : {});
          } catch { turn.status = 'failed'; turn.error = '会话连接失败，请检查网络或接口地址'; }
          finally {
            signal?.removeEventListener('abort', abort);
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
      if (url.pathname === '/api/chat/activity' && method === 'GET') return json(200, { ok: true, ...this.activitySnapshot() });
      if (url.pathname === '/api/chat/activity/settings') {
        if (method === 'GET') return json(200, { ok: true, settings: this.activity.settings() });
        if (method === 'PUT') return json(200, { ok: true, settings: this.activity.saveSettings(input()) });
      }
      if (url.pathname === '/api/chat/activity/ack' && method === 'POST') { this.activity.ack(input().seq); return json(200, { ok: true }); }
      if (url.pathname === '/api/chat/activity/advance' && method === 'POST') return json(200, this.activity.advance(input()));
      if (url.pathname === '/api/chat/activity/presence' && method === 'POST') { this.activity.setPresence(input()); return json(200, { ok: true }); }
      if (url.pathname === '/api/chat/message' && method === 'POST') return this.start(input(), signal);
      if (url.pathname === '/api/chat/stop' && method === 'POST') return json(200, { ok: true, stopped: this.stop(input().id) });
      return json(405, { ok: false, error: '不支持的会话操作' });
    } catch (error) { return json(400, { ok: false, error: error instanceof SyntaxError ? '会话数据格式无效' : error.message }); }
  }
  async close() {
    this.activity.close();
    const background = this.background;
    background?.controller.abort();
    if (this.active) { this.active.controller.abort(); await this.active?.job; }
    await background?.done;
    this.memoryKey = '';
  }
}
