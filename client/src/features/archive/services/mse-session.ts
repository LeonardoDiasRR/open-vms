import { bufferTarget, codecFromInit, parsePlaylist, type Feed, type FeedEvents, type Frag } from './feed-mse';
import { abortError, request, sourceOpened, update } from './mse-operations';
import { decodeTime, mediaTimescale } from './mse-timing';
import { playbackMetric } from './playback-metrics';

type Options = Parameters<Feed['start']>[1];
type Session = {
  ctl: AbortController; url: string; opts: Options; base: number; next: number;
  media: MediaSource; buffer?: SourceBuffer; objectUrl: string; busy: boolean;
  timer?: ReturnType<typeof setTimeout>; seen: Map<string, { end: number; bytes: number }>;
  init: string; fragments: Frag[]; first: boolean; empty: number; finished: boolean;
  mime: string; timescale: number; bytes: number; failed: boolean;
};
const active = new Set<Session>();
const MAX_BYTES = 32 * 1024 ** 2, WALL_BYTES = 128 * 1024 ** 2, BACK = 15;
const EMPTY_FRESH = 12, EMPTY_POLL_MS = 5000;
// ponytail: infer the edge from the 120 s nominal window plus one historical retry budget,
// not the selected day or opts.end (which ends only a request window).
const EDGE_SECONDS = 120 + EMPTY_FRESH * EMPTY_POLL_MS / 1000;
const fragmentId = (f: Frag) => `${f.url}#${f.ini}`;

