import { afterEach, expect, it, vi } from 'vitest';
import { classifyFailure, retryDelay } from './playback-errors';
import { request } from './mse-operations';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('separates access, missing media, decode corruption and transient delivery', () => {
  expect(classifyFailure('http:401')).toBe('auth');
  expect(classifyFailure('http:403')).toBe('forbidden');
  expect(classifyFailure('fragment:404')).toBe('missing');
  expect(classifyFailure('media:3')).toBe('decode');
  expect(classifyFailure('http:503')).toBe('network');
  expect(classifyFailure('codec:h264')).toBe('codec');
  expect(retryDelay(0, '3')).toBe(3000);
  expect(retryDelay(0, new Date(13000).toUTCString(), 10000)).toBe(3000);
});

it('retries a transient fragment without restarting the player and respects Retry-After', async () => {
  vi.useFakeTimers();
  const get = vi.fn().mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '2' } }))
    .mockResolvedValueOnce(new Response('data', { status: 206 }));
  vi.stubGlobal('fetch', get);
  const pending = request('http://test/fragment', new AbortController().signal, 'bytes=0-3');
  await vi.advanceTimersByTimeAsync(1999); expect(get).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await (await pending).text()).toBe('data');
  expect(get).toHaveBeenCalledTimes(2);
});

it('does not retry an expired session, and aborts a pending backoff', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
  await expect(request('http://test', new AbortController().signal)).rejects.toThrow('http:401');
  expect(fetch).toHaveBeenCalledTimes(1);
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  const ctl = new AbortController(), promise = request('http://test', ctl.signal);
  const assertion = expect(promise).rejects.toHaveProperty('name', 'AbortError');
  await vi.advanceTimersByTimeAsync(0); ctl.abort(); await assertion;
  await vi.advanceTimersByTimeAsync(10000); expect(fetch).toHaveBeenCalledTimes(1);
});

it('playlist:empty classifies as missing', () => {
  expect(classifyFailure('playlist:empty')).toBe('missing');
});
