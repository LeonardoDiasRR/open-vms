import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createFeed, parsePlaylist } from './feed-mse';
import { decodeTime, mediaTimescale } from './mse-timing';

const init = new Uint8Array(readFileSync('src/features/archive/services/__fixtures__/init.bin'));
const scale = mediaTimescale(init);
const fragment = (time = 0) => {
  const b = new ArrayBuffer(28), a = new Uint8Array(b);
  a.set([116, 102, 100, 116], 12); a[16] = 1;
  new DataView(b).setBigUint64(20, BigInt(Math.round(time * scale)));
  return b;
};
type RangeView = { length: number; start(index?: number): number; end(index?: number): number };
const ranges = (end: (index?: number) => number): RangeView =>
  ({ get length() { return end() > 0 ? 1 : 0; }, start: () => 0, end });
class BufferDouble extends EventTarget {
  end = 0; updating = false; mode = ''; timestampOffset = 0; data: number[] = []; failQuota = false; fragmentDuration = 1;
  buffered = ranges(() => this.end);
  appendBuffer(data: ArrayBuffer) {
    if (this.failQuota) { this.failQuota = false; throw new DOMException('', 'QuotaExceededError'); }
    this.updating = true;
    if (data.byteLength === 28) { this.end = this.timestampOffset + decodeTime(data, scale) + this.fragmentDuration; this.data.push(this.end); }
    queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
  }
  remove = vi.fn(() => queueMicrotask(() => this.dispatchEvent(new Event('updateend'))));
  changeType = vi.fn();
}
class MediaDouble extends EventTarget {
  static instances: MediaDouble[] = [];
  static isTypeSupported = () => true;
  readyState = 'closed'; buffer = new BufferDouble();
  constructor() {
    super(); MediaDouble.instances.push(this);
    queueMicrotask(() => { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); });
  }
  addSourceBuffer = () => this.buffer;
  endOfStream = vi.fn(() => { this.readyState = 'ended'; });
}
class VideoDouble extends EventTarget {
  currentTime = 0; playbackRate = 1; paused = true; readyState = 2; src = ''; error = null;
  get buffered() { return MediaDouble.instances.at(-1)!.buffer.buffered; }
  play = vi.fn(async () => { this.paused = false; });
  pause = vi.fn(() => { this.paused = true; });
  load = vi.fn(); removeAttribute = vi.fn();
}
const playlist = (epoch: number, source = 'a') => `#EXTM3U\n#EXT-X-MAP:URI="${source}",BYTERANGE="${init.length}@0"\n#EXT-X-PROGRAM-DATE-TIME:${new Date(epoch * 1000).toISOString()}\n#EXTINF:1,\n#EXT-X-BYTERANGE:28@${init.length}\n${source}\n#EXT-X-ENDLIST\n`;
const opts = { base: 1000, live: false, end: 1120, continuous: true };
const feeds: ReturnType<typeof createFeed>[] = [];
const video = () => new VideoDouble() as unknown as HTMLVideoElement;
const feed = (v = video()) => { const f = createFeed(v); feeds.push(f); return f; };

beforeEach(() => {
  vi.useFakeTimers(); MediaDouble.instances = [];
  vi.stubGlobal('MediaSource', MediaDouble);
  vi.stubGlobal('URL', class extends URL { static createObjectURL = vi.fn(() => 'blob:test'); static revokeObjectURL = vi.fn(); });
});
afterEach(() => { feeds.forEach(f => f.destroy()); feeds.length = 0; vi.useRealTimers(); vi.unstubAllGlobals(); });

it('parses absolute fragment epochs and keeps the init of each source across a gap', () => {
  const p = parsePlaylist(playlist(1000) + playlist(1020, 'b'), 'http://test/playlist.m3u8');
  expect(p.frags.map(f => [f.epoch, f.initUrl])).toEqual([[1000, 'http://test/a'], [1020, 'http://test/b']]);
});

