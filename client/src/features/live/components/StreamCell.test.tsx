import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import StreamCell from './StreamCell';
import { usePtz } from '@/features/live/hooks/usePtz';

const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const mount = (ui: ReactElement) => render(ui, { wrapper });

// jsdom has no WebRTC: the connection is ENVIRONMENT, not component logic. The fake keeps the instances so
// the test can fire the failure path ("No signal" state) without waiting the watchdog's 10 s, and records
// the SDP received to prove the answer was applied.
const rtc = vi.hoisted(() => {
  type Handler = (ev: unknown) => void;
  class FakePc {
    static instances: FakePc[] = [];
    transceivers: string[] = [];
    ontrack: Handler | null = null;
    onconnectionstatechange: Handler | null = null;
    connectionState = 'connecting';
    remoteSdp: string | null = null;
    closed = false;
    constructor(_cfg: unknown) { FakePc.instances.push(this); }
    addTransceiver(kind: string) { this.transceivers.push(kind); }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' }; }
    async setLocalDescription(_o: unknown) {}
    async setRemoteDescription(d: { sdp: string }) { this.remoteSdp = d.sdp; }
    close() { this.closed = true; }
  }
  return { FakePc, instances: FakePc.instances };
});

const requests: string[] = [];
const camera = { id: 'c1', name: 'Camera 1', state: 'online' };
const profiles = [{ id: 'p1', name: 'Main', width: 1920 }];
const api = { liveToken: async (_id: string) => ({ whep_url: 'http://127.0.0.1:8890/uuid/sub/whep', token: 'tk' }) };

beforeEach(() => {
  rtc.instances.length = 0;
  requests.length = 0;
  vi.stubGlobal('RTCPeerConnection', rtc.FakePc);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(String(url));
    return { ok: true, status: 201, text: async () => 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' };
  }));
});

describe('StreamCell', () => {
  it('asks for the token, negotiates the WHEP with the token in the query and applies the answer', async () => {
    const { container } = mount(<StreamCell api={api} camera={camera} profiles={profiles} mode="live" />);

    expect(container.querySelector('video')).not.toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
    expect(screen.getByText('Camera 1')).toBeInTheDocument();

    await waitFor(() => expect(rtc.instances).toHaveLength(1));
    const pc = rtc.instances[0];
    await waitFor(() => expect(pc.remoteSdp).toContain('m=video'));
    expect(pc.transceivers).toEqual(['video', 'audio']);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toBe('http://127.0.0.1:8890/uuid/sub/whep?ovms_token=tk');
  });

  it('without a profile it mounts no <video> and opens no connection (idle state)', () => {
    const { container } = mount(<StreamCell api={api} camera={camera} profiles={[]} />);

    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(rtc.instances).toHaveLength(0);
  });

  // PROJECT INVARIANT: the <video> stays MOUNTED in "No signal"; the warning is an overlapping sibling
  // (.no-signal), never a replacement. Unmounting the video would kill the retry.
  it('keeps the <video> mounted in "No signal" (overlapping warning, not a replacement)', async () => {
    const { container } = mount(<StreamCell api={api} camera={camera} profiles={profiles} />);
    await waitFor(() => expect(rtc.instances).toHaveLength(1));

    act(() => {
      const pc = rtc.instances[0];
      pc.connectionState = 'failed';
      pc.onconnectionstatechange?.(new Event('connectionstatechange'));
    });

    const warning = screen.getByText('No signal').closest('.no-signal');
    expect(warning).not.toBeNull();
    expect(warning).toHaveAttribute('title', 'WebRTC connection dropped');
    expect(screen.queryByRole('status')).toBeNull();

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(warning?.querySelector('video')).toBeNull();
  });

  it('the media that arrives clears the loading warning (ontrack + playing)', async () => {
    mount(<StreamCell api={api} camera={camera} profiles={profiles} />);
    await waitFor(() => expect(rtc.instances).toHaveLength(1));

    act(() => {
      rtc.instances[0].ontrack?.({ streams: [{ id: 's1' }], track: null });
    });

    expect(screen.queryByText('Loading…')).toBeNull();
  });

  it('the top strip carries the dot, the name and the actions; the bottom strip carries the profile and the mode', () => {
    const { container } = mount(
      <StreamCell api={api} camera={camera} profiles={profiles} mode="live" onRemove={() => {}} />,
    );
    const overlay = container.querySelector('.cell-overlay');
    const stream = container.querySelector('.cell-stream');
    expect(overlay).not.toBeNull();
    expect(stream).not.toBeNull();
    // top strip: dot to the left of the name, actions to the right
    expect(overlay!.querySelector('.badge')).not.toBeNull();
    expect(overlay!.querySelector('.cell-name')).toHaveTextContent('Camera 1');
    const actions = overlay!.querySelector('.cell-actions');
    expect(actions?.querySelector('button[title="Fullscreen"]')).not.toBeNull();
    expect(actions?.querySelector('button[title="Remove"]')).not.toBeNull();
    expect(overlay!.querySelector('.cell-profile')).toBeNull();
    expect(overlay!.querySelector('.cell-mode')).toBeNull();
    // bottom strip: active profile + mode
    expect(stream!.querySelector('.cell-profile')).toHaveTextContent('Main');
    expect(stream!.querySelector('.cell-mode')).toHaveTextContent('live');
  });
});

