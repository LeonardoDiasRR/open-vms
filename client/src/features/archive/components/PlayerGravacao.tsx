import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createFeed, type Feed, type FeedState } from '../services/feed-mse';
import { useT } from '@/shared/i18n';
import { syncAction, type PlaybackSample } from '../services/playback-sync';
import { classifyFailure } from '../services/playback-errors';
import { playbackMetric } from '../services/playback-metrics';
import { qualityFor, type QualityState } from '../services/playback-quality';

// spec 2026-10-19 (state-feedback of the cell): the player also SPEAKS what it is doing. The
// Archive cell measured too much silent black screen (HEVC needs server-side transcoding; a cold
// window = seconds with no frame) — the parent receives `onState` and draws the centre of the cell.
// `ready` = first frame presented (`loadeddata`); `transcoding` covers the retry with videoCodec=h264.
export type PlayerState = {
  kind: FeedState | 'transcoding' | 'recovering' | 'ready' | 'error';
  message?: string;
  quality?: 'preview';
};

// spec 2026-10-19 (rev.2): the engine is the MSE feed (`feed-mse.ts`) — a single <video>,
// SourceBuffer in `sequence` mode, 30 s buffer and continuous stitching between hour files. The
// visible contract is the same as the previous engine: the player does NOT know files; it asks the
// server for the playlist of the window (route `play/<profile>/playlist.m3u8`) and switches the
// window when the seek falls outside what is loaded. The default mode is minimal (play/pause, video
// timeline, speed, now, fullscreen and `...`); the full mode (the `...`) has timecode, 10 s jump,
// frame step, export and shortcuts. No volume control: there is no audio in the recording.
//
// The visible position is `epochAt(currentTime)`: with the continuous buffer of rev.2 that is `base
// + currentTime` while nothing was skipped (the standing invariant) and it follows the feed anchor
// table after a long seek. Every relative displacement (←/→, ±10 s, frame step, timecode) starts
// from the PLAYHEAD, never from `ts`.
export const WINDOW = 120;                 // default playlist window (spec 5.3)
export const SPEEDS = [1, 2, 4];
const SHORTCUT_STEP = 5;                   // ←/→ move 5 s (spec 5.4)
const FULL_STEP = 10;                      // jump of the full mode
const FRAME_FALLBACK = 1 / 25;             // one nominal frame at 25 fps (the profile does not report the rate)
// A range with less media than this left is spent: the player is parked at its tail, not playing it.
const SUCCESSOR_TAIL_S = 1;

export type PlayerHandle = {
  seek: (ts: number) => void;              // the TimelineBar calls this on click/drag of the cursor
  toggle: () => void;
  play: (v: boolean) => void;              // page/global clock: deterministic play/pause on every cell
  now: () => void;
  speed: () => number;                     // read: whoever draws the bar knows the current pace
  setSpeed: (v: number) => void;           // write: the page/shortcut drives the player
  sample?: () => PlaybackSample;
  sync?: (target: number, rate: number) => void;
};

type Api = { base: string; token: string };
type Props = {
  api: Api;
  profile: string | null;
  initialTs: number | null;
  initialSpeed?: number;
  onTime?: (ts: number) => void;
  onPlaying?: (playing: boolean) => void;
  onSpeed?: (v: number) => void;
  onExport?: () => void;
  onState?: (state: PlayerState) => void;  // centre-of-cell feedback (spec 2026-10-19)
  shortcuts?: boolean;                     // default true; the wall passes false (spec D11)
  autoPlay?: boolean;                      // window swap with the clock playing: resumes by itself
  covered?: boolean;                       // default true; false = playhead without coverage: do NOT ask
  continuous?: boolean;
  seekRequest?: { id: number; target: number };
  resumeTs?: number;
                                           // for the playlist (spec 2026-10-18 C3: fixes the "The media
                                           // could not be loaded" bubble from the 404; the visual
                                           // warning belongs to the cell)
};