it('rolls playlists in one MediaSource and maps epochAt using its argument', async () => {
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) return ++lists <= 3 ? new Response(playlist(999 + lists, String(lists))) : new Response('', { status: 404 });
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  }));
  const f = feed(); f.start('http://test/playlist.m3u8?ts=1000', opts);
  await vi.advanceTimersByTimeAsync(0);
  expect(MediaDouble.instances).toHaveLength(1);
  expect(MediaDouble.instances[0].buffer.data).toEqual([1, 2, 3]);
  expect((fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([, options]) =>
    (options?.headers as Record<string, string>)?.Range === `bytes=0-${init.length - 1}`)
    .map(([url]) => url)).toEqual(['http://test/1', 'http://test/2', 'http://test/3']);
  expect(f.epochAt(2.25)).toBe(1002.25);
  f.seekEpoch(1001.5); expect(f.currentTime()).toBe(1.5);
  expect(MediaDouble.instances).toHaveLength(1);
});

it('ignores a response from an aborted generation and revokes both object URLs', async () => {
  let resolveOld!: (r: Response) => void;
  const old = new Promise<Response>(resolve => { resolveOld = resolve; });
  vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('old') ? old : Promise.resolve(new Response('', { status: 404 }))));
  const f = feed(); f.start('http://test/old', opts);
  await vi.advanceTimersByTimeAsync(0);
  f.start('http://test/new', { ...opts, base: 2000 });
  resolveOld(new Response(playlist(1000)));
  await vi.advanceTimersByTimeAsync(0);
  expect(MediaDouble.instances[0].buffer.data).toEqual([]);
  expect(f.epochAt(0)).toBe(2000);
  f.destroy();
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
});

it('serializes refresh while waiting and never fetches after destroy', async () => {
  const get = vi.fn(async () => new Response('', { status: 404 })); vi.stubGlobal('fetch', get);
  const v = video(), f = feed(v); f.start('http://test/playlist', opts);
  await vi.advanceTimersByTimeAsync(0);
  for (let i = 0; i < 20; i++) v.dispatchEvent(new Event('waiting'));
  await vi.advanceTimersByTimeAsync(100);
  expect(get).toHaveBeenCalledTimes(1);
  f.destroy(); await vi.advanceTimersByTimeAsync(10000);
  expect(get).toHaveBeenCalledTimes(1);
});

it('reads the real init timescale and 64-bit tfdt without rewriting PTS', () => {
  expect(scale).toBeGreaterThan(0);
  expect(decodeTime(fragment(3720.5), scale)).toBe(3720.5);
});

it('recovers one quota failure and trims played media before fetching more', async () => {
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) return ++lists <= 35 ? new Response(playlist(999 + lists, String(lists))) : new Response('', { status: 404 });
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  }));
  const v = video(), f = feed(v); f.start('http://test/playlist', opts);
  MediaDouble.instances[0].buffer.failQuota = true;
  await vi.advanceTimersByTimeAsync(0);
  expect(MediaDouble.instances[0].buffer.data).toHaveLength(30);
  v.currentTime = 25; await vi.advanceTimersByTimeAsync(250);
  expect(MediaDouble.instances[0].buffer.remove).toHaveBeenCalled();
  expect(MediaDouble.instances[0].buffer.data).toHaveLength(35);
});

it('never evicts the playing GOP when the source has long keyframe intervals', async () => {
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) return new Response(playlist(1000 + 30 * lists++, String(lists)).replace('#EXTINF:1,', '#EXTINF:30,'));
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  }));
  const v = video(), f = feed(v); f.start('http://test/playlist', opts);
  const buffer = MediaDouble.instances[0].buffer; buffer.fragmentDuration = 30;
  await vi.advanceTimersByTimeAsync(0);
  v.currentTime = 18; await vi.advanceTimersByTimeAsync(250);
  expect(buffer.remove).not.toHaveBeenCalled();
  v.currentTime = 48; await vi.advanceTimersByTimeAsync(250);
  expect(buffer.remove).toHaveBeenCalledWith(0, 30);
});

