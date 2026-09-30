import { complete, visibleError } from './provider.mjs';
import { billingUsage, officialDeepSeek } from './deepseek-pricing.mjs';
import { localTimeContext } from './time-context.mjs';

const TOOL_ROUNDS = 2;

function addUsage(total, usage) {
  const result = { ...total };
  for (const [key, value] of Object.entries(usage)) if (typeof value === 'number' && Number.isFinite(value)) result[key] = (result[key] || 0) + value;
  return result;
}

function context(turns) {
  const messages = turns.filter(turn => turn.status === 'completed').slice(-20).flatMap(turn => [
    ...(turn.user ? [{ role: 'user', content: turn.user }] : []), ...(turn.text ? [{ role: 'assistant', content: turn.text }] : [])
  ]);
  while (messages.length && messages.reduce((n, message) => n + message.content.length, 0) > 48000) messages.shift();
  return messages;
}

// One character reply: framing, up to two local tool rounds, and a final text
// round, each billed as its own request. It never writes history; the caller
// decides whether the result still applies. The result is always returned,
// with `status` completed, cancelled or failed and a user-facing `error`.
export async function generateReply({ endpoint, persona = '', instruction = '', history = [], prompt, tools = null, id, now = Date.now(),
  fetchImpl = fetch, record = () => {}, signal, timeoutMs = Infinity, idleMs = Infinity, maxChars = Infinity, onDelta = () => {} }) {
  const reply = { status: 'failed', text: '', usage: undefined, finishReason: undefined, requests: [], error: '' };
  const controller = new AbortController(), credentials = { baseUrl: endpoint.baseUrl, key: endpoint.key };
  let timedOut = false, idle = null;
  const expire = () => { timedOut = true; controller.abort(); };
  const cancel = () => controller.abort();
  const resetIdle = () => { if (Number.isFinite(idleMs)) { clearTimeout(idle); idle = setTimeout(expire, idleMs); idle.unref?.(); } };
  const timer = Number.isFinite(timeoutMs) ? setTimeout(expire, timeoutMs) : null;
  timer?.unref?.();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) controller.abort();
  resetIdle();
  try {
    const offered = tools && officialDeepSeek(endpoint.baseUrl) ? tools : null;
    const messages = [
      ...(persona ? [{ role: 'system', content: persona }] : []),
      { role: 'system', content: localTimeContext(now) },
      ...(instruction ? [{ role: 'system', content: instruction }] : []),
      ...(offered?.policy ? [{ role: 'system', content: offered.policy }] : []),
      ...context(history),
      { role: 'user', content: prompt }
    ];
    const settings = { baseUrl: endpoint.baseUrl, model: endpoint.model, maxTokens: endpoint.maxTokens };
    for (let round = 0; round <= TOOL_ROUNDS; round++) {
      if (controller.signal.aborted) throw new Error('aborted');
      const request = { id: round ? id + ':' + round : id, model: endpoint.model, createdAt: new Date().toISOString(), status: 'streaming' };
      reply.requests.push(request); record(request, credentials);
      let calls = null, roundText = '', reasoning = '';
      try {
        for await (const event of complete({ settings, key: endpoint.key, messages, fetchImpl, signal: controller.signal, tools: offered && round < TOOL_ROUNDS ? offered.definitions : null })) {
          if (controller.signal.aborted) throw new Error('aborted');
          resetIdle();
          if (event.type === 'delta') {
            roundText += event.text; reply.text += event.text;
            if (reply.text.length > maxChars) throw visibleError('回复内容超过本地长度限制');
            onDelta(event.text);
          } else if (event.type === 'finish' && event.reason !== 'tool_calls') reply.finishReason = event.reason;
          else if (event.type === 'usage') request.usage = billingUsage(event.usage) || undefined;
          else if (event.type === 'tool_calls') { calls = event.calls; reasoning = event.reasoning; }
        }
        request.status = 'completed';
      } catch (error) { request.status = controller.signal.aborted ? 'cancelled' : 'failed'; throw error; }
      finally {
        if (request.usage) reply.usage = addUsage(reply.usage, request.usage);
        record(request, credentials);
      }
      if (!calls) break;
      const assistant = { role: 'assistant', content: roundText || null, tool_calls: calls };
      if (reasoning) assistant.reasoning_content = reasoning;
      messages.push(assistant);
      for (const call of calls) {
        let result;
        try { result = offered.execute({ name: call.function.name, arguments: call.function.arguments }); }
        catch { result = { ok: false, error: '操作未能保存' }; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
    }
    if (controller.signal.aborted) throw new Error('aborted');
    if (!reply.text) throw visibleError('模型没有返回文字回复');
    reply.status = 'completed';
  } catch (error) {
    reply.status = controller.signal.aborted && !timedOut ? 'cancelled' : 'failed';
    reply.error = timedOut ? '回复超时，请重试' : controller.signal.aborted ? '已停止生成' :
      String(error?.message).includes(endpoint.key) ? '会话请求失败，请检查设置后重试' : error?.visible ? error.message : '会话连接失败，请检查网络或接口地址';
  } finally {
    clearTimeout(timer); clearTimeout(idle); signal?.removeEventListener('abort', cancel);
  }
  return reply;
}
