import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import { usePtz } from './usePtz';
import { type Position } from '@/features/live/services/posicoes';

// a .ts file cannot hold JSX: the provider wrapper is built with createElement
const wrapper = ({ children }: { children: ReactNode }) => createElement(LanguageProvider, null, children);
const hook = (api: Parameters<typeof usePtz>[0]) => renderHook(() => usePtz(api), { wrapper });

// API doubled with the ApiClient shape (methods that depend on `this`), recording what went out.
// The server owns the default name (amendment E1): saving returns `{ id, name }` and the reloaded list
// grows WITH that name.
function fakeApi(initial: Position[] = [], absolutePanTilt = true, absoluteZoom = true) {
  const moves: { pan: number; tilt: number; zoom: number }[] = [];
  // (id, refresh): the second argument is the revalidation spec 2026-10-17 asks for on arm
  const capabilities: [string, boolean | undefined][] = [];
  let stops = 0;
  let positions = [...initial];
  const calls: string[] = [];
  // `req` stays outside the object: `this: { req: typeof api.req }` inside the literal itself makes the type
  // of `api` depend on itself (TS7022). Loose in the scope, `typeof req` is known and the double infers.
  const req = (method: string, url: string, body?: Record<string, unknown>): Promise<{ ok: boolean }> => {
    if (url.endsWith('/ptz/move') && body) moves.push(body as { pan: number; tilt: number; zoom: number });
    if (url.endsWith('/ptz/stop')) stops += 1;
    // The SAME url answers POST (save), PATCH (rename) and DELETE (remove). Split by method.
    if (url.endsWith('/ptz/positions') && method === 'PATCH' && body) calls.push('rename:' + JSON.stringify(body));
    if (url.endsWith('/ptz/positions') && method === 'DELETE' && body) calls.push('delete:' + JSON.stringify(body));
    if (url.endsWith('/ptz/positions/goto') && body) calls.push('goto:' + JSON.stringify(body));
    if (url.endsWith('/ptz/viewport-zoom') && body) calls.push('zoom:' + JSON.stringify(body));
    if (url.endsWith('/ptz/viewport-unzoom')) calls.push('undo');
    return Promise.resolve({ ok: true });
  };
  const api = {
    req,
    get moves() { return moves; },
    get stops() { return stops; },
    get capabilities() { return capabilities; },
    calls,
    ptzCapability: async (id: string, refresh?: boolean) => {
      capabilities.push([id, refresh]);
      return { supported: true, absolutePanTilt: absolutePanTilt, absoluteZoom: absoluteZoom };
    },
    ptzMove(this: { req: typeof req }, id: string, v: { pan: number; tilt: number; zoom: number }) { return this.req('POST', `/api/v1/cameras/${id}/ptz/move`, v); },
    ptzStop(this: { req: typeof req }, id: string) { return this.req('POST', `/api/v1/cameras/${id}/ptz/stop`); },
    ptzPositions: async () => ({ positions, error: null }),
    // No body: the client does NOT send a name. The server answers the saved pair and the list reflects it.
    ptzSavePosition: async () => {
      calls.push('save');
      positions = [...positions, { id: 1, name: 'Position 1' }];
      return { id: 1, name: 'Position 1' };
    },
    ptzGoToPosition(this: { req: typeof req }, id: string, position: number) { return this.req('POST', `/api/v1/cameras/${id}/ptz/positions/goto`, { position }); },
    ptzRenamePosition(this: { req: typeof req }, id: string, position: number, name: string) { return this.req('PATCH', `/api/v1/cameras/${id}/ptz/positions`, { position, name }); },
    ptzDeletePosition(this: { req: typeof req }, id: string, position: number) { return this.req('DELETE', `/api/v1/cameras/${id}/ptz/positions`, { position }); },
    ptzZoomArea(this: { req: typeof req }, id: string, box: { left: number; top: number; right: number; bottom: number; aspect: number }) { return this.req('POST', `/api/v1/cameras/${id}/ptz/viewport-zoom`, box); },
    ptzUndoZoom(this: { req: typeof req }, id: string) { return this.req('POST', `/api/v1/cameras/${id}/ptz/viewport-unzoom`); },
  };
  return api;
}

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('usePtz (spec 2026-10-17)', () => {
  it('arming loads the positions and disarming stops the camera', async () => {
    const api = fakeApi([{ id: 30, name: 'Position 1' }]);
    const { result } = renderHook(() => usePtz(api), { wrapper });
    expect(result.current.active).toBe(false);
    act(() => result.current.toggle('c1'));
    expect(result.current.cameraId).toBe('c1');
    await waitFor(() => expect(result.current.positions).toHaveLength(1));
    expect(result.current.canSave).toBe(true);
    act(() => result.current.toggle('c1'));
    expect(result.current.active).toBe(false);
  });

  it('the speed multiplies pan and tilt and does not touch the zoom', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    act(() => result.current.applySpeed(0.5));
    act(() => result.current.move({ pan: 0.6, tilt: -0.6, zoom: 0 }));
    await waitFor(() => expect(api.moves).toHaveLength(1));
    expect(api.moves[0]).toEqual({ pan: 0.3, tilt: -0.3, zoom: 0 });
    await waitFor(() => expect(api.stops).toBe(1), { timeout: 2000 });
  });

  it('holding resends the command and releasing sends Stop', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    act(() => result.current.hold({ pan: 0.6, tilt: 0, zoom: 0 }));
    await waitFor(() => expect(api.moves).toHaveLength(1));
    act(() => { vi.advanceTimersByTime(250); });
    await waitFor(() => expect(api.moves.length).toBeGreaterThan(1), { timeout: 2000 });
    act(() => result.current.release());
    await waitFor(() => expect(api.stops).toBeGreaterThan(0), { timeout: 2000 });
  });

  // spec 2026-10-23 (D2): the arrow length already IS the speed, so the drag passes factor 1 and the panel
  // speed does not multiply it. Without the argument the behaviour stays today's (case above), which is what
  // the joystick and the keyboard use.
  it('hold with an explicit factor bypasses the panel speed', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    act(() => result.current.applySpeed(0.5));
    act(() => result.current.hold({ pan: 0.6, tilt: 0, zoom: 0 }, 1));
    await waitFor(() => expect(api.moves).toHaveLength(1));
    expect(api.moves[0]).toEqual({ pan: 0.6, tilt: 0, zoom: 0 });
    act(() => { vi.advanceTimersByTime(250); });
    await waitFor(() => expect(api.moves.length).toBeGreaterThan(1), { timeout: 2000 });
    // every repetition keeps the same factor: the sent vector does not decay with the panel speed
    expect(api.moves[api.moves.length - 1]).toEqual({ pan: 0.6, tilt: 0, zoom: 0 });
    act(() => result.current.release());
    await waitFor(() => expect(api.stops).toBeGreaterThan(0), { timeout: 2000 });
  });

  it('the 403 disarms the mode and the error stays bound to the camera that failed', async () => {
    const api = fakeApi();
    api.ptzMove = async () => { throw Object.assign(new Error('insufficient role'), { status: 403 }); };
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    act(() => result.current.move({ pan: 0.6, tilt: 0, zoom: 0 }));
    await waitFor(() => expect(result.current.error?.text).toMatch(/insufficient role/));
    expect(result.current.error?.cameraId).toBe('c1');
    await waitFor(() => expect(result.current.active).toBe(false));
  });

  it('saving sends only the camera and the default name comes from the SERVER', async () => {
    const api = fakeApi([]);
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(result.current.positions).toEqual([]));
    await act(async () => { await result.current.save(); });
    expect(api.calls).toContain('save');
    expect(result.current.positions).toEqual([{ id: 1, name: 'Position 1' }]);
  });

  it('canSave requires the absolute position PER AXIS and one axis is already enough', async () => {
    const none = fakeApi([], false, false);
    const r1 = renderHook(() => usePtz(none), { wrapper });
    act(() => r1.result.current.toggle('c1'));
    await waitFor(() => expect(r1.result.current.positions).toEqual([]));
    expect(r1.result.current.absolute).toEqual({ panTilt: false, zoom: false });
    expect(r1.result.current.canSave).toBe(false);

    // the camera with continuous zoom only (the common case) still saves the pan/tilt position
    const panTiltOnly = fakeApi([], true, false);
    const r2 = renderHook(() => usePtz(panTiltOnly), { wrapper });
    act(() => r2.result.current.toggle('c1'));
    await waitFor(() => expect(r2.result.current.absolute).toEqual({ panTilt: true, zoom: false }));
    expect(r2.result.current.canSave).toBe(true);

    const zoomOnly = fakeApi([], false, true);
    const r3 = renderHook(() => usePtz(zoomOnly), { wrapper });
    act(() => r3.result.current.toggle('c1'));
    await waitFor(() => expect(r3.result.current.absolute).toEqual({ panTilt: false, zoom: true }));
    expect(r3.result.current.canSave).toBe(true);
  });

  it('arming asks for capability revalidation (the server cache stops being eternal)', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(api.capabilities).toEqual([['c1', true]]));
    expect(result.current.absolute).toEqual({ panTilt: true, zoom: true });
  });

  it('with 20 positions the save gate closes', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => ({ id: i, name: `Position ${i + 1}` }));
    const api = fakeApi(twenty);
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(result.current.positions).toHaveLength(20));
    expect(result.current.canSave).toBe(false);
  });

  it('rename, remove and go to position call the right routes', async () => {
    const api = fakeApi([{ id: 30, name: 'Position 1' }]);
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(result.current.positions).toHaveLength(1));
    await act(async () => { await result.current.goTo(30); });
    await act(async () => { await result.current.rename(30, 'Portão'); });
    await act(async () => { await result.current.remove(30); });
    expect(api.calls).toEqual([
      'goto:{"position":30}',
      'rename:{"position":30,"name":"Portão"}',
      'delete:{"position":30}',
    ]);
  });

  it('does not accept two saves into the same position', async () => {
    let release: (() => void) | null = null;
    let saves = 0;
    const api = fakeApi([]);
    api.ptzSavePosition = () => {
      saves += 1;
      return new Promise((r) => { release = () => r({ id: 40, name: 'Position 1' }); });
    };
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(result.current.positions).toEqual([]));

    let first: Promise<void> | undefined;
    act(() => { first = result.current.save(); });
    await waitFor(() => expect(result.current.saving).toBe(true));
    // with a save in progress both buttons are disabled
    expect(result.current.canSave).toBe(false);

    // the second click arrives before the re-render: the ref is what closes that window
    await act(async () => { await result.current.save(); });
    // one click on + and another on the CTA cannot save two positions
    expect(saves).toBe(1);

    await act(async () => { release?.(); await first; });
    expect(result.current.saving).toBe(false);
    expect(result.current.canSave).toBe(true);
  });

  it('zoomArea sends the box of the armed camera and undoZoom calls the return route', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(result.current.cameraId).toBe('c1'));
    const box = { left: 0.25, top: 0.2, right: 0.75, bottom: 0.6, aspect: 2 };
    await act(async () => { await result.current.zoomArea(box); });
    await act(async () => { await result.current.undoZoom(); });
    expect(api.calls).toContain('zoom:' + JSON.stringify(box));
    expect(api.calls).toContain('undo');
  });

  it('a zoom refused with 409 becomes the cell error and does NOT disarm (only the 403 disarms)', async () => {
    const base = fakeApi();
    const api = { ...base, ptzZoomArea: async () => { throw Object.assign(new Error('absolute unavailable'), { status: 409 }); } };
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    await waitFor(() => expect(result.current.cameraId).toBe('c1'));
    await act(async () => { await result.current.zoomArea({ left: 0.25, top: 0.25, right: 0.75, bottom: 0.75, aspect: 1.5 }); });
    expect(result.current.error).toEqual({ cameraId: 'c1', text: 'absolute unavailable' });
    expect(result.current.cameraId).toBe('c1');
  });
});

