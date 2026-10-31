import { retryDelay } from './playback-errors';
export const abortError = () => new DOMException('Playback session replaced', 'AbortError');

export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
}

export async function request(url: string, signal: AbortSignal, range?: string, onRetry?: () => void): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const timeout = setTimeout(cancel, 20000);
    let wait = retryDelay(attempt, null);
    try {
      const r = await fetch(url, { signal: controller.signal, headers: range ? { Range: range } : undefined });
      if (r.ok || r.status === 404) {
        const body = await r.arrayBuffer();
        return new Response(body, { status: r.status, headers: r.headers });
      }
      if ((r.status < 500 && r.status !== 429) || attempt === 3) throw new Error(`http:${r.status}`);
      wait = retryDelay(attempt, r.headers.get('Retry-After'));
      await r.body?.cancel();
    } catch (e) {
      if (signal.aborted) throw abortError();
      if (e instanceof Error && e.message.startsWith('http:')) throw e;
      if (attempt === 3) throw new Error('network');
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', cancel);
    }
    onRetry?.(); await delay(wait, signal);
  }
}

export function sourceOpened(media: MediaSource, signal: AbortSignal): Promise<void> {
  if (media.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const clean = () => { media.removeEventListener('sourceopen', ok); signal.removeEventListener('abort', cancel); };
    const ok = () => { clean(); resolve(); };
    const cancel = () => { clean(); reject(abortError()); };
    media.addEventListener('sourceopen', ok, { once: true });
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

// The caller owns the single queue. Listeners are installed before the operation starts.
export function update(buffer: SourceBuffer, signal: AbortSignal, operation: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer); buffer.removeEventListener('updateend', ok);
      buffer.removeEventListener('error', fail); buffer.removeEventListener('abort', cancel);
      signal.removeEventListener('abort', cancel);
    };
    const ok = () => { clean(); resolve(); };
    const fail = () => { clean(); reject(new Error('decode')); };
    const cancel = () => { clean(); reject(abortError()); };
    const timer = setTimeout(() => { clean(); reject(new Error('mse:timeout')); }, 15000);
    if (signal.aborted) { cancel(); return; }
    buffer.addEventListener('updateend', ok, { once: true }); buffer.addEventListener('error', fail, { once: true });
    buffer.addEventListener('abort', cancel, { once: true }); signal.addEventListener('abort', cancel, { once: true });
    try { operation(); } catch (e) { clean(); reject(e); }
  });
}
