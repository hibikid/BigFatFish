const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
const two = value => String(value).padStart(2, '0');

export function localTimeContext(timestamp) {
  const date = new Date(timestamp);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区';
  const time = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  return `当前用户设备本地时间：${time}，${WEEKDAYS[date.getDay()]}，时区 ${zone}。可以结合时间、角色人设和聊天上下文自然调整话题与建议，不必每次报时；仅凭时间不能推断用户正在做什么。`;
}