it.each([20, 3600])('keeps a %s-second successor gap without flattening ranges or fetching far ahead', async gap => {
  const get = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) return new Response(playlist(1000, 'a') + playlist(1000 + gap, 'b'));
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  });
  vi.stubGlobal('fetch', get);
  const f = feed(); f.start('http://test/playlist', opts);
  const buffer = MediaDouble.instances[0].buffer;
  // Expose the actual appended intervals instead of the default contiguous buffer double.
  buffer.buffered = {
    get length() { return buffer.data.length; },
    start: (i = 0) => buffer.data[i] - 1,
    end: (i = 0) => buffer.data[i],
  };
  await vi.advanceTimersByTimeAsync(0);
  expect(buffer.data).toEqual(gap === 20 ? [1, 21] : [1]);
  expect(buffer.buffered.length).toBe(gap === 20 ? 2 : 1);
  if (gap === 20) {
    expect(f.epochAt(buffer.buffered.start(1))).toBe(1020);
    expect(buffer.buffered.end(0)).toBe(1);
    expect(get.mock.calls.filter(([url]) => url === 'http://test/b')).toHaveLength(2);
  } else {
    await vi.advanceTimersByTimeAsync(10000);
    expect(get).toHaveBeenCalledTimes(3); // one playlist, init and fragment; no distant file request
    expect(get.mock.calls.some(([url]) => url === 'http://test/b')).toBe(false);
  }
  expect(MediaDouble.instances).toHaveLength(1);
});

it('keeps the cursor monotonic when a different qualified file has a rounded overlapping tail', async () => {
  const cursors: string[] = [];
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) {
      lists++; cursors.push(new URL(url).searchParams.get('ts')!);
      return new Response(lists === 1 ? playlist(1000.001, 'a') : playlist(1000, 'b').replace('#EXTINF:1,', '#EXTINF:1.0005,'));
    }
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  }));
  const f = feed(); f.start('http://test/playlist?ts=1000.001', { ...opts, base: 1000.001 });
  await vi.advanceTimersByTimeAsync(0);
  expect(cursors).toEqual(['1000.001', '1001.001', '1001.001']);
  expect(MediaDouble.instances[0].buffer.data).toHaveLength(2); // the same offset in another file is not a duplicate
});

it('resets the no-progress budget when a later refresh delivers another fragment', async () => {
  const errors: string[] = [];
  let lists = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) {
      lists++;
      return new Response(lists <= 12 ? playlist(1000, 'a') : playlist(1001, 'b'));
    }
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  }));
  const f = createFeed(video(), { onError: r => errors.push(r) }); feeds.push(f);
  f.start('http://test/playlist?ts=1000', opts);
  await vi.advanceTimersByTimeAsync(105000);
  expect(errors).toEqual([]);
  expect(lists).toBe(24); // two useful refreshes and eleven misses following each
  expect(MediaDouble.instances[0].buffer.data).toEqual([1, 2]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(lists).toBe(25);
  expect(errors).toEqual(['playlist:empty']);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['empty', 'duplicate'] as const)('bounds an old same-day %s tail after progress without advancing the cursor', async kind => {
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  const base = Date.now() / 1000 - 3600 + 0.123;
  const errors: string[] = [], cursors: string[] = [];
  let lists = 0;
  const get = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) {
      lists++; cursors.push(new URL(url).searchParams.get('ts')!);
      return lists === 1 || kind === 'duplicate' ? new Response(playlist(base)) : new Response('', { status: 404 });
    }
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  });
  vi.stubGlobal('fetch', get);
  const v = video(), f = createFeed(v, { onError: r => errors.push(r) }); feeds.push(f);
  f.start(`http://test/playlist?ts=${base}`, { ...opts, base, end: base + 1 });
  await vi.advanceTimersByTimeAsync(50000);
  expect(errors).toEqual([]);
  expect(lists).toBe(12); // one useful refresh, then eleven without progress
  await vi.advanceTimersByTimeAsync(5000);
  expect(errors).toEqual(['playlist:empty']);
  expect(lists).toBe(13);
  expect(cursors).toEqual([String(base), ...Array(12).fill(String(base + 1))]);
  expect(MediaDouble.instances[0].buffer.data).toEqual([1]);
  expect(MediaDouble.instances[0].endOfStream).not.toHaveBeenCalled();
  v.dispatchEvent(new Event('waiting'));
  await vi.advanceTimersByTimeAsync(120000);
  expect(lists).toBe(13);
  expect(errors).toEqual(['playlist:empty']);
  expect(get).toHaveBeenCalledTimes(15); // thirteen playlists, one real init and one fragment
  expect(vi.getTimerCount()).toBe(0);
});