describe('StreamCell: PTZ instrument', () => {
  // The cell no longer creates the instrument (spec 2026-10-17): the state belongs to the hook. The harness
  // mounts the real hook and passes it along, as StageGrid does in production.
  // `ptzRef` hands the hook handle to the case: the panel (and its speed slider) only renders INSIDE
  // fullscreen, so outside it the speed can only be applied through the handle.
  const WithPtz = ({ api: apiProp, camera: cam, ptzRef }: { api: NonNullable<Parameters<typeof usePtz>[0]> & { liveToken: typeof api.liveToken }; camera: typeof camera & { can_control?: boolean }; ptzRef?: { current: ReturnType<typeof usePtz> | null } }) => {
    const ptz = usePtz(apiProp);
    if (ptzRef) ptzRef.current = ptz;
    // task 4.4: the instrument tests need the grant — a new server ALWAYS sends can_control; the harness
    // defaults it to true (cam may override with false/undefined to exercise the gated paths)
    return <StreamCell api={apiProp} camera={{ can_control: true, ...cam, ptz: { supported: true } }} profiles={profiles} ptz={ptz} />;
  };

  const root = () => document.querySelector('.stream-cell') as HTMLElement;

  // spec 2026-10-16: the instrument requires an IMAGE ON SCREEN, not the camera state. The first frame arrives
  // through ontrack (same canon as the 'clears the loading warning' case).
  const withImage = async () => {
    await waitFor(() => expect(rtc.instances).toHaveLength(1));
    act(() => { rtc.instances[0].ontrack?.({ streams: [{ id: 's1' }], track: null }); });
  };

  const ptzApi = () => {
    const moves: { pan: number; tilt: number; zoom: number }[] = [];
    let stops = 0;
    return {
      moves, get stops() { return stops; },
      api: {
        ...api,
        ptzCapability: async () => ({ supported: true }),
        ptzMove: async (_id: string, v: { pan: number; tilt: number; zoom: number }) => { moves.push(v); },
        ptzStop: async () => { stops += 1; },
      },
    };
  };

  it('does not show the target when the server did not prove PTZ', async () => {
    const noPtz = { ...api, ptzCapability: async () => ({ supported: false }) };
    mount(<StreamCell api={noPtz} camera={camera} profiles={profiles} />);
    await waitFor(() => expect(noPtz.ptzCapability).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'PTZ' })).toBeNull();
  });

  it('shows the target with the capability already on the camera object and arms on click', async () => {
    const { api: withPtz } = ptzApi();
    mount(<WithPtz api={withPtz} camera={camera} />);
    await withImage();
    const button = screen.getByRole('button', { name: 'PTZ' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.className).toContain('ativo');
    expect(root().className).toContain('ptz-ativo');
  });

  it('announces the PTZ mode in a live region (M3)', async () => {
    const { api: withPtz } = ptzApi();
    mount(<WithPtz api={withPtz} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const strip = root().querySelector('.cell-ptz-faixa');
    expect(strip?.getAttribute('role')).toBe('status');
    expect(strip?.getAttribute('aria-live')).toBe('polite');
  });

  it('with the instrument armed the drag sends PanTilt and releasing sends Stop; outside the mode nothing is sent', async () => {
    const st = ptzApi();
    const { api: withPtz, moves } = st;
    mount(<WithPtz api={withPtz} camera={camera} />);
    await withImage();
    const cell = root();
    // outside the mode: a drag generates no command
    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });
    fireEvent.pointerUp(cell);
    expect(moves.length).toBe(0);
    expect(st.stops).toBe(0);
    // in the mode: a 180 px drag to the right = maximum pan, tilt 0
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });
    await waitFor(() => expect(moves.length).toBe(1));
    expect(moves[0]).toEqual({ pan: 0.6, tilt: 0, zoom: 0 });
    fireEvent.pointerUp(cell);
    // releasing the button MUST stop the camera: it is the point that matters most in the instrument
    await waitFor(() => expect(st.stops).toBe(1));
  });

  it('arrows move, the mouse wheel and the zoom keys give a zoom step', async () => {
    const { api: withPtz, moves } = ptzApi();
    mount(<WithPtz api={withPtz} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(moves.length).toBe(1));
    expect(moves[0]).toEqual({ pan: -0.6, tilt: 0, zoom: 0 });
    await new Promise((r) => setTimeout(r, 120)); // passes the 80 ms throttle
    fireEvent.wheel(root(), { deltaY: -100 });
    await waitFor(() => expect(moves.length).toBe(2));
    expect(moves[1].zoom).toBe(0.6);
    fireEvent.keyUp(window, { key: 'ArrowLeft' });
  });

  // Regression of spec 2026-10-16 (online-state-through-the-hub): the instrument does not look at the camera
  // state — it requires an image on screen. The old case used state 'online' and so passed with the defect.
  it('a provisioning camera WITH an image on screen shows the target', async () => {
    const { api: withPtz } = ptzApi();
    mount(<WithPtz api={withPtz} camera={{ ...camera, state: 'provisioning' }} />);
    await withImage();
    expect(screen.getByRole('button', { name: 'PTZ' })).not.toBeNull();
  });

  it('without an image on screen (Loading…) it does not show the target, even with the camera online', async () => {
    const { api: withPtz } = ptzApi();
    mount(<WithPtz api={withPtz} camera={camera} />);
    await waitFor(() => expect(rtc.instances).toHaveLength(1));
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'PTZ' })).toBeNull();
  });

  // spec 2026-10-16: the cell dot follows the camera recording
  it('full dot with recording on and hollow without it', async () => {
    const { container, rerender, unmount } = mount(<StreamCell api={api} camera={{ ...camera, recording: true }} profiles={profiles} />);
    expect(container.querySelector('.badge')?.className).toContain('cheia');
    rerender(<StreamCell api={api} camera={{ ...camera }} profiles={profiles} />);
    expect(container.querySelector('.badge')?.className).not.toContain('cheia');
    unmount();
  });

  // A click on the action bar cannot enter the instrument: with the cell pointer capture Chrome hands the
  // click back to the cell and the button never turns off (defect measured in Chromium).
  it('a click on the action bar does not drag the camera and the second click turns it off', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    const button = screen.getByRole('button', { name: 'PTZ' });
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    const cell = root();
    fireEvent.pointerDown(button, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(cell, { clientX: 200, clientY: 10 });
    expect(st.moves.length).toBe(0);
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  // The parent handler runs before ours on the bubble path: listening in the capture phase is what guarantees
  // the arrows reach the instrument.
  // The intruder is registered BEFORE ours and kills propagation immediately: a bubble-phase listener
  // registered after it never runs. In the capture phase ours runs first and the arrow arrives.
  it('arrows arrive even with a handler registered before killing propagation', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    const intruder = (e: KeyboardEvent) => e.stopImmediatePropagation();
    window.addEventListener('keydown', intruder);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
      fireEvent.keyDown(window, { key: 'ArrowLeft' });
      await waitFor(() => expect(st.moves.length).toBe(1));
    } finally { window.removeEventListener('keydown', intruder); }
  });

  it('a refused command shows in the cell with the reason and disarms on 403', async () => {
    const error = Object.assign(new Error('insufficient role'), { status: 403 });
    const withError = {
      ...api,
      ptzCapability: async () => ({ supported: true }),
      ptzMove: async () => { throw error; },
      ptzStop: async () => {},
    };
    mount(<WithPtz api={withError} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByText(/insufficient role/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('button', { name: 'PTZ' })).toHaveAttribute('aria-pressed', 'false'));
  });

  // Defect measured in production on 2026-10-16 (bundle index-BAbM1YRx.js, exception on the page): ApiClient
  // defines ptzMove/ptzStop as methods that use `this.req`. Passed DETACHED to the instrument, `this` is
  // lost: "TypeError: this.req is not a function" BEFORE leaving the browser — no POST /ptz/move reached the
  // server. The mocks above are loose functions (no `this`), which is why they passed with the defect.
  it('sends the command with an api that depends on this (real ApiClient shape)', async () => {
    const moves: { pan: number; tilt: number; zoom: number }[] = [];
    const real = {
      ...api,
      ptzCapability: async () => ({ supported: true }),
      req(_method: string, url: string, body?: { pan: number; tilt: number; zoom: number }) {
        if (url.endsWith('/ptz/move') && body) moves.push(body);
        return Promise.resolve({ ok: true });
      },
      ptzMove(id: string, v: { pan: number; tilt: number; zoom: number }) {
        return this.req('POST', `/api/v1/cameras/${id}/ptz/move`, v);
      },
      ptzStop(id: string) { return this.req('POST', `/api/v1/cameras/${id}/ptz/stop`); },
    };
    mount(<WithPtz api={real} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    await waitFor(() => expect(moves).toHaveLength(1));
    expect(moves[0]).toEqual({ pan: -0.6, tilt: 0, zoom: 0 });
  });

  it('the glyph marks the state: hollow off, filled on', async () => {
    const st = ptzApi();
    const { container } = mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    expect(container.querySelector('.cell-ptz svg')?.getAttribute('data-filled')).toBe('no');
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    expect(container.querySelector('.cell-ptz svg')?.getAttribute('data-filled')).toBe('yes');
  });

  it('the video does not start a native drag (Chrome cancels pointer events mid-gesture)', async () => {
    const st = ptzApi();
    const { container } = mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    expect(container.querySelector('video')?.getAttribute('draggable')).toBe('false');
  });

  it('in fullscreen the PTZ panel is rendered INSIDE the cell', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    // the browser only paints the fullscreen element subtree: the panel has to be inside it
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => root() });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    expect(root().querySelector('.cell-painel-ptz .painel-ptz')).not.toBeNull();
  });

  it('the drag draws the target and the arrow in the box and the hint appears on the command', async () => {
    const { api: withPtz } = ptzApi();
    mount(<WithPtz api={withPtz} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    // the overlay lives INSIDE .cell-quadro and the gesture math is relative to the BOX (not the cell nor the
    // window). jsdom returns 0x0 for every element: without the injected measure the math gives NaN.
    const box = cell.querySelector('.cell-quadro') as HTMLElement;
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);

    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    const overlay = box.querySelector('.ptz-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('block');
    expect(overlay.style.left).toBe('100px');

    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });   // 180 px: full arrow
    expect((box.querySelector('.ptz-seta') as HTMLElement).style.width).toBe('180px');
    expect(box.querySelector('.ptz-aviso')).toHaveTextContent('Moving');

    fireEvent.pointerUp(cell);
    expect(overlay.style.display).toBe('none');
  });

  // ---- area selection with Shift + drag (spec 2026-10-18) ----
  const zoomApi = () => {
    const boxes: { left: number; top: number; right: number; bottom: number; aspect: number }[] = [];
    let undos = 0;
    return {
      boxes, get undos() { return undos; },
      api: {
        ...api,
        ptzCapability: async () => ({ supported: true }),
        ptzMove: async () => {}, ptzStop: async () => {},
        ptzZoomArea: async (_id: string, box: { left: number; top: number; right: number; bottom: number; aspect: number }) => { boxes.push(box); },
        ptzUndoZoom: async () => { undos += 1; },
      },
    };
  };

  // jsdom returns 0x0 for every element: the box measure has to be injected (pattern of the arrow case)
  const measureBox = () => {
    const box = root().querySelector('.cell-quadro') as HTMLElement;
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    return box;
  };

  it('Shift + drag draws the rectangle and does NOT send PanTilt (the gesture picks a single path)', async () => {
    const st = ptzApi();
    const { api: withPtz } = st;
    mount(<WithPtz api={withPtz} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    const box = measureBox();

    fireEvent.pointerDown(cell, { button: 0, shiftKey: true, clientX: 200, clientY: 90 });
    const rectangle = box.querySelector('.ptz-selecao') as HTMLElement;
    expect(rectangle.style.display).toBe('block');
    expect(rectangle.style.left).toBe('200px');
    fireEvent.pointerMove(cell, { clientX: 600, clientY: 270 });
    expect(rectangle.style.width).toBe('400px');
    // height locked to the 16/9 of the box (800x450): 400/(16/9) = 225 (Nx parity)
    expect(rectangle.style.height).toBe('225px');
    // the drag arrow does NOT appear and the camera receives no ContinuousMove
    expect((box.querySelector('.ptz-overlay') as HTMLElement).style.display).toBe('none');
    expect(st.moves.length).toBe(0);
    fireEvent.pointerUp(cell, { clientX: 600, clientY: 270 });
  });

  it('releasing with a valid box calls viewport-zoom ONCE with the normalized box', async () => {
    const st = zoomApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    const box = measureBox();

    fireEvent.pointerDown(cell, { button: 0, shiftKey: true, clientX: 200, clientY: 90 });
    fireEvent.pointerMove(cell, { clientX: 600, clientY: 270 });
    fireEvent.pointerUp(cell, { clientX: 600, clientY: 270 });
    await waitFor(() => expect(st.boxes).toHaveLength(1));
    // payload of the LOCKED rectangle (400x225 at 16/9, drag center preserved): top 67.5/450, bottom 292.5/450
    expect(st.boxes[0].left).toBe(0.25);
    expect(st.boxes[0].top).toBeCloseTo(0.15, 10);
    expect(st.boxes[0].right).toBe(0.75);
    expect(st.boxes[0].bottom).toBeCloseTo(0.65, 10);
    expect(st.boxes[0].aspect).toBeCloseTo(16 / 9, 10);
    // the rectangle disappears in ALL cases (spec 5.2, item 5)
    expect((box.querySelector('.ptz-selecao') as HTMLElement).style.display).toBe('none');
  });

  it('the zoom payload is the LOCKED rectangle, with the video proportion (Nx parity)', async () => {
    const st = zoomApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    // box 640x360 (16/9): the 300x150 drag (2:1) LOCKS at 300x168.75 around the center — the rectangle of the
    // Task 2.2 plan: x0=100, y0=40.625, x1=400, y1=209.375
    const box = cell.querySelector('.cell-quadro') as HTMLElement;
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
      { left: 0, top: 0, width: 640, height: 360, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);

    fireEvent.pointerDown(cell, { button: 0, shiftKey: true, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(cell, { clientX: 400, clientY: 200 });
    fireEvent.pointerUp(cell, { clientX: 400, clientY: 200 });
    await waitFor(() => expect(st.boxes).toHaveLength(1));
    const marked = st.boxes[0];
    expect(marked.left).toBe(100 / 640);
    expect(marked.top).toBeCloseTo(40.625 / 360, 10);
    expect(marked.right).toBe(400 / 640);
    expect(marked.bottom).toBeCloseTo(209.375 / 360, 10);
    // the proportion in PX of the sent rectangle is the video one (normalized*640 / normalized*360), not the raw drag one
    expect(((marked.right - marked.left) * 640) / ((marked.bottom - marked.top) * 360)).toBeCloseTo(16 / 9, 10);
    expect(marked.aspect).toBeCloseTo(16 / 9, 10);
  });

  it('a box with less than 12 px on one side fires no request', async () => {
    const st = zoomApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    const box = measureBox();

    // with the aspect lock a thin drag EXPANDS (Nx expands to the AR); the accidental click that fires nothing
    // is the small one on BOTH sides (w = max(dx, dy*ar) < 12)
    fireEvent.pointerDown(cell, { button: 0, shiftKey: true, clientX: 200, clientY: 90 });
    fireEvent.pointerMove(cell, { clientX: 211, clientY: 95 });
    fireEvent.pointerUp(cell, { clientX: 211, clientY: 95 });
    await waitFor(() => expect((box.querySelector('.ptz-selecao') as HTMLElement).style.display).toBe('none'));
    expect(st.boxes).toHaveLength(0);
  });

  it('a drag WITHOUT Shift stays the arrow one and draws no rectangle (acceptance 2)', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    const box = measureBox();

    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    expect((box.querySelector('.ptz-selecao') as HTMLElement).style.display).toBe('none');
    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });
    await waitFor(() => expect(st.moves.length).toBe(1));
    expect((box.querySelector('.ptz-overlay') as HTMLElement).style.display).toBe('block');
    fireEvent.pointerUp(cell);
  });

  it('the Shift gesture does NOT toggle the cell mark (border with the selected-cell spec)', async () => {
    const st = zoomApi();
    const clicks: number[] = [];
    mount(
      <div onClick={() => clicks.push(1)}>
        <WithPtz api={st.api} camera={camera} />
      </div>,
    );
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    // the click that ARMS the PTZ also crosses the wrapper: reset the count to measure only the gesture
    clicks.length = 0;
    const cell = root();
    const box = measureBox();

    fireEvent.pointerDown(cell, { button: 0, shiftKey: true, clientX: 200, clientY: 90 });
    fireEvent.pointerMove(cell, { clientX: 600, clientY: 270 });
    fireEvent.pointerUp(cell, { clientX: 600, clientY: 270 });
    // the browser fires `click` after mousedown+mouseup on the same element: Shift swallows it
    fireEvent.click(box);
    expect(clicks).toHaveLength(0);
    // an ordinary click still arrives (the mark of spec A needs it)
    fireEvent.click(box);
    expect(clicks).toHaveLength(1);
  });

  it('in PTZ mode the double click does ptzUnzoom and does not ask for fullscreen; outside the mode it stays fullscreen', async () => {
    const st = zoomApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    // the "PTZ panel in fullscreen" case of this file leaves a fullscreenElement getter on document; without
    // this line the first double click would think the cell is ALREADY in fullscreen
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });
    const cell = root();
    const full = vi.fn(() => Promise.resolve());
    (cell as unknown as { requestFullscreen: unknown }).requestFullscreen = full;
    fireEvent.doubleClick(cell);
    expect(full).toHaveBeenCalledTimes(1);
    expect(st.undos).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    fireEvent.doubleClick(cell);
    expect(st.undos).toBe(1);
    expect(full).toHaveBeenCalledTimes(1);
  });

  // spec 2026-10-18 (overlapping-menus): in fullscreen the PTZ panel lives INSIDE the cell and the root has the
  // camera menu onContextMenu. The two proofs below measure the coexistence.
  const withSavedPosition = () => {
    const withPosition = { ...api, ptzPositions: async () => ({ positions: [{ id: 30, name: 'Position 1' }] }) };
    return { api: { ...withPosition, ptzCapability: async () => ({ supported: true }), ptzMove: async () => {}, ptzStop: async () => {} } };
  };
  const armFullscreen = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    act(() => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => root() });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    await waitFor(() => expect(screen.getByText('Position 1')).toBeInTheDocument());
  };

  it('a right click on a saved position in fullscreen opens only the position menu', async () => {
    const st = withSavedPosition();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    await armFullscreen();
    fireEvent.contextMenu(screen.getByText('Position 1'));
    await screen.findByText('Rename');
    expect(document.querySelectorAll('.cam-menu')).toHaveLength(1);
  });

  it('a right click outside the panel in fullscreen opens only the camera menu', async () => {
    const st = withSavedPosition();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    await armFullscreen();
    fireEvent.contextMenu(root());
    await waitFor(() => expect(document.querySelectorAll('.cam-menu')).toHaveLength(1));
    expect(screen.queryByText('Rename')).toBeNull();
  });

  // ---- continuous drag (spec 2026-10-23) ----
  // Discriminator of the defect reported by the operator: with the button held and the pointer STILL, the
  // command has to repeat. Before the change the counter stayed at 1 (measured: expected 1 to be >= 3).
  it('holding the button with a still pointer keeps the camera moving', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });   // 180 px: full arrow
    await waitFor(() => expect(st.moves.length).toBeGreaterThanOrEqual(1));
    // no event in between: only the hook's 100 ms repeater can produce these commands
    await new Promise((r) => setTimeout(r, 520));
    expect(st.moves.length).toBeGreaterThanOrEqual(3);
    expect(st.moves[st.moves.length - 1]).toEqual(st.moves[0]);    // the vector does not decay
    fireEvent.pointerUp(cell);
    await waitFor(() => expect(st.stops).toBe(1));
  });

  it('below the 4 px threshold nothing moves; crossing it starts and coming back stops', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { clientX: 103, clientY: 100 });    // 3 px: arrow hidden, zero speed
    await new Promise((r) => setTimeout(r, 150));
    expect(st.moves.length).toBe(0);
    fireEvent.pointerMove(cell, { clientX: 160, clientY: 100 });    // 60 px: the session starts
    await waitFor(() => expect(st.moves.length).toBeGreaterThanOrEqual(1));
    fireEvent.pointerMove(cell, { clientX: 102, clientY: 100 });    // back to 2 px: the camera stops
    await waitFor(() => expect(st.stops).toBe(1));
    const sent = st.moves.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(st.moves.length).toBe(sent);                             // the repeater is gone, not paused
    fireEvent.pointerUp(cell);
  });

  it('releasing the button stops and sends nothing afterwards', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={camera} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    const cell = root();
    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });
    await waitFor(() => expect(st.moves.length).toBeGreaterThanOrEqual(1));
    fireEvent.pointerUp(cell);
    await waitFor(() => expect(st.stops).toBe(1));
    const sent = st.moves.length;
    await new Promise((r) => setTimeout(r, 250));
    expect(st.moves.length).toBe(sent);
    expect(st.stops).toBe(1);                                       // one Stop, not one per event
  });

  // D2: the arrow length IS the speed, so the panel speed does not multiply the drag; the keyboard keeps it.
  it('the drag is not multiplied by the panel speed, the keyboard still is', async () => {
    const st = ptzApi();
    const ptzRef: { current: ReturnType<typeof usePtz> | null } = { current: null };
    mount(<WithPtz api={st.api} camera={camera} ptzRef={ptzRef} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    act(() => ptzRef.current!.applySpeed(0.5));
    const cell = root();
    fireEvent.pointerDown(cell, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(cell, { clientX: 280, clientY: 100 });    // 180 px of arrow
    await waitFor(() => expect(st.moves.length).toBeGreaterThanOrEqual(1));
    expect(st.moves[0]).toEqual({ pan: 0.6, tilt: 0, zoom: 0 });    // NOT 0.3: the panel does not enter
    fireEvent.pointerUp(cell);
    await waitFor(() => expect(st.stops).toBe(1));
    const before = st.moves.length;
    await new Promise((r) => setTimeout(r, 120));                   // passes the 80 ms throttle
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(st.moves.length).toBeGreaterThan(before));
    expect(st.moves[st.moves.length - 1]).toEqual({ pan: 0.3, tilt: 0, zoom: 0 });   // the keyboard keeps 0.5
    fireEvent.keyUp(window, { key: 'ArrowRight' });
  });

  // ---- task 4.4: the PTZ icon is a grant on THIS camera (can_control strictly true; absent = false) ----
  it('can_control false: the PTZ button is absent from the DOM', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={{ ...camera, can_control: false }} />);
    await withImage();
    expect(screen.queryByRole('button', { name: 'PTZ' })).toBeNull();
  });

  it('can_control true with the ptz prop: the PTZ button is present', async () => {
    const st = ptzApi();
    mount(<WithPtz api={st.api} camera={{ ...camera, can_control: true }} />);
    await withImage();
    expect(screen.getByRole('button', { name: 'PTZ' })).toBeInTheDocument();
  });

  it('no can_control field: the button is absent (safe default; a new server always sends it)', async () => {
    const st = ptzApi();
    // Same harness WITHOUT the harness default: the camera object carries no can_control at all
    const WithoutGrant = ({ api: apiProp }: { api: NonNullable<Parameters<typeof usePtz>[0]> & { liveToken: typeof api.liveToken } }) => {
      const ptz = usePtz(apiProp);
      return <StreamCell api={apiProp} camera={{ ...camera, ptz: { supported: true } }} profiles={profiles} ptz={ptz} />;
    };
    mount(<WithoutGrant api={st.api} />);
    await withImage();
    expect(screen.queryByRole('button', { name: 'PTZ' })).toBeNull();
  });

  it('can_control revoked while armed disarms the cell (same teardown as the manual click)', async () => {
    const st = ptzApi();
    const { rerender } = mount(<WithPtz api={st.api} camera={{ ...camera, can_control: true }} />);
    await withImage();
    fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
    expect(root().className).toContain('ptz-ativo');
    rerender(<WithPtz api={st.api} camera={{ ...camera, can_control: false }} />);
    // the grant is gone: mode disarmed (no ptz-ativo) and the icon itself disappears
    expect(root().className).not.toContain('ptz-ativo');
    expect(screen.queryByRole('button', { name: 'PTZ' })).toBeNull();
  });
});

