import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import LiveView, { clearLiveViewSnapshot } from './LiveView';
import StageGrid from '../components/StageGrid';
import { usePtz } from '@/features/live/hooks/usePtz';
import type { Vector } from '@/features/live/services/ptz';

// BORDER between the two 2026-10-18 specs — selected cell (spec A) x area zoom (spec C) — in ONE file, and
// mounting LiveView, because the border JavaScript is SPLIT: the `click` guard (`suppressClick` +
// `onClickCapture`) lives in StreamCell, the body click decision in StageGrid's `onClick` and the selection
// STATE (mark / expand) in LiveView. A state double here would prove the toggle copy, not the contract: case
// (c) requires the MEASURED result of two clicks, which only the real LiveView produces. What is a safety net
// (passes before and after) is said case by case.
const rtc = vi.hoisted(() => {
  type Handler = (ev: unknown) => void;
  class FakePc {
    static instances: FakePc[] = [];
    ontrack: Handler | null = null;
    onconnectionstatechange: Handler | null = null;
    connectionState = 'connecting';
    constructor(_cfg: unknown) { FakePc.instances.push(this); }
    addTransceiver(_kind: string) {}
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96' }; }
    async setLocalDescription(_o: unknown) {}
    async setRemoteDescription(_d: { sdp: string }) {}
    close() {}
  }
  return { FakePc, instances: FakePc.instances };
});

const camera = { id: 'c1', name: 'Camera 1', state: 'online', profile_ids: [] as string[], ptz: { supported: true }, can_control: true };
const layout = {
  id: 'L1', name: 'Layout 1',
  cells: [{ id: 'a', col: 0, row: 0, colspan: 1, rowspan: 1, content: { kind: 'live', camera_id: camera.id } }],
};

type Box = { left: number; top: number; right: number; bottom: number; aspect: number };
type StageApi = NonNullable<Parameters<typeof usePtz>[0]> & Parameters<typeof LiveView>[0]['api'];

const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;

// The real stage: the same wire as the App (the PTZ hook outside, LiveView owns the selection).
function Stage({ api }: { api: StageApi }) {
  const ptz = usePtz(api);
  return <LiveView api={api} cameras={[camera]} layouts={[layout]} openRequest={layout} ptz={ptz} />;
}

function fakeApi() {
  const state = {
    moves: [] as Vector[], boxes: [] as Box[], undos: 0,
    api: {} as StageApi,
  };
  state.api = {
    liveToken: async () => ({ whep_url: 'http://127.0.0.1:8890/uuid/sub/whep', token: 'tk', expires_in: 60 }),
    profiles: async () => [{ id: 'p1', camera_id: camera.id, name: 'Main', width: 1920, height: 1080 }],
    saveLayout: async (l) => ({ id: 'L1', name: l.name }),
    ptzCapability: async () => ({ supported: true }),
    ptzMove: async (_id, v) => { state.moves.push(v); },
    ptzStop: async () => {},
    ptzZoomArea: async (_id, box) => { state.boxes.push(box as Box); },
    ptzUndoZoom: async () => { state.undos += 1; },
  };
  return state;
}