it.each([180, 180.001, -1])('infers an edge only within the inclusive 180-second past window (lag %s)', async lag => {
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  const base = Date.now() / 1000 - lag;
  const get = vi.fn(async () => new Response(''));
  vi.stubGlobal('fetch', get);
  const f = feed(); f.start(`http://test/playlist?ts=${base}`, { ...opts, base });
  await vi.advanceTimersByTimeAsync(1000);
  expect(get).toHaveBeenCalledTimes(lag === 180 ? 2 : 1);
});

it.each(['explicit live', 'recent media', 'recent initial timestamp'] as const)('waits beyond the retry cap for growth at %s', async kind => {
  vi.setSystemTime(new Date('2026-10-24T12:00:00Z'));
  const base = Date.now() / 1000 - (kind === 'explicit live' ? 3600 : 120);
  const errors: string[] = [], cursors: string[] = [];
  let lists = 0;
  const get = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.includes('playlist')) {
      lists++; cursors.push(new URL(url).searchParams.get('ts')!);
      const text = lists <= 16
        ? (kind === 'recent initial timestamp' ? '' : playlist(base))
        : playlist(base + 1, 'b');
      return new Response(text);
    }
    return new Response(String((options?.headers as Record<string, string>)?.Range).startsWith('bytes=0-') ? init : fragment());
  });
  vi.stubGlobal('fetch', get);
  const f = createFeed(video(), { onError: r => errors.push(r) }); feeds.push(f);
  f.start(`http://test/playlist?ts=${base}`, { ...opts, base, end: base + 1, live: kind === 'explicit live' });
  await vi.advanceTimersByTimeAsync(14000);
  expect(lists).toBe(kind === 'recent initial timestamp' ? 15 : 16);
  expect(errors).toEqual([]);
  expect(cursors.slice(1, 15)).toEqual(Array(14).fill(String(base + (kind === 'recent initial timestamp' ? 0 : 1))));
  await vi.advanceTimersByTimeAsync(2000);
  expect(errors).toEqual([]);
  expect(MediaDouble.instances[0].buffer.data).toEqual(kind === 'recent initial timestamp' ? [2] : [1, 2]);
  expect(lists).toBe(kind === 'recent initial timestamp' ? 18 : 19);
  expect(get).toHaveBeenCalledTimes(kind === 'recent initial timestamp' ? 20 : 23);
  expect(MediaDouble.instances).toHaveLength(1);
  expect(MediaDouble.instances[0].endOfStream).not.toHaveBeenCalled();
});

it('continuous reports playlist:empty after 12 empty refreshes that never delivered a fragment', async () => {
  const errors: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  const f = createFeed(new VideoDouble() as unknown as HTMLVideoElement, { onError: (r: string) => errors.push(r) });
  feeds.push(f);
  f.start('http://test/playlist.m3u8?ts=1000', opts);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(5000 * 5);
  expect(errors).toEqual([]);                                    // below the cap: still waiting
  await vi.advanceTimersByTimeAsync(5000 * 9);
  expect(errors).toEqual(['playlist:empty']);                    // cap reached: ONE explicit failure
});
