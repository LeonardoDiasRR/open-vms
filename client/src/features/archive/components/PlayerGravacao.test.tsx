import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createRef, useState } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import RecordingPlayer, { WINDOW, SPEEDS, type PlayerHandle } from './PlayerGravacao';

// The mock lives in `vi.hoisted` because `vi.mock` is hoisted. The real feed (MSE) does not exist in
// jsdom: the double implements the Feed contract and IMITATES THE BROWSER EVENTS — `play` fires
// `play`/`pause` on the real <video>, and `start` zeroes the rate like a load does (defect measured
// 2026-10-19). The component only talks to the video through native events; the test fires the same.
const fake = vi.hoisted(() => {
  const state = {
    start: [] as { url: string; base: number; live: boolean; end: number }[],
    time: 0, rate: 1, playing: false, created: 0, destroyed: 0, screen: false,
    el: null as unknown as HTMLVideoElement | null,
    events: {} as { onError?: (m: string) => void; onState?: (e: 'connecting' | 'loading') => void },
  };
  const feed = {
    start: (url: string, o: { base: number; live: boolean; end: number }) => {
      // a new `start` restarts at 0 AND the browser zeroes the playbackRate on load (measured defect).
      // The real feed emits 'connecting' synchronously on the request: the double does too (spec 2026-10-19).
      state.start.push({ url, ...o }); state.time = 0; state.rate = 1;
      state.events.onState?.('connecting');
    },
    currentTime: () => state.time,
    seek: (t: number) => { state.time = t; },
    seekEpoch: (ep: number) => {
      const u = state.start[state.start.length - 1];
      state.time = Math.max(0, ep - (u ? u.base : 0));
    },
    play: (v: boolean) => {
      state.playing = v;
      state.el?.dispatchEvent(new Event(v ? 'play' : 'pause'));   // as the browser does
    },
    paused: () => !state.playing,
    setSpeed: (v: number) => { state.rate = v; },
    epochAt: (t: number) => {
      const u = state.start[state.start.length - 1];
      return (u ? u.base : 0) + t;
    },
    destroy: () => { state.destroyed += 1; },
  };
  return { state, feed };
});
vi.mock('../services/feed-mse', () => ({
  createFeed: (v: HTMLVideoElement, ev: { onError?: (m: string) => void; onState?: (e: 'connecting' | 'loading') => void }) => {
    fake.state.events = ev; fake.state.el = v; fake.state.created += 1; return fake.feed;
  },
  PREFETCH: 30,
}));

const api = { base: 'http://127.0.0.1:7101', token: 'tk-teste' };
const T0 = 1792339200;
const FRAME = 1 / 25;

const montar = (props: Record<string, unknown> = {}) => {
  const ref = createRef<PlayerHandle>();
  const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
  const t = render(<RecordingPlayer ref={ref} api={api} profile="p_rec" initialTs={T0} {...props} />, { wrapper });
  return { ...t, ref };
};

const videoEl = () => document.querySelector('video') as HTMLVideoElement;
// The same path the browser takes: the element fires the event, the component listener runs.
const disparar = (name: string) => act(() => { videoEl().dispatchEvent(new Event(name)); });
const openFull = () => fireEvent.click(screen.getByRole('button', { name: 'More options' }));

beforeEach(() => {
  fake.state.start.length = 0;
  fake.state.time = 0; fake.state.rate = 1; fake.state.playing = false;
  fake.state.created = 0; fake.state.destroyed = 0; fake.state.screen = false;
  fake.state.el = null; fake.state.events = {};
});