describe('usePtz: the action hint (spec 2026-10-17, section 4.4)', () => {
  it('is born on the command, tells the TYPE from the vector and expires 700 ms later', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    expect(result.current.hint).toBeNull();

    act(() => result.current.move({ pan: 0.6, tilt: 0, zoom: 0 }));
    // ponytail: no `waitFor` — the double pushes into `moves` SYNCHRONOUSLY, and waitFor polling advances the
    // fake clock (`shouldAdvanceTime`), eating the 700 ms deadline before 699.
    expect(api.moves).toHaveLength(1);
    expect(result.current.hint).toBe('moving');

    // 700 ms is the SINGLE deadline of the three actions (spec 4.4); the timers are already fake in the file's beforeEach
    act(() => { vi.advanceTimersByTime(699); });
    expect(result.current.hint).toBe('moving');
    act(() => { vi.advanceTimersByTime(2); });
    expect(result.current.hint).toBeNull();
  });

  it('the zoom has its own text, from the SIGN of the vector', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    act(() => result.current.move({ pan: 0, tilt: 0, zoom: 1 }));
    expect(result.current.hint).toBe('zoom-in');
    act(() => result.current.move({ pan: 0, tilt: 0, zoom: -1 }));
    expect(result.current.hint).toBe('zoom-out');
  });

  it('the deadline is SINGLE: a new command pushes the hint end and swaps the text', async () => {
    const api = fakeApi();
    const { result } = renderHook(() => usePtz(api), { wrapper });
    act(() => result.current.toggle('c1'));
    act(() => result.current.move({ pan: 0.6, tilt: 0, zoom: 0 }));
    act(() => { vi.advanceTimersByTime(600); });
    act(() => result.current.move({ pan: 0, tilt: 0, zoom: -1 }));   // arrives last and owns the text
    expect(result.current.hint).toBe('zoom-out');
    act(() => { vi.advanceTimersByTime(600); });
    expect(result.current.hint).toBe('zoom-out');   // 600 counted from the SECOND command
    act(() => { vi.advanceTimersByTime(120); });
    expect(result.current.hint).toBeNull();
  });
});
