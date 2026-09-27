import { readEvents } from '../../desktop/ui/chat-stream.js';

export function completionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请填写有效的会话 API 地址'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) {
    throw new Error('会话 API 地址须为 HTTPS（本机服务可用 HTTP），不能包含密钥或查询参数');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions';
  return url.href;
}

export async function* complete({ settings, key, messages, fetchImpl, signal }) {
  const response = await fetchImpl(completionUrl(settings.baseUrl), {
    method: 'POST', redirect: 'error', signal,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: settings.model, messages, max_tokens: settings.maxTokens, stream: true, stream_options: { include_usage: true } }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const detail = response.status === 401 || response.status === 403 ? '请检查 API key 与模型权限' :
      response.status === 429 ? '请求过于频繁或额度不足，请稍后重试' : '请检查接口地址、模型名称和回复长度';
    throw new Error('会话接口返回 ' + response.status + '，' + detail);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('会话接口未返回 SSE 流式响应，请检查接口协议');
  }
  let finished = false;
  for await (const event of readEvents(response.body)) {
    if (event.data === '[DONE]') { finished = true; break; }
    let data;
    try { data = JSON.parse(event.data); } catch { throw new Error('会话接口返回了无效的流式数据'); }
    if (data.error) throw new Error('会话接口报告生成失败，请检查模型配置后重试');
    const choice = data.choices?.find(item => item.index === 0) || data.choices?.[0];
    if (choice?.delta?.tool_calls?.length) throw new Error('此会话暂不支持工具调用');
    if (typeof choice?.delta?.content === 'string' && choice.delta.content) yield { type: 'delta', text: choice.delta.content };
    if (choice?.finish_reason) yield { type: 'finish', reason: choice.finish_reason };
    if (data.usage) yield { type: 'usage', usage: data.usage };
  }
  if (!finished) throw new Error('连接提前结束，回复未完成');
}
