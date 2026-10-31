export type Failure = 'codec' | 'auth' | 'forbidden' | 'missing' | 'network' | 'decode' | 'quota' | 'fatal';

export function classifyFailure(reason: string): Failure {
  if (/(?:http|init|fragment):401/.test(reason)) return 'auth';
  if (/(?:http|init|fragment):403/.test(reason)) return 'forbidden';
  if (/(?:http|init|fragment|playlist):(?:404|empty)/.test(reason)) return 'missing';
  if (reason === 'codec' || reason.startsWith('codec:') || reason === 'media:4') return 'codec';
  if (/QuotaExceededError/.test(reason)) return 'quota';
  if (/decode|media:3/.test(reason)) return 'decode';
  if (/network|http:(?:429|5\d\d)|media:2|timeout/.test(reason)) return 'network';
  return 'fatal';
}

export function retryDelay(attempt: number, retryAfter: string | null, now = Date.now()): number {
  const seconds = retryAfter !== null && retryAfter.trim() !== '' ? Number(retryAfter) : NaN;
  const requested = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - now : 0;
  return Math.min(10000, Math.max(250 * 2 ** attempt * (0.8 + Math.random() * 0.4), requested || 0));
}