const cell = (c: HTMLElement) => c.querySelector('.stage-cell') as HTMLElement;
const root = (c: HTMLElement) => c.querySelector('.stream-cell') as HTMLElement;
// jsdom returns 0x0 for every element: the box measure has to be injected (pattern of StreamCell.test)
const measureBox = (c: HTMLElement) => {
  const box = c.querySelector('.cell-quadro') as HTMLElement;
  vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(
    { left: 0, top: 0, width: 800, height: 450, right: 800, bottom: 450, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  return box;
};

// spec 2026-10-18-wait-1s-cell-size + 2026-10-18 amendment (Nx way): the cell size waits SIZE_WAIT_MS from
// the hook (300 ms; the border is immediate). These cases use real timers (the PTZ instrument has awaits), so
// the wait is a generous sleep.
const waitForSize = () => act(async () => { await new Promise((r) => setTimeout(r, 450)); });

// opens the stage with the instrument ARMED (PTZ requires an image on screen: the first frame comes from ontrack)
async function openWithPtz(state: ReturnType<typeof fakeApi>) {
  const { container } = render(<Stage api={state.api} />, { wrapper });
  // the profile list arrives by promise: without this turn its setState falls outside the test's act
  await act(async () => {});
  await waitFor(() => expect(rtc.instances).toHaveLength(1));
  act(() => { rtc.instances[0].ontrack?.({ streams: [{ id: 's1' }], track: null }); });
  fireEvent.click(screen.getByRole('button', { name: 'PTZ' }));
  return container;
}

beforeEach(() => {
  clearLiveViewSnapshot();
  rtc.instances.length = 0;
  vi.stubGlobal('RTCPeerConnection', rtc.FakePc);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0\r\nm=video 9' })));
});

describe('border: cell selection (A) x area zoom (C)', () => {
  // SAFETY NET: passes before and after the fix. A plain click has no pointermove, so no arrow can come out —
  // and the mark has to happen EVEN in PTZ mode (the instrument does not own a still left click).
  it('(a) one click on the video body in PTZ mode marks and expands the cell and does NOT fire the arrow', async () => {
    const state = fakeApi();
    const container = await openWithPtz(state);
    const box = measureBox(container);

    fireEvent.click(box);
    await waitForSize();   // wait-1s spec: the border is immediate, the size waits the deadline

    expect(cell(container).className).toContain('selecionada');
    expect(cell(container).className).toContain('ampliada');
    // the arrow is a DRAG (spec C): a still click sends no ContinuousMove and draws no target
    expect(state.moves).toHaveLength(0);
    expect((box.querySelector('.ptz-overlay') as HTMLElement).style.display).toBe('none');
  });

  it('(b) Shift+drag draws .ptz-selecao and does NOT toggle the selection nor the expansion', async () => {
    const state = fakeApi();
    const container = await openWithPtz(state);
    const box = measureBox(container);
    fireEvent.click(box); // starting state of the border: marked AND expanded
    await waitForSize();   // wait-1s spec: expanded only arrives 1 s after the last click
    expect(cell(container).className).toContain('ampliada');

    fireEvent.pointerDown(root(container), { button: 0, shiftKey: true, pointerId: 1, clientX: 200, clientY: 90 });
    const rectangle = box.querySelector('.ptz-selecao') as HTMLElement;
    expect(rectangle.style.display).toBe('block');
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 600, clientY: 270 });
    expect(rectangle.style.width).toBe('400px');
    // amendment EN-1 (Nx parity, spec 2026-10-19): box 800x450 -> dx = 400 > dy*a = 320 ->
    // w = 400, h = 400/(16/9) = 225. Before the aspect lock the case asserted the raw side (180px).
    expect(rectangle.style.height).toBe('225px');
    expect(state.moves).toHaveLength(0); // the Shift gesture sends no PanTilt
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 600, clientY: 270 });

    // Chrome dispatches the `click` in the SAME task as the `pointerup`: the guard swallows it and the toggle
    // does not run. If the guard were disarmed synchronously on release, this click would toggle again
    // (shrinking the cell) — and that is what this case catches.
    fireEvent.click(root(container));
    expect(cell(container).className).toContain('selecionada');
    expect(cell(container).className).toContain('ampliada');
    expect(box.querySelector('.ptz-selecao')?.getAttribute('style')).toContain('display: none');
  });

  // MEASURED CONTRACT (not "back to the start"): two clicks = two toggles under today's rule -> the cell ends
  // up MARKED and NOT expanded. The double click itself does not touch the selection.
  it('(c) a double click in PTZ mode does ptzUnzoom; the cell stays MARKED and NOT expanded', async () => {
    const state = fakeApi();
    const container = await openWithPtz(state);
    const box = measureBox(container);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => null });

    fireEvent.click(box); // 1st click: marks and expands
    fireEvent.click(box); // 2nd click: toggles (shrinks)
    expect(cell(container).className).toContain('selecionada');
    expect(cell(container).className).not.toContain('ampliada');

    fireEvent.doubleClick(root(container));

    await waitFor(() => expect(state.undos).toBe(1));
    expect(cell(container).className).toContain('selecionada');
    expect(cell(container).className).not.toContain('ampliada');
  });

  // SAFETY NET: the arrow branch did not change. It also pins that pointer capture did NOT enter it
  // (it was what swallowed the cell button clicks, measured in Chromium on 2026-10-16).
  it('(d) a drag without Shift on an expanded cell moves the arrow and the expansion stays intact', async () => {
    const state = fakeApi();
    const container = await openWithPtz(state);
    const box = measureBox(container);
    fireEvent.click(box);
    await waitForSize();   // wait-1s spec
    expect(cell(container).className).toContain('ampliada');
    const capture = vi.fn();
    Object.assign(root(container), { setPointerCapture: capture });

    fireEvent.pointerDown(root(container), { button: 0, pointerId: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(window, { pointerId: 2, clientX: 280, clientY: 100 });
    await waitFor(() => expect(state.moves).toHaveLength(1));
    expect(state.moves[0]).toEqual({ pan: 0.6, tilt: 0, zoom: 0 });
    fireEvent.pointerUp(window, { pointerId: 2 });

    expect(cell(container).className).toContain('selecionada');
    expect(cell(container).className).toContain('ampliada');
    expect(capture).not.toHaveBeenCalled();
    expect((box.querySelector('.ptz-selecao') as HTMLElement).style.display).toBe('none');
  });
});