// The URL of the window playlist. `ts` absent = window ending at now (the "live of the past").
export function playlistUrl(api: Api, profile: string, ts: number | null) {
  const q = new URLSearchParams({ token: api.token, janela: String(WINDOW) });
  if (ts !== null) q.set('ts', String(ts));
  return `${api.base}/api/v1/play/${encodeURIComponent(profile)}/playlist.m3u8?${q.toString()}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

const RecordingPlayer = forwardRef<PlayerHandle, Props>(function RecordingPlayer(
  { api, profile, initialTs, initialSpeed = 1, onTime, onPlaying, onSpeed, onExport, onState, shortcuts = true, autoPlay = false, covered = true, continuous = false, seekRequest, resumeTs }, ref,
) {
  const { t } = useT();
  // The translator also by ref: the feed listeners are born in the `[]` effect and would keep the
  // language of the first render.
  const tRef = useRef(t);
  tRef.current = t;
  const el = useRef<HTMLVideoElement>(null);
  const box = useRef<HTMLDivElement>(null);           // fullscreen target (native browser API)
  const feed = useRef<Feed | null>(null);
  // Epoch base of the LOADED window: the `ts` of the URL, or `now - WINDOW` in "now" mode.
  const base = useRef<number>(0);
  // The last epoch THIS player reported to the parent. It comes back through the `initialTs` prop
  // (the page returns the playhead on every `onTime`) and cannot be mistaken for a seek request.
  const reported = useRef<number | null>(null);
  // The last (URL, opts) handed to the feed: the transcoded retry restarts the SAME request with the
  // `videoCodec=h264` param (spec 2026-10-19 transcoder, player trigger).
  const request = useRef<{ url: string; opts: Parameters<Feed['start']>[1] } | null>(null);
  const presented = useRef<PlaybackSample>({ epoch: initialTs ?? 0, ready: false, presentedAt: 0 });
  const lastHardSeek = useRef(-Infinity);
  const lastCommand = useRef(seekRequest?.id);
  const preferredCodec = useRef<{ profile: string | null; codec: string } | null>(null);
  const profileRef = useRef(profile); profileRef.current = profile;
  const recoveryTimes = useRef<number[]>([]);
  const recoveryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const started = useRef(performance.now());
  const bufferSince = useRef<number | null>(null);
  const stalls = useRef<number[]>([]);
  const quality = useRef<QualityState>({ preview: false, changedAt: -Infinity });
  const qualityWindow = useRef({ at: 0, frames: 0, dropped: 0 });
  const qualityReported = useRef(false);
  const [preview, setPreview] = useState(false);
  const [ts, setTs] = useState<number | null>(initialTs);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(initialSpeed);
  const [position, setPosition] = useState(0);   // currentTime of the video: the value of the video timeline
  const [full, setFull] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Marker of server-side transcoding after the videoCodec=h264 retry (inherited task 4.1).
  const [transcoding, setTranscoding] = useState(false);

  // The parent callbacks, always the ones of the LAST render: the listeners are born in the `[]`
  // effect and a closure of the 1st render would keep `onTime`/`onPlaying` stuck in it.
  const cb = useRef({ onTime, onPlaying, onSpeed, onState });
  cb.current = { onTime, onPlaying, onSpeed, onState };

  // Is the server-side transcode in flight? The feed does not know: on retrying with
  // videoCodec=h264 the RecordingPlayer marks it here, and the feed `onState` becomes `transcoding`
  // until the first frame.
  const transcodingRef = useRef(false);

  // The current speed also by ref: the `loadedmetadata` listener is born in the `[]` effect.
  const speedRef = useRef(speed);
  speedRef.current = speed;

  // Creates the feed ONCE and disposes it on unmount. The <video> is ALWAYS mounted — including with
  // a null `profile` — so the feed is born with the component and starts asking for the playlist
  // when the profile arrives (a stage without profile only leaves the layout).
  useEffect(() => {
    const v = el.current;
    if (!v) return undefined;
    const f = createFeed(v, {
      onRepresentation: kind => { qualityReported.current = kind === 'preview'; },
      onState: (e) => {
        if (e === 'buffering' && bufferSince.current === null) {
          bufferSince.current = performance.now(); stalls.current.push(performance.now());
        }
        if (e === 'ready' && bufferSince.current !== null) {
          playbackMetric(v, 'buffering-ms', performance.now() - bufferSince.current); bufferSince.current = null;
        }
        cb.current.onState?.({ kind: transcodingRef.current && e !== 'ready' ? 'transcoding' : e,
          ...(qualityReported.current ? { quality: 'preview' } : {}) });
      },
      // defect measured 2026-10-19: playlist 404 (instant without recording) drew a bubble over the
      // stage; with the feed there is no bubble at all — the warning goes in the bar. Before giving
      // up, ONE retry with server-side transcoding; the "already transcoded" flag comes from the URL.
      onError: (reason) => {
        const p = request.current;
        const kind = classifyFailure(reason);
        if (kind === 'quota' && import.meta.env.VITE_ARCHIVE_ADAPTIVE_PREVIEW === '1'
            && speedRef.current >= 4 && !quality.current.preview) {
          quality.current = { preview: true, changedAt: performance.now() };
          setTs(f.epochAt(f.currentTime())); setPreview(true); return;
        }
        if (p && kind === 'codec' && reason !== 'codec:h264' && !p.url.includes('videoCodec=h264')) {
          // ponytail: the `&` is always valid — playlistUrl always builds the query with a token.
          p.url = `${p.url}&videoCodec=h264`;
          preferredCodec.current = { profile: profileRef.current, codec: 'h264' };
          const target = Math.max(p.opts.base, f.epochAt(f.currentTime()));
          const u = new URL(p.url); u.searchParams.set('ts', String(target));
          p.url = u.href; p.opts = { ...p.opts, base: target, end: target + WINDOW };
          base.current = target; f.start(p.url, p.opts);
          setTranscoding(true);
          transcodingRef.current = true;
          cb.current.onState?.({ kind: 'transcoding' });
          return;
        }
        const now = performance.now();
        recoveryTimes.current = recoveryTimes.current.filter(t => now - t < 60000);
        if (p && kind === 'network' && recoveryTimes.current.length < 2 && !recoveryTimer.current) {
          recoveryTimes.current.push(now);
          cb.current.onState?.({ kind: 'recovering' });
          recoveryTimer.current = setTimeout(() => {
            recoveryTimer.current = undefined;
            if (request.current !== p) return;
            const target = Math.max(p.opts.base, f.epochAt(f.currentTime()));
            const u = new URL(p.url); u.searchParams.set('ts', String(target));
            p.url = u.href; p.opts = { ...p.opts, base: target, end: target + WINDOW };
            base.current = target; f.start(p.url, p.opts);
          }, 1000 * recoveryTimes.current.length);
          return;
        }
        const keys = { codec: 'archive.codec_unsupported', auth: 'archive.session_expired',
          forbidden: 'archive.access_denied', missing: 'archive.no_recording_point', network: 'archive.connection_failed',
          decode: 'archive.decode_failed', quota: 'archive.buffer_full', fatal: 'archive.load_failed' } as const;
        const message = tRef.current(keys[kind]);
        setNotice(message);
        cb.current.onState?.({ kind: 'error', message });
      },
    });
    feed.current = f;
    let lastPaint = -Infinity;
    const onTimeUpdate = () => {
      const cur = f.currentTime();
      const instant = f.epochAt(cur);
      presented.current = { epoch: instant, ready: v.readyState >= 2, presentedAt: performance.now() };
      if (performance.now() - lastPaint < 100) return;
      lastPaint = performance.now(); setPosition(cur);
      if (v.getVideoPlaybackQuality) playbackMetric(v, 'dropped-frames', v.getVideoPlaybackQuality().droppedVideoFrames);
      const now = performance.now();
      if (v.getVideoPlaybackQuality && now - qualityWindow.current.at >= 5000) {
        const stats = v.getVideoPlaybackQuality(), old = qualityWindow.current;
        stalls.current = stalls.current.filter(t => now - t < 30000);
        const next = qualityFor({ enabled: import.meta.env.VITE_ARCHIVE_ADAPTIVE_PREVIEW === '1',
          rate: speedRef.current, frames: Math.max(0, stats.totalVideoFrames - old.frames),
          dropped: Math.max(0, stats.droppedVideoFrames - old.dropped), stalls: stalls.current.length, now }, quality.current);
        qualityWindow.current = { at: now, frames: stats.totalVideoFrames, dropped: stats.droppedVideoFrames };
        if (next.preview !== quality.current.preview) { setTs(instant); setPreview(next.preview); }
        quality.current = next;
      }
      reported.current = instant;
      cb.current.onTime?.(instant);
    };
    const onPlayback = () => { setPlaying(!f.paused()); cb.current.onPlaying?.(!f.paused()); };
    // DEFECT 2026-10-19: every new `src` (window swap, transcoded retry) makes the browser RESET the
    // playbackRate on load. The rate only takes after the new media loads: `loadedmetadata`.
    const onMetadata = () => f.setSpeed(speedRef.current);
    // First frame presented: the centre of the cell stops spinning (state-feedback spec).
    const onFirstFrame = () => {
      onTimeUpdate();
      setNotice(null); playbackMetric(v, 'first-frame-ms', performance.now() - started.current);
      transcodingRef.current = false;
      cb.current.onState?.({ kind: 'ready', ...(qualityReported.current ? { quality: 'preview' } : {}) });
    };
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('play', onPlayback);
    v.addEventListener('pause', onPlayback);
    v.addEventListener('loadedmetadata', onMetadata);
    v.addEventListener('loadeddata', onFirstFrame);
    let frame = 0;
    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      onTimeUpdate(); presented.current.epoch = f.epochAt(metadata.mediaTime);
      frame = v.requestVideoFrameCallback(onFrame);
    };
    if (continuous && typeof v.requestVideoFrameCallback === 'function') frame = v.requestVideoFrameCallback(onFrame);
    return () => {
      v.removeEventListener('timeupdate', onTimeUpdate);
      v.removeEventListener('play', onPlayback);
      v.removeEventListener('pause', onPlayback);
      v.removeEventListener('loadedmetadata', onMetadata);
      v.removeEventListener('loadeddata', onFirstFrame);
      if (frame) v.cancelVideoFrameCallback?.(frame);
      clearTimeout(recoveryTimer.current);
      f.destroy();
      feed.current = null;
    };
  }, []);

  // The window: every change of `ts` restarts the feed on the playlist of the new window (the hour
  // turn is the window turn). With `covered` false the player stays mute: with no recording in the
  // window no playlist is requested at all (spec 2026-10-18 C3).
  useEffect(() => {
    const f = feed.current;
    if (!f) return;
    clearTimeout(recoveryTimer.current); recoveryTimer.current = undefined;
    if (!profile || !covered) { f.stop?.(); return; }
    const target = continuous ? resumeTs ?? ts : ts;
    base.current = target === null ? nowSeconds() - WINDOW : target;
    setPosition(0);            // the new feed restarts at currentTime 0
    setTranscoding(false);     // a new window starts on the original URL: the marker follows it
    transcodingRef.current = false;
    request.current = {
      url: playlistUrl(api, profile, target),
      opts: { base: base.current, live: target === null, end: target === null ? Infinity : target + WINDOW,
        ...(continuous ? { continuous: true } : {}) },
    };
    if (preferredCodec.current?.profile === profile) request.current.url += '&videoCodec=h264';
    if (preview) request.current.url += `&quality=preview&previewRate=${speedRef.current}`;
    started.current = performance.now();
    f.start(request.current.url, request.current.opts);
    // window remount with the clock playing (key in the cell, ArchiveView): the new feed resumes
    if (autoPlay) f.play(true);
  }, [api.base, api.token, profile, ts, covered, continuous, preview, preview ? speed : 0]);

  // The playhead in epoch: the feed anchor table (identity `base + currentTime` without skips).
  function playhead() {
    const f = feed.current;
    return f ? f.epochAt(f.currentTime()) : base.current;
  }

  function seek(target: number) {
    if (!profile) return;
    setNotice(null);
    reported.current = target;
    if (!continuous && (target < base.current || target >= base.current + WINDOW)) { setTs(target); return; }
    const cur = Math.max(0, target - base.current);
    feed.current?.seekEpoch(target);
    setPosition(cur);
    cb.current.onTime?.(target);
  }

  // The `initialTs` is the PAGE request (seed the playhead, return to the snapshot, jump by hour,
  // switch camera). The `timeupdate` echo arrives through the SAME prop: what comes back equal to
  // the last instant this player reported is ignored — otherwise every `timeupdate` would reload
  // the window.
  useEffect(() => {
    if (initialTs === null || initialTs === reported.current) return;
    seek(initialTs);
  }, [initialTs]);

  useEffect(() => {
    if (seekRequest && lastCommand.current !== seekRequest.id) {
      lastCommand.current = seekRequest.id; seek(seekRequest.target);
    }
  }, [seekRequest?.id]);

  useEffect(() => { feed.current?.play(autoPlay && covered); }, [autoPlay, covered]);

  function toggle() {
    const f = feed.current;
    if (!f) return;
    f.play(f.paused());
  }

  function now() {
    setNotice(null);
    setTs(null);            // no `ts` = window ending at now
  }

  function changeSpeed(v: number) {
    if (v < 4 && quality.current.preview) {
      quality.current = { preview: false, changedAt: performance.now() };
      setTs(playhead()); setPreview(false);
    }
    setSpeed(v);
    feed.current?.setSpeed(v);
    cb.current.onSpeed?.(v);
  }

  // The speed requested by the page (the snapshot that came back) drives the player; direct
  // read/write stays in the handle, for whoever draws the bar.
  useEffect(() => { changeSpeed(initialSpeed); }, [initialSpeed]);

  // spec 5.4: a REAL frame, paused. The step is a short seek in MEDIA time (`currentTime`), never in
  // the rounded epoch: `Math.round(epoch + 1/25) === epoch` produced a seek to the start of the
  // window. With `requestVideoFrameCallback` available the instant is only reported after the new
  // frame was presented; without it (jsdom/old browser), the short seek is the step.
  function stepFrame(dir: 1 | -1) {
    const f = feed.current;
    if (!f || !profile) return;
    if (!f.paused()) f.play(false);
    const cur = Math.max(0, f.currentTime() + dir * FRAME_FALLBACK);
    f.seek(cur);
    setPosition(cur);
    const report = () => {
      const instant = Math.round(f.epochAt(cur));
      reported.current = instant;
      cb.current.onTime?.(instant);
    };
    // ponytail: the cast exists because jsdom (and the old lib.dom) does not declare requestVideoFrameCallback
    const v = el.current as unknown as { requestVideoFrameCallback?: (fn: () => void) => number } | null;
    if (v && typeof v.requestVideoFrameCallback === 'function') v.requestVideoFrameCallback(report);
    else report();
  }

  useImperativeHandle(ref, () => ({
    seek, toggle, now,
    play: (v: boolean) => { feed.current?.play(v); },
    speed: () => speed,
    setSpeed: changeSpeed,
    sample: () => {
      const v = el.current, f = feed.current;
      const ready = !!v && !!f && v.readyState >= 3 && !v.error;
      const currentTime = f?.currentTime() ?? 0;
      const sample: PlaybackSample = { epoch: f ? f.epochAt(currentTime) : base.current,
        ready, presentedAt: presented.current.presentedAt };
      // ponytail: only native buffered evidence; recovery belongs to the wall coordinator.
      if (v && f && !ready && !v.error) {
        const ranges = v.buffered;
        for (let i = 0; i < ranges.length; i++) {
          const start = ranges.start(i);
          // Inside a range that still has media ahead: the player is playing, so no successor.
          if (start <= currentTime && ranges.end(i) - currentTime > SUCCESSOR_TAIL_S) break;
          if (start > currentTime) { sample.nextEpoch = f.epochAt(start); break; }
        }
      }
      return sample;
    },
    sync: (target, rate) => {
      const f = feed.current;
      if (!f || !covered) return;
      const epoch = presented.current.ready ? presented.current.epoch : f.epochAt(f.currentTime());
      if (el.current) playbackMetric(el.current, 'drift-ms', (target - epoch) * 1000);
      const action = syncAction(epoch, target, rate, performance.now() - lastHardSeek.current);
      if (action.seek !== null) { lastHardSeek.current = performance.now(); seek(action.seek); }
      f.setSpeed(action.rate);
    },
  }), [profile, speed, covered, continuous]);

  // Fixed shortcuts (spec 5.4): space, ←/→ (±5 s), ↑/↓ (speed) and `n` (now). Capture, because a
  // parent handler could swallow the key.
  useEffect(() => {
    if (!shortcuts) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // A text field keeps the key to itself. The timeline slider does not type: the shortcuts stay
      // valid with it focused (otherwise clicking the bar would kill the keyboard).
      const typing = !!target && (/^(TEXTAREA|SELECT)$/.test(target.tagName)
        || (target.tagName === 'INPUT' && (target as HTMLInputElement).type !== 'range'));
      if (typing) return;
      if (!profile) return;
      if (e.key === ' ') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        seek(Math.round(playhead() + (e.key === 'ArrowLeft' ? -SHORTCUT_STEP : SHORTCUT_STEP)));
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const i = SPEEDS.indexOf(speed);
        changeSpeed(SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, i + (e.key === 'ArrowUp' ? 1 : -1)))]);
      } else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); now(); }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [profile, speed, shortcuts]);

  return (
    <div className="player-gravacao" ref={box}>
      {/* The stage stays in the DOM without a profile (the feed already exists); it only leaves the layout. */}
      <div className="player-palco" style={profile ? undefined : { display: 'none' }}>
        <video ref={el} playsInline />
      </div>

      {!profile && <div className="player-empty muted">{t('archive.no_recording_period')}</div>}

      {profile && (
        <div className="player-bar">
          <button title={playing ? t('archive.pause') : t('archive.play')} aria-label={playing ? t('archive.pause') : t('archive.play')} onClick={toggle}>
            {playing ? '❚❚' : '▶'}
          </button>
          {/* The VIDEO timeline (spec 5.4): the cursor inside the loaded window, in seconds. */}
          <input type="range" aria-label={t('archive.video_timeline')} min={0} max={WINDOW} step={1}
            value={Math.min(WINDOW, Math.round(position))}
            onChange={(e) => seek(Math.round(base.current + Number(e.target.value)))} />
          <button title={t('archive.speed')} aria-label={t('archive.speed')} onClick={() => changeSpeed(
            SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(speed) + 1)])}>{speed}×</button>
          <button title={t('archive.now')} aria-label={t('archive.now')} onClick={now}>{t('archive.now')}</button>
          <button title={t('archive.fullscreen')} aria-label={t('archive.fullscreen')} onClick={() => {
            if (document.fullscreenElement) document.exitFullscreen?.();
            else box.current?.requestFullscreen?.();
          }}>⛶</button>
          <button className="spacer-left" title={full ? t('archive.close_options') : t('archive.more_options')}
            aria-label={full ? t('archive.close_options') : t('archive.more_options')} onClick={() => setFull((c) => !c)}>⋯</button>
          {notice && <span className="player-estado">{notice}</span>}
          {transcoding && <span className="player-estado">{t('archive.h264_server')}</span>}
        </div>
      )}

      {profile && full && (
        <div className="player-completo">
          <label>{t('archive.timecode')}
            <input type="text" placeholder="HH:MM:SS" onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const s = e.currentTarget.value.trim();
              const m = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(s);
              if (!m) { setNotice(t('archive.invalid_timecode')); return; }
              const d = new Date(playhead() * 1000);
              d.setHours(+m[1], +m[2], +m[3], 0);
              seek(Math.floor(d.getTime() / 1000));
            }} />
          </label>
          <button aria-label={t('archive.back_10s')} title={t('archive.back_10s')} onClick={() => seek(Math.round(playhead() - FULL_STEP))}>−10s</button>
          <button aria-label={t('archive.forward_10s')} title={t('archive.forward_10s')} onClick={() => seek(Math.round(playhead() + FULL_STEP))}>+10s</button>
          <button aria-label={t('archive.previous_frame')} title={t('archive.previous_frame')} onClick={() => stepFrame(-1)}>◀|</button>
          <button aria-label={t('archive.next_frame')} title={t('archive.next_frame')} onClick={() => stepFrame(1)}>|▶</button>
          <button aria-label={t('archive.export')} onClick={() => onExport?.()}>{t('archive.export_period')}</button>
          <span className="muted">{t('archive.shortcuts')}</span>
        </div>
      )}
    </div>
  );
});

export default RecordingPlayer;