describe('RecordingPlayer (spec 2026-10-18 5.4 + 2026-10-19 rev.2)', () => {
  it.each([2, 4])('samples the actual feed position without another timeupdate (readyState=%s)', readyState => {
    const { ref } = montar({ continuous: true });
    Object.defineProperty(videoEl(), 'readyState', { configurable: true, value: readyState });
    fake.state.time = 5;
    disparar('timeupdate');
    const presentedAt = ref.current!.sample!().presentedAt;
    fake.state.time = 10;
    expect(ref.current!.sample!()).toEqual({ epoch: T0 + 10, ready: readyState >= 3, presentedAt });
  });

  it.each([
    { name: 'at the end of the first range', time: 10, ranges: [[0, 10], [12, 20], [30, 40]], next: 12 },
    { name: 'between disjoint ranges', time: 11, ranges: [[0, 10], [12, 20], [30, 40]], next: 12 },
    { name: 'after multiple past ranges', time: 20, ranges: [[0, 10], [12, 20], [30, 40]], next: 30 },
    { name: 'before the first range', time: 0, ranges: [[12, 20], [30, 40]], next: 12 },
    { name: 'inside continuous media', time: 10, ranges: [[0, 20]], next: undefined },
    { name: 'inside media before a later disjoint range', time: 10, ranges: [[0, 20], [30, 40]], next: undefined },
    { name: 'parked at the tail of the containing range', time: 19.5, ranges: [[0, 20], [30, 40]], next: 30 },
    { name: 'without buffered media', time: 10, ranges: [], next: undefined },
    { name: 'after all buffered media', time: 40, ranges: [[0, 10], [12, 20], [30, 40]], next: undefined },
  ])('reports only a real buffered successor: $name', ({ time, ranges, next }) => {
    const onTime = vi.fn();
    const { ref } = montar({ continuous: true, onTime });
    onTime.mockClear();
    Object.defineProperties(videoEl(), {
      readyState: { configurable: true, value: 2 },
      buffered: { configurable: true, value: {
        length: ranges.length,
        start: (i: number) => ranges[i][0],
        end: (i: number) => ranges[i][1],
      } },
    });
    // Use a discontinuous anchor mapping: successor epochs are not base + media time.
    const epochAt = vi.spyOn(fake.feed, 'epochAt').mockImplementation(t => T0 + t + (t >= 12 ? 80 : 0));
    const seek = vi.spyOn(fake.feed, 'seekEpoch');
    try {
      fake.state.time = time;
      const sample = ref.current!.sample!();
      expect(sample.epoch).toBe(fake.feed.epochAt(time));
      expect(sample.ready).toBe(false);
      expect(sample.nextEpoch).toBe(next === undefined ? undefined : fake.feed.epochAt(next));
      expect(fake.state.time).toBe(time);
      expect(seek).not.toHaveBeenCalled();
      expect(onTime).not.toHaveBeenCalled();
    } finally {
      seek.mockRestore();
      epochAt.mockRestore();
    }
  });

  it.each([false, true])('does not offer a successor while ready or in error (error=%s)', error => {
    const { ref } = montar({ continuous: true });
    Object.defineProperties(videoEl(), {
      readyState: { configurable: true, value: error ? 2 : 4 },
      error: { configurable: true, value: error ? { code: 3 } : null },
      buffered: { configurable: true, value: { length: 1, start: () => 12, end: () => 20 } },
    });
    fake.state.time = 10;
    expect(ref.current!.sample!().nextEpoch).toBeUndefined();
    expect(ref.current!.sample!().ready).toBe(!error);
  });

  it('a retained sampler does not read a detached video after unmount', () => {
    const { ref, unmount } = montar({ continuous: true });
    const sample = ref.current!.sample!;
    const video = videoEl();
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      buffered: { configurable: true, get: () => { throw new Error('detached buffer read'); } },
    });
    unmount();
    expect(video.isConnected).toBe(false);
    expect(sample()).toMatchObject({ ready: false });
    expect(sample().nextEpoch).toBeUndefined();
  });

  it('continuous cells consume repeated seek commands without restarting the initial feed', () => {
    const { rerender } = montar({ continuous: true, seekRequest: { id: 0, target: T0 } });
    expect(fake.state.start).toHaveLength(1);
    const props = { api, profile: 'p_rec', initialTs: T0, continuous: true };
    rerender(<RecordingPlayer {...props} seekRequest={{ id: 1, target: T0 + 40 }} />);
    expect(fake.state.time).toBe(40);
    fake.state.time = 80;
    rerender(<RecordingPlayer {...props} seekRequest={{ id: 2, target: T0 + 40 }} />);
    expect(fake.state.time).toBe(40);
    expect(fake.state.start).toHaveLength(1);
  });
  it('asks for the playlist of the window with the profile, the ts and the 120 s window', () => {
    montar();
    expect(fake.state.start[0]).toEqual({
      url: `http://127.0.0.1:7101/api/v1/play/p_rec/playlist.m3u8?token=tk-teste&janela=${WINDOW}&ts=${T0}`,
      base: T0, live: false, end: T0 + WINDOW,
    });
  });

  it('the default mode shows the minimal commands (with the video timeline) and has no volume nor timecode', () => {
    montar();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fullscreen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speed' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Video timeline' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /volume/i })).toBeNull();
    expect(screen.queryByLabelText('timecode')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });

  it('the `...` opens the full mode with the five resources and closes it', () => {
    montar();
    openFull();
    expect(screen.getByLabelText('timecode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forward 10 s' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next frame' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByText(/shortcuts/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close options' }));
    expect(screen.queryByLabelText('timecode')).toBeNull();
  });

  it('seek OUTSIDE the loaded window swaps the playlist URL; inside, it only moves the time', async () => {
    const { ref } = montar();
    ref.current!.seek(T0 + 30);
    expect(fake.state.start.length).toBe(1);                 // inside the window: no reload
    expect(fake.state.time).toBe(30);
    ref.current!.seek(T0 + WINDOW + 600);                    // outside: swaps the window
    await waitFor(() => expect(fake.state.start.length).toBe(2));
    expect(fake.state.start[1].url).toContain(`ts=${T0 + WINDOW + 600}`);
  });

  it('the "now" button asks for the playlist WITHOUT ts (window ending at now)', async () => {
    const { ref } = montar();
    ref.current!.now();
    await waitFor(() => expect(fake.state.start.length).toBe(2));
    const u = fake.state.start[1];
    expect(u.url).not.toContain('ts=');
    expect(u.url).toContain(`janela=${WINDOW}`);
    expect(u.live).toBe(true);
    expect(u.end).toBe(Infinity);
  });

  it('←/→ move 5 s from the PLAYHEAD, never from the start of the window', () => {
    const onTime = vi.fn();
    const { ref } = montar({ onTime });
    ref.current!.seek(T0 + 30);                              // playhead 30 s inside the window
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(fake.state.time).toBe(35);
    expect(onTime).toHaveBeenLastCalledWith(T0 + 35);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(fake.state.time).toBe(30);
    expect(onTime).toHaveBeenLastCalledWith(T0 + 30);
  });

  it('the shortcuts stay valid with the video timeline focused (only a text field swallows them)', () => {
    const { ref } = montar();
    act(() => ref.current!.seek(T0 + 30));
    const slider = screen.getByRole('slider', { name: 'Video timeline' });
    slider.focus();
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(fake.state.time).toBe(35);
    fireEvent.keyDown(slider, { key: 'n' });
    expect(fake.state.start.length).toBe(2);
  });

  it('shortcuts={false} does not register the keyboard handler', () => {
    montar({ shortcuts: false });
    const spy = vi.spyOn(fake.feed, 'seekEpoch');
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(spy).not.toHaveBeenCalled();                      // no seek: the handler was never registered
    spy.mockRestore();
  });

  it('±10 s of the full mode start from the playhead (and not from the start of the window)', () => {
    const { ref } = montar();
    ref.current!.seek(T0 + 30);
    openFull();
    fireEvent.click(screen.getByRole('button', { name: 'Forward 10 s' }));
    expect(fake.state.time).toBe(40);
    fireEvent.click(screen.getByRole('button', { name: 'Back 10 s' }));
    expect(fake.state.time).toBe(30);
  });

  it('the video timeline shows the currentTime and dragging moves the playhead', () => {
    const { ref } = montar();
    act(() => ref.current!.seek(T0 + 30));
    const slider = screen.getByRole('slider', { name: 'Video timeline' }) as HTMLInputElement;
    expect(slider.value).toBe('30');
    fireEvent.change(slider, { target: { value: '45' } });
    expect(fake.state.time).toBe(45);
    expect(slider.value).toBe('45');
  });

  it('the time echo on `initialTs` (the page wiring) does NOT reload the window', () => {
    const ref = createRef<PlayerHandle>();
    function Page() {
      const [playhead, setPlayhead] = useState<number | null>(T0);
      return <RecordingPlayer ref={ref} api={api} profile="p_rec" initialTs={playhead} onTime={setPlayhead} />;
    }
    render(<Page />, { wrapper: LanguageProvider });
    act(() => ref.current!.seek(T0 + 30));                   // the page returns T0+30 as initialTs
    disparar('timeupdate');                                  // and timeupdate reports it again
    expect(fake.state.start.length).toBe(1);                 // no playlist swap
    expect(fake.state.time).toBe(30);                        // and the playhead stayed where the user put it
  });

  it('the frame step advances 1/25 s IN MEDIA TIME, paused, without the browser callback', () => {
    const { ref } = montar();
    ref.current!.seek(T0 + 30);
    openFull();
    fireEvent.click(screen.getByRole('button', { name: 'Previous frame' }));
    expect(fake.state.time).toBeCloseTo(30 - FRAME, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(fake.state.time).toBeCloseTo(30 - FRAME + FRAME, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    expect(fake.state.time).toBeCloseTo(30 + FRAME, 6);
  });

  it('the frame step uses requestVideoFrameCallback and ONLY reports after the frame is presented', () => {
    const frames: Array<() => void> = [];
    Object.defineProperty(HTMLVideoElement.prototype, 'requestVideoFrameCallback', {
      configurable: true,
      value: (f: () => void) => { frames.push(f); return frames.length; },
    });
    try {
      const onTime = vi.fn();
      montar({ onTime });
      openFull();
      fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
      expect(frames.length).toBe(1);                         // the new frame was requested from the browser
      const before = onTime.mock.calls.length;
      expect(before).toBe(1);                                // only the mount one (the seeding `seek`)
      act(() => { frames[0](); });                           // the browser presents the frame
      expect(onTime.mock.calls.length).toBe(before + 1);
      expect(onTime).toHaveBeenLastCalledWith(T0);           // 0.04 s rounds to the same second
    } finally {
      delete (HTMLVideoElement.prototype as unknown as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
    }
  });

  it('the feed is born with a null `profile` and asks for the playlist when the profile arrives', async () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
    const { container, rerender } = render(<RecordingPlayer api={api} profile={null} initialTs={T0} />, { wrapper });
    expect(container.querySelector('video')).not.toBeNull();       // the stage exists from the mount
    expect(fake.state.created).toBe(1);                            // the feed was created
    expect(fake.state.start.length).toBe(0);                       // and did not ask for a playlist yet
    expect(screen.getByText('No recording in this period')).toBeInTheDocument();
    rerender(<RecordingPlayer api={api} profile="p_rec" initialTs={T0} />);
    await waitFor(() => expect(fake.state.start.length).toBe(1));
    expect(fake.state.start[0].url).toContain('ts=' + T0);
    expect(screen.queryByText('No recording in this period')).toBeNull();
  });

  it('the initial speed comes from the prop and read/write stay in the handle', () => {
    const onSpeed = vi.fn();
    const { ref } = montar({ initialSpeed: 2, onSpeed });
    expect(fake.state.rate).toBe(2);
    expect(screen.getByRole('button', { name: 'Speed' })).toHaveTextContent('2×');
    expect(ref.current!.speed()).toBe(2);
    act(() => ref.current!.setSpeed(4));
    expect(fake.state.rate).toBe(4);
    expect(screen.getByRole('button', { name: 'Speed' })).toHaveTextContent('4×');
    expect(onSpeed).toHaveBeenLastCalledWith(4);
  });

  it('the speed cycle goes through 2x and 4x and stops at the 4x ceiling', () => {
    montar();
    const button = () => screen.getByRole('button', { name: 'Speed' });
    for (const v of [2, 4, 4]) {
      fireEvent.click(button());
      expect(fake.state.rate).toBe(v);
    }
    fireEvent.keyDown(window, { key: 'ArrowUp' });
    expect(fake.state.rate).toBe(4);
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(fake.state.rate).toBe(2);
  });

  it('SPEEDS has 1x, 2x and 4x — the 8x is gone', () => {
    expect(SPEEDS).toEqual([1, 2, 4]);
  });

  it('covered=false does not ask for the playlist; covered again does', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
    const { rerender } = render(<RecordingPlayer api={api} profile="p_rec" initialTs={T0} covered={false} />, { wrapper });
    expect(fake.state.start.length).toBe(0);
    rerender(<RecordingPlayer api={api} profile="p_rec" initialTs={T0} covered />);
    expect(fake.state.start.length).toBe(1);                 // the flip to true asks for the window
  });

  it('onTime/onPlaying are always the ones of the LAST render', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
    const ref = createRef<PlayerHandle>();
    const firstTime = vi.fn();
    const firstPlaying = vi.fn();
    const { rerender } = render(<RecordingPlayer ref={ref} api={api} profile="p_rec" initialTs={T0}
      onTime={firstTime} onPlaying={firstPlaying} />, { wrapper });
    const secondTime = vi.fn();
    const secondPlaying = vi.fn();
    rerender(<RecordingPlayer ref={ref} api={api} profile="p_rec" initialTs={T0}
      onTime={secondTime} onPlaying={secondPlaying} />);
    firstTime.mockClear(); firstPlaying.mockClear();
    disparar('timeupdate');
    expect(secondTime).toHaveBeenCalledWith(T0);
    expect(firstTime).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(secondPlaying).toHaveBeenCalledWith(true);
    expect(firstPlaying).not.toHaveBeenCalled();
  });

  it('`n` clears the notice and goes back to the now window', async () => {
    montar();
    openFull();
    const input = screen.getByLabelText('timecode');
    fireEvent.change(input, { target: { value: 'xx' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText('Invalid timecode')).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'n' });
    expect(screen.queryByText('Invalid timecode')).toBeNull();
    await waitFor(() => expect(fake.state.start.length).toBe(2));
    expect(fake.state.start[1].url).not.toContain('ts=');
  });

  it('the fullscreen button enters and leaves the fullscreen of the box', () => {
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true, get: () => fake.state.screen,
    });
    Element.prototype.requestFullscreen = () => { fake.state.screen = true; return Promise.resolve(); };
    document.exitFullscreen = () => { fake.state.screen = false; return Promise.resolve(); };
    try {
      montar();
      const button = screen.getByRole('button', { name: 'Fullscreen' });
      fireEvent.click(button);
      expect(fake.state.screen).toBe(true);
      fireEvent.click(button);
      expect(fake.state.screen).toBe(false);
    } finally {
      delete (document as unknown as { fullscreenElement?: unknown }).fullscreenElement;
    }
  });

  it('export actually calls the owner of the screen', () => {
    const onExport = vi.fn();
    montar({ onExport });
    openFull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('unmounting disposes the feed and releases the keyboard', () => {
    const { unmount } = montar();
    expect(fake.state.created).toBe(1);
    unmount();
    expect(fake.state.destroyed).toBe(1);
    fake.state.playing = false;
    fireEvent.keyDown(window, { key: ' ' });
    expect(fake.state.playing).toBe(false);                  // no listener was left on the window
  });

  it('unsupported codec retries ONCE with videoCodec=h264 on the same playlist URL', () => {
    montar();
    act(() => { fake.state.events.onError?.('codec'); });
    expect(fake.state.start.length).toBe(2);
    const url = fake.state.start[1].url;
    expect(url).toContain('&videoCodec=h264');
    expect(url).toContain(`ts=${T0}`);                       // same window, only the new codec
    expect(url).toContain('/api/v1/play/p_rec/playlist.m3u8');
  });

  it('a missing fragment, expired session or corruption never triggers H.264 transcoding', () => {
    montar();
    for (const reason of ['fragment:404', 'http:401', 'http:403', 'media:3', 'codec:h264']) {
      act(() => { fake.state.events.onError?.(reason); });
      expect(fake.state.start).toHaveLength(1);
    }
  });

  it('remembers the compatible representation on subsequent windows', async () => {
    const { ref } = montar();
    act(() => { fake.state.events.onError?.('codec'); });
    act(() => ref.current!.seek(T0 + 500));
    await waitFor(() => expect(fake.state.start).toHaveLength(3));
    expect(fake.state.start.at(-1)!.url).toContain('videoCodec=h264');
  });

  it('a second error with videoCodec=h264 applied shows the notice and there is NO third attempt', () => {
    montar();
    act(() => { fake.state.events.onError?.('codec'); });
    act(() => { fake.state.events.onError?.('fragment:404'); });
    expect(fake.state.start.length).toBe(2);                 // no 3rd load
    expect(screen.getByText('No recording to load at this point')).toBeInTheDocument();
  });

  it('window swap with 4x applied re-applies the speed on loadedmetadata (the new src zeroes the rate)', async () => {
    const { ref } = montar({ initialSpeed: 4 });
    expect(fake.state.rate).toBe(4);                         // current pace on the bar
    ref.current!.seek(T0 + WINDOW + 600);                    // outside the window: swaps the playlist
    await waitFor(() => expect(fake.state.start.length).toBe(2));
    expect(fake.state.rate).toBe(1);                         // the load zeroed the speed (the defect)
    disparar('loadedmetadata');                              // the new media loaded
    expect(fake.state.rate).toBe(4);                         // the player restored the requested speed
    expect(screen.getByRole('button', { name: 'Speed' })).toHaveTextContent('4×');
  });

  it('after the retry the bar shows the H.264 (server) marker', () => {
    montar();
    expect(screen.queryByText('H.264 (server)')).toBeNull();
    act(() => { fake.state.events.onError?.('codec'); });
    expect(screen.getByText('H.264 (server)')).toBeInTheDocument();
  });

  // spec 2026-10-19 (state-feedback): the Archive cell draws the centre with what the player knows
  it('speaks the state: connecting on the window request, ready on the first frame (loadeddata)', () => {
    const states: { kind: string }[] = [];
    montar({ onState: (e: { kind: string }) => states.push(e) });
    expect(states[0]).toEqual({ kind: 'connecting' });
    act(() => { fake.state.events.onState?.('loading'); });
    expect(states[states.length - 1]).toEqual({ kind: 'loading' });
    disparar('loadeddata');                                  // the browser presented the 1st frame
    expect(states[states.length - 1]).toEqual({ kind: 'ready' });
  });

  it('the transcoded retry becomes transcoding (the feed re-requests and the flag covers it); the final error becomes error with a message', () => {
    const states: { kind: string; message?: string }[] = [];
    montar({ onState: (e: { kind: string; message?: string }) => states.push(e) });
    act(() => { fake.state.events.onError?.('codec'); });
    expect(states.some((e) => e.kind === 'transcoding')).toBe(true);
    act(() => { fake.state.events.onState?.('loading'); });  // the feed re-request: still transcoding
    expect(states[states.length - 1]).toEqual({ kind: 'transcoding' });
    act(() => { fake.state.events.onError?.('codec'); });    // terminal
    expect(states[states.length - 1].kind).toBe('error');
    expect(states[states.length - 1].message).toBe('Codec not supported in this browser');
  });
});