describe('StreamCell: the box in the image format (spec 2026-10-17)', () => {
  const cam4x3 = { id: 'c1', name: 'Camera 1', state: 'online' };
  const profiles4x3 = [{ id: 'p1', name: 'subStream', width: 640, height: 480 }];

  it('the box exists, inherits the active profile format and wraps the overlays', () => {
    const { container } = mount(<StreamCell api={api} camera={cam4x3} profiles={profiles4x3} />);
    const box = container.querySelector('.cell-quadro') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.className).toBe('cell-quadro');
    expect(box.style.getPropertyValue('--formato')).toBe('1.3333333333333333');
    // the overlays live INSIDE the box (acceptance item 10): their borders are the image ones
    expect(box.querySelector('.cell-overlay')).not.toBeNull();
    expect(box.querySelector('.cell-stream')).not.toBeNull();
    expect(box.querySelector('.cell-loading')).not.toBeNull();
  });

  it('a profile without resolution leaves the box full and a profile swap follows the format', () => {
    const noResolution = [{ id: 'p1', name: 'main' }];
    const { container, rerender } = mount(<StreamCell api={api} camera={cam4x3} profiles={noResolution} />);
    expect((container.querySelector('.cell-quadro') as HTMLElement).className).toBe('cell-quadro cheia');
    rerender(<StreamCell api={api} camera={cam4x3} profiles={[{ id: 'p1', name: 'mainStream', width: 1920, height: 1080 }]} />);
    const box = container.querySelector('.cell-quadro') as HTMLElement;
    expect(box.className).toBe('cell-quadro');
    expect(box.style.getPropertyValue('--formato')).toBe('1.7777777777777777');
  });

  it('the offline cell paints the background on the BOX, not on the track', () => {
    const { container } = mount(<StreamCell api={api} camera={{ ...cam4x3, state: 'provisioning' }} profiles={profiles4x3} />);
    const cell = container.querySelector('.stream-cell') as HTMLElement;
    const box = container.querySelector('.cell-quadro') as HTMLElement;
    expect(cell.className).toContain('off');
    expect(box.className).toContain('off');
  });
});