// The three border defects found in the review. (2) and (3) are proved here end to end; (1) is an outcome of
// Chrome's DISPATCH (the `click` is born on the common ancestor) that jsdom does not reproduce — here the net
// proves the MECHANISM (the cell asks for pointer capture on the Shift branch) and the outcome is in the real
// Chrome probe recorded in the plan. Before the fix all three fail.
describe('border defects (regression)', () => {
  it('(1) Shift+drag puts the pointer in capture: the gesture `click` falls inside the guard', async () => {
    const state = fakeApi();
    const container = await openWithPtz(state);
    const box = measureBox(container);
    fireEvent.click(box);
    await waitForSize();   // wait-1s spec
    const capture = vi.fn();
    Object.assign(root(container), { setPointerCapture: capture });

    fireEvent.pointerDown(root(container), { button: 0, shiftKey: true, pointerId: 7, clientX: 200, clientY: 90 });
    expect(capture).toHaveBeenCalledWith(7);
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 600, clientY: 270 });
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 600, clientY: 270 });

    fireEvent.click(root(container));
    expect(cell(container).className).toContain('selecionada');
    expect(cell(container).className).toContain('ampliada');
  });

  it('(2) after a Shift+drag that ends WITHOUT a click, the next click (and Enter) is not swallowed', async () => {
    const state = fakeApi();
    const container = await openWithPtz(state);
    measureBox(container);
    const button = screen.getByRole('button', { name: 'PTZ' });
    expect(button).toHaveAttribute('aria-pressed', 'true');

    const gesture = () => {
      fireEvent.pointerDown(root(container), { button: 0, shiftKey: true, pointerId: 3, clientX: 200, clientY: 90 });
      fireEvent.pointerMove(window, { pointerId: 3, clientX: 600, clientY: 270 });
      fireEvent.pointerUp(window, { pointerId: 3, clientX: -20, clientY: -20 }); // release outside: no `click` follows
    };

    gesture();
    // the next click (milliseconds later, by the operator's hand) has to reach the button. In jsdom
    // `fireEvent.click` does NOT fire pointerdown, so these two cases model the keyboard / activation path —
    // exactly what the defect swallowed; on a real mouse the pointerdown re-arm already saved it.
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');

    // keyboard: Enter/Space produces a `click` WITHOUT pointerdown — no pointerdown re-arm saves this case
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    gesture();
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(button, { detail: 0 });
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('(3) a click on the empty-stage warning clears the mark', () => {
    // `selected` with no cell at all is the REAL orphan state: the id survives a tab switch and a removal
    const onClearSelection = vi.fn();
    const api = { liveToken: async () => ({ whep_url: 'http://127.0.0.1:8890/uuid/whep', token: 'tk', expires_in: 60 }) };
    const { container } = render(<StageGrid api={api} cameras={[]} cells={[]} selected="a"
      onClearSelection={onClearSelection} onChange={() => {}} />, { wrapper });

    // the empty message is rendered by shared/ui/StagePalco (own wording wave): click the slot itself
    fireEvent.click(container.querySelector('.stage-vazio') as HTMLElement);

    expect(onClearSelection).toHaveBeenCalledTimes(1);
  });
});
