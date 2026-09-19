const CST = 'Asia/Shanghai';

/** 东八区日期 YYYY-MM-DD */
export function getCstDateString(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: CST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(date)
    .replace(/\//g, '-');
}

/** 东八区时间 HH:mm:ss */
export function getCstTimeString(date: Date = new Date()): string {
  return date.toLocaleTimeString('zh-CN', { timeZone: CST, hour12: false });
}

/** 东八区标准时间 YYYY-MM-DD HH:mm:ss */
export function getCstDateTimeString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: CST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
}