// plan 2026-10-26: the Hub refuses with 400 {"error":"codecs not supported by client"} when the browser
// does not decode the path codec (H.265 on Firefox/Edge). Retrying every 10 s never resolves it.
describe('StreamCell: codec não suportado (plan 2026-10-26)', () => {
  const comFalha = (status: number, body: string) => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      requests.push(String(url));
      return { ok: false, status, text: async () => body };
    }));
  };

  it('um 400 de codec mostra a mensagem de H.265 e não repete a tentativa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      comFalha(400, '{"status":"error","error":"codecs not supported by client"}');
      mount(<StreamCell api={api} camera={camera} profiles={profiles} mode="live" />);
      expect(await screen.findByText('H.265 not supported in this browser')).toBeInTheDocument();
      expect(screen.queryByText('No signal')).toBeNull();
      const before = requests.length;
      act(() => { vi.advanceTimersByTime(30000); });
      expect(requests.length).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('um 400 sem codec continua "No signal" e repete depois de 10 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      comFalha(400, '{"status":"error","error":"bad request"}');
      mount(<StreamCell api={api} camera={camera} profiles={profiles} mode="live" />);
      expect(await screen.findByText('No signal')).toBeInTheDocument();
      const before = requests.length;
      act(() => { vi.advanceTimersByTime(11000); });
      // report amendment: setInterval only SCHEDULES the next attempt; its fetch is born after the
      // await api.liveToken, in a microtask — the sync act above does not drain it. Assertion intact.
      await act(async () => { await Promise.resolve(); });
      expect(requests.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Defect measured 2026-10-27: the WHEP effect did not depend on camera.ativa, so toggling the flag with the
// cell open did nothing — deactivating kept the video, reactivating kept the placeholder. The same api object
// is reused across the rerender: swapping the object would re-run the effect through the `api` dep and hide
// the bug. The flag only changes the server's answer (true = token ok, false = 409 camera_inactive).
describe('StreamCell: camera.ativa religa a célula sem refresh (defeito 2026-10-27)', () => {
  const tokenApi = (state: { ativa: boolean }, calls: { n: number }) => ({
    liveToken: async (_id: string) => {
      calls.n += 1;
      if (!state.ativa) throw Object.assign(new Error('Camera is inactive'), { status: 409 });
      return { whep_url: 'http://127.0.0.1:8890/uuid/main/whep', token: 'tk' };
    },
  });

  it('inativar com a célula aberta corta o vídeo e mostra o placeholder sem desmontar', async () => {
    const state = { ativa: true };
    const calls = { n: 0 };
    const apiFlag = tokenApi(state, calls);
    const { container, rerender } = mount(
      <StreamCell api={apiFlag} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />,
    );
    await waitFor(() => expect(rtc.instances).toHaveLength(1));
    expect(screen.queryByText('Camera inactive')).toBeNull();

    state.ativa = false; // the server flips: next token goes 409
    rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />);

    expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
    expect(calls.n).toBe(2);                     // a new token request happened
    expect(rtc.instances[0].closed).toBe(true);     // the cleanup closed the peer connection
    // project invariant: the warning overlaps, the <video> stays mounted
    expect(container.querySelector('video')).not.toBeNull();
  });

  it('reativar faz a célula renegociar a sessão WHEP sem refresh', async () => {
    const state = { ativa: false };
    const calls = { n: 0 };
    const apiFlag = tokenApi(state, calls);
    const { rerender } = mount(
      <StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />,
    );
    expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
    expect(rtc.instances).toHaveLength(0);

    state.ativa = true; // the toggle back on is the event that re-arms the cell
    rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />);

    await waitFor(() => expect(rtc.instances).toHaveLength(1));
    expect(screen.queryByText('Camera inactive')).toBeNull();
    await waitFor(() => expect(rtc.instances[0].remoteSdp).toContain('m=video'));
  });

  // spec 2026-10-27 (graca-reativacao-spinner): reactivating shows the spinner, not "No signal".
  const whep503 = () => vi.mocked(global.fetch).mockImplementation(async () => ({
    ok: false, status: 503, text: async () => '',
  } as Response));

  it('reativar mostra Loading com spinner, não No signal', async () => {
    const state = { ativa: false };
    const calls = { n: 0 };
    const apiFlag = tokenApi(state, calls);
    const { rerender } = mount(
      <StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />,
    );
    expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
    state.ativa = true;
    whep503();   // the Hub does not publish yet: the attempt fails immediately
    rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    expect(document.querySelector('.cell-spinner')).not.toBeNull();
    await waitFor(() => expect(rtc.instances.length).toBeGreaterThan(0));
    expect(screen.queryByText('No signal')).toBeNull();
    expect(screen.queryByText('Camera inactive')).toBeNull();
  });

  it('falha durante a graça mantém o spinner e esconde o No signal', async () => {
    const state = { ativa: false };
    const calls = { n: 0 };
    const apiFlag = tokenApi(state, calls);
    const { rerender } = mount(
      <StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />,
    );
    expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
    state.ativa = true;
    whep503();
    rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />);
    await waitFor(() => expect(rtc.instances.length).toBeGreaterThan(0));
    await waitFor(() => expect(document.querySelector('.cell-loading')).not.toBeNull());
    expect(screen.queryByText('No signal')).toBeNull();
  });

  it('graça de 60 s expira: com falha persistente o No signal volta', async () => {
    vi.useFakeTimers();
    try {
      const state = { ativa: false };
      const calls = { n: 0 };
      const apiFlag = tokenApi(state, calls);
      const { rerender } = mount(
        <StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />,
      );
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      state.ativa = true;
      whep503();
      rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(document.querySelector('.cell-loading')).not.toBeNull();
      expect(screen.queryByText('No signal')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
      expect(screen.getByText('No signal')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('desligar de novo durante a graça cancela a graça', async () => {
    const state = { ativa: false };
    const calls = { n: 0 };
    const apiFlag = tokenApi(state, calls);
    const { rerender } = mount(
      <StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />,
    );
    expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
    state.ativa = true;
    rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />);
    expect(await screen.findByRole('status')).toHaveTextContent('Loading…');
    state.ativa = false;
    rerender(<StreamCell api={apiFlag} camera={{ ...camera, ativa: false }} profiles={profiles} mode="live" />);
    expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
    expect(document.querySelector('.cell-loading')).toBeNull();
  });

  it('célula que monta já em falha não entra em graça', async () => {
    whep503();
    mount(<StreamCell api={api} camera={{ ...camera, ativa: true }} profiles={profiles} mode="live" />);
    expect(await screen.findByText('No signal')).toBeInTheDocument();
  });
});

// plan 2026-10-27 (camera-ativa): POST /live/token returns 409 camera_inactive when the camera
// is inactive (server/lib/errors.js). The cell shows the fixed placeholder — same mechanism as the codec:
// repeating every 10 s does not resolve while the camera is off.
describe('StreamCell: câmera inativa (plano 2026-10-27)', () => {
  it('uma recusa 409 do token mostra "Camera inactive" e não repete a tentativa', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      // real error shape: ApiClient httpError (shared/utils/api.ts) pastes the status onto the Error and uses
      // the body `error` as the message; the body `code` does not survive the thin client
      const recusado = {
        liveToken: async () => {
          calls += 1;
          throw Object.assign(new Error('Camera is inactive'), { status: 409 });
        },
      };
      mount(<StreamCell api={recusado} camera={camera} profiles={profiles} mode="live" />);
      expect(await screen.findByText('Camera inactive')).toBeInTheDocument();
      expect(screen.queryByText('No signal')).toBeNull();
      const before = calls;
      act(() => { vi.advanceTimersByTime(30000); });
      expect(calls).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