export function createSessionFeed(video: HTMLVideoElement, events: FeedEvents): Feed {
  let current: Session | undefined;
  // ponytail: `crypto.randomUUID` only exists in a secure context (HTTPS/localhost); in HTTP by IP
  // (the production UI) it is undefined and the TypeError during render took down the whole React tree.
  // The id is only the `?client=` label of the transcode session. It is not a security value.
  const clientId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  let representation = '';
  let desiredPlay = false, rate = 1;
  const valid = (s: Session) => current === s && !s.ctl.signal.aborted;
  const ensure = (s: Session) => { if (!valid(s)) throw abortError(); };
  const resume = () => { if (desiredPlay && video.paused && video.readyState >= 2) void video.play().catch(() => {}); };
  const report = (s: Session, e: unknown) => {
    if (valid(s)) { s.failed = true; playbackMetric(video, 'error', 1); events.onError?.(e instanceof Error ? e.message : String(e)); }
  };
  const ahead = () => {
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) > video.currentTime) {
        return video.buffered.end(i) - video.currentTime;
      }
    }
    return 0;
  };
  async function trim(s: Session, aggressive = false) {
    const wanted = video.currentTime - (aggressive ? 2 : BACK), b = s.buffer!;
    // Remove whole completed GOP fragments. A cut inside a long GOP can make MSE remove frames
    // up to the next random-access point, including the frame currently being presented.
    const end = Math.max(0, ...[...s.seen.values()].map(f => f.end - s.base).filter(end => end <= wanted));
    if (end <= 0 || !b.buffered.length || b.buffered.start(0) >= end) return;
    await update(b, s.ctl.signal, () => b.remove(0, end)); ensure(s);
    for (const [id, f] of s.seen) if (f.end <= end + s.base) { s.bytes -= f.bytes; s.seen.delete(id); }
  }
  async function append(s: Session, data: ArrayBuffer) {
    ensure(s);
    try { await update(s.buffer!, s.ctl.signal, () => s.buffer!.appendBuffer(data)); }
    catch (e) {
      ensure(s);
      if ((e as { name?: string })?.name !== 'QuotaExceededError') throw e;
      await trim(s, true);
      await update(s.buffer!, s.ctl.signal, () => s.buffer!.appendBuffer(data));
    }
    ensure(s);
  }
  async function init(s: Session, url: string, size: number) {
    if (s.init === url) return;
    const r = await request(url, s.ctl.signal, `bytes=0-${size - 1}`, () => playbackMetric(video, 'retry', 1));
    if (!r.ok) throw new Error(`init:${r.status}`);
    const data = await r.arrayBuffer(); ensure(s);
    if (data.byteLength !== size) throw new Error('init:range');
    const bytes = new Uint8Array(data), codecs = codecFromInit(bytes);
    const mime = `video/mp4; codecs="${codecs.join(',')}"`;
    if (!codecs.length || !MediaSource.isTypeSupported(mime)) throw new Error(codecs.some(c => c.startsWith('avc1')) ? 'codec:h264' : 'codec');
    if (!s.buffer) { s.buffer = s.media.addSourceBuffer(mime); s.buffer.mode = 'segments'; }
    else if (s.mime !== mime) {
      if (!s.buffer.changeType) throw new Error('codec');
      s.buffer.changeType(mime);
    }
    s.timescale = mediaTimescale(bytes); s.mime = mime;
    await append(s, data); s.init = url;
  }
  function schedule(s: Session, ms = 250) {
    if (!valid(s) || s.timer || s.finished || s.failed) return;
    s.timer = setTimeout(() => { s.timer = undefined; void pump(s); }, ms);
  }
  async function refresh(s: Session) {
    const u = new URL(s.url);
    u.searchParams.set('client', clientId);
    if (!s.first) u.searchParams.set('ts', String(s.next));
    u.searchParams.set('janela', String(Math.max(120, bufferTarget(rate))));
    const r = await request(u.href, s.ctl.signal, undefined, () => playbackMetric(video, 'retry', 1));
    if (r.status === 404 && s.first && !s.opts.live && !s.opts.continuous) throw new Error('playlist:404');
    const txt = r.ok ? await r.text() : ''; ensure(s);
    const p = txt ? parsePlaylist(txt, u.href) : null;
    if (p && (p.representation || 'original') !== representation) {
      representation = p.representation || 'original'; events.onRepresentation?.(representation);
    }
    let epoch = s.next;
    s.fragments = (p?.frags ?? []).map(f => {
      const ep = f.epoch ?? epoch; epoch = ep + f.dur;
      return { ...f, epoch: ep, initUrl: f.initUrl || p!.initUrl, initEnd: f.initEnd || p!.initEnd };
    }).filter(f => !s.seen.has(fragmentId(f)) && f.epoch! + f.dur > s.next - 0.001);
    if (s.fragments.length) {
      s.empty = 0;
      if (s.first) s.base = Math.min(s.opts.base, s.fragments[0].epoch!);
      s.first = false;
    } else s.empty++;
  }
  async function pump(s: Session): Promise<void> {
    if (!valid(s) || s.busy || s.finished || s.failed || s.media.readyState !== 'open') return;
    s.busy = true;
    let wait = 250;
    try {
      if (s.buffer) await trim(s);
      while (valid(s) && ahead() < bufferTarget(rate)) {
        if (!s.fragments.length) {
          if (!s.first && !s.opts.continuous && !s.opts.live && s.next >= s.opts.end) {
            s.media.endOfStream(); s.finished = true; break;
          }
          await refresh(s);
          if (!s.fragments.length) {
            const lag = Date.now() / 1000 - s.next;
            const edge = s.opts.live || (s.opts.continuous && lag >= 0 && lag <= EDGE_SECONDS);
            wait = edge ? 1000 : EMPTY_POLL_MS;
            if (s.opts.continuous && !edge && s.empty >= EMPTY_FRESH) throw new Error('playlist:empty');
            if (!s.opts.continuous && !s.opts.live && s.empty >= 3 && s.buffer) {
              s.media.endOfStream(); s.finished = true;
            }
            break;
          }
        }
        const f = s.fragments[0];
        if (!(f.size > 0 && f.size <= MAX_BYTES && f.dur > 0 && f.initEnd! > 0)) throw new Error('playlist:invalid');
        if (!s.first && s.seen.size && f.epoch! - s.base > video.currentTime + bufferTarget(rate)) break;
        const budget = Math.min(MAX_BYTES, WALL_BYTES / active.size);
        if (s.bytes + f.size > budget) {
          if (s.buffer) await trim(s, true);
          if (s.bytes + f.size > budget) {
            if (ahead() > 1) break;
            throw new Error('QuotaExceededError');
          }
        }
        await init(s, f.initUrl!, f.initEnd!);
        const r = await request(f.url, s.ctl.signal, `bytes=${f.ini}-${f.ini + f.size - 1}`, () => playbackMetric(video, 'retry', 1));
        if (!r.ok) throw new Error(`fragment:${r.status}`);
        const data = await r.arrayBuffer(); ensure(s);
        if (data.byteLength !== f.size) throw new Error('fragment:range');
        s.buffer!.timestampOffset = f.epoch! - s.base - decodeTime(data, s.timescale);
        await append(s, data);
        s.seen.set(fragmentId(f), { end: f.epoch! + f.dur, bytes: f.size }); s.bytes += f.size;
        playbackMetric(video, 'buffer-bytes', s.bytes);
        s.fragments.shift(); s.next = Math.max(s.next, f.epoch! + f.dur);
        // The first decodable frame may follow the requested decode time (B-frame preroll).
        const target = s.opts.base - s.base, b = s.buffer!.buffered;
        if (b.length && video.currentTime < Math.max(target, b.start(0))) video.currentTime = Math.max(target, b.start(0));
        video.playbackRate = rate; resume();
      }
    } catch (e) { if (valid(s)) report(s, e); }
    finally { s.busy = false; if (valid(s)) schedule(s, wait); }
  }
  function stop() {
    const s = current; current = undefined;
    if (s) { s.ctl.abort(); clearTimeout(s.timer); active.delete(s); URL.revokeObjectURL(s.objectUrl); }
    video.pause(); video.removeAttribute('src'); video.load();
  }
  function start(url: string, opts: Options) {
    stop();
    const media = new MediaSource();
    const s: Session = { ctl: new AbortController(), url, opts: { ...opts }, base: opts.base, next: opts.base,
      media, objectUrl: URL.createObjectURL(media), busy: false, seen: new Map(), init: '', fragments: [],
      first: true, empty: 0, finished: false, mime: '', timescale: 0, bytes: 0, failed: false };
    current = s; active.add(s); playbackMetric(video, 'start', 1); events.onState?.('connecting');
    const opening = sourceOpened(media, s.ctl.signal);
    video.src = s.objectUrl;
    void opening.then(() => { ensure(s); video.playbackRate = rate; events.onState?.('loading'); return pump(s); })
      .catch(e => { if (valid(s)) report(s, e); });
  }
  const ready = () => { events.onState?.('ready'); resume(); };
  const waiting = () => { if (desiredPlay) events.onState?.('buffering'); if (current) schedule(current); };
  const mediaError = () => { if (current) report(current, new Error(`media:${video.error?.code}`)); };
  video.addEventListener('canplay', ready); video.addEventListener('playing', ready);
  video.addEventListener('waiting', waiting); video.addEventListener('stalled', waiting); video.addEventListener('error', mediaError);
  return {
    start, stop, currentTime: () => video.currentTime, epochAt: t => (current?.base ?? 0) + t,
    paused: () => video.paused, play: v => { desiredPlay = v; if (v) resume(); else video.pause(); },
    setSpeed: v => { rate = v; video.playbackRate = v; if (current) schedule(current, 0); },
    seek: t => { video.currentTime = t; if (current) schedule(current, 0); },
    seekEpoch: epoch => {
      const s = current; if (!s) return;
      const t = epoch - s.base;
      for (let i = 0; i < video.buffered.length; i++) {
        if (t >= video.buffered.start(i) && t < video.buffered.end(i)) { video.currentTime = t; schedule(s, 0); return; }
      }
      const url = new URL(s.url); url.searchParams.set('ts', String(epoch));
      start(url.href, { ...s.opts, base: epoch, end: epoch + 120 });
    },
    destroy: () => {
      stop(); video.removeEventListener('canplay', ready); video.removeEventListener('playing', ready);
      video.removeEventListener('waiting', waiting); video.removeEventListener('stalled', waiting); video.removeEventListener('error', mediaError);
    },
  };
}
