import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARROW_THRESHOLD_PX, MAX_SPEED, createInstrument, keyVector, dragVector, zoomVector, zoomShortcutVector } from './ptz';

describe('instrument vectors', () => {
  it('drag: pan follows X and tilt is INVERTED (mouse grows downwards, ONVIF upwards)', () => {
    expect(dragVector(180, -180)).toEqual({ pan: MAX_SPEED, tilt: MAX_SPEED, zoom: 0 });
    expect(dragVector(-90, 90)).toEqual({ pan: -MAX_SPEED / 2, tilt: -MAX_SPEED / 2, zoom: 0 });
    expect(dragVector(0, 0)).toEqual({ pan: 0, tilt: 0, zoom: 0 });
  });

  it('drag saturates at the maximum, it does not grow without a limit', () => {
    expect(dragVector(9999, 0).pan).toBe(MAX_SPEED);
    expect(dragVector(-9999, 0).pan).toBe(-MAX_SPEED);
  });

  it('arrows map the direction and the zoom keys give a step', () => {
    expect(keyVector('ArrowLeft')).toEqual({ pan: -MAX_SPEED, tilt: 0, zoom: 0 });
    expect(keyVector('ArrowUp')).toEqual({ pan: 0, tilt: MAX_SPEED, zoom: 0 });
    expect(keyVector('a')).toBeNull();
    expect(zoomShortcutVector('+')).toEqual({ pan: 0, tilt: 0, zoom: MAX_SPEED });
    expect(zoomShortcutVector('-')).toEqual({ pan: 0, tilt: 0, zoom: -MAX_SPEED });
    expect(zoomShortcutVector('a')).toBeNull();
    expect(zoomVector(-1).zoom).toBe(-MAX_SPEED);
  });
});

describe('instrument: command rate and client dead-man', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const mkApi = () => {
    const moves: unknown[] = [];
    let stops = 0;
    return {
      moves, stops: () => stops,
      api: {
        ptzMove: async (_id: string, v: unknown) => { moves.push(v); },
        ptzStop: async () => { stops += 1; },
      },
    };
  };

  it('limits the rate: commands faster than the interval are discarded', async () => {
    const { api, moves } = mkApi();
    const inst = createInstrument(api, 'c1', 80, 400);
    expect(inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1000)).toBe(true);
    expect(inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1050)).toBe(false);
    expect(inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1100)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(moves.length).toBe(2);
  });

  it('releases the command without Stop: the client dead-man stops the camera', async () => {
    const { api, stops } = mkApi();
    const inst = createInstrument(api, 'c1', 80, 400);
    inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1000);
    expect(stops()).toBe(0);
    await vi.advanceTimersByTimeAsync(400);
    expect(stops()).toBe(1);
  });

  it('a new command re-arms the dead-man and stop() disarms it', async () => {
    const { api, stops } = mkApi();
    const inst = createInstrument(api, 'c1', 80, 400);
    inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1000);
    inst.move({ pan: 0.6, tilt: 0, zoom: 0 }, 1100);
    await vi.advanceTimersByTimeAsync(300);
    expect(stops(), 'the timer was re-armed by the new command').toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(stops()).toBe(1);
    inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 2000);
    await inst.stop();
    expect(stops()).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(stops(), 'after the explicit Stop the dead-man does not fire again').toBe(2);
  });

  it('stop() with no command sent does not call the API', async () => {
    const { api, stops } = mkApi();
    const inst = createInstrument(api, 'c1', 80, 400);
    await inst.stop();
    expect(stops()).toBe(0);
  });

  // Defect measured in production (2026-10-16, bundle index-BAbM1YRx.js): ApiClient defines
  // ptzMove/ptzStop as methods that use `this.req`. Detached from the object (passed loose to the
  // instrument) `this` is lost and the method throws SYNCHRONOUSLY with
  // "TypeError: this.req is not a function". `p.catch(...)` does not catch a synchronous throw: the
  // exception climbed through the pointer/keyboard handler and the cell never showed the reason. Ordinary
  // mocks are loose functions (no `this`) and so passed with the defect.
  it('a SYNCHRONOUS api failure also reaches the owner instead of climbing through the handler', async () => {
    const failures: unknown[] = [];
    const api = {
      ptzMove: () => { throw new TypeError('this.req is not a function'); },
      ptzStop: () => { throw new TypeError('this.req is not a function'); },
    };
    const inst = createInstrument(api, 'c1', 80, 400, (e) => failures.push(e));
    expect(() => inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1000)).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(failures.length).toBe(1);
    await expect(inst.stop()).resolves.toBeUndefined();
    expect(failures.length).toBe(2);
  });

  it('reports the command failure to the owner instead of swallowing it', async () => {
    const failures: unknown[] = [];
    let stops = 0;
    const api = {
      ptzMove: async () => { throw new Error('403: insufficient role'); },
      ptzStop: async () => { stops += 1; },
    };
    const inst = createInstrument(api, 'c1', 80, 400, (e) => failures.push(e));
    inst.move({ pan: 0.5, tilt: 0, zoom: 0 }, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(failures.length).toBe(1);
    expect((failures[0] as Error).message).toBe('403: insufficient role');
    await inst.stop();
    expect(stops).toBe(1);
  });
});

import { scale, directionVector, errorStatus, MIN_SPEED } from './ptz';

describe('speed, direction and status (spec 2026-10-17)', () => {
  it('scale multiplies pan and tilt and leaves zoom untouched', () => {
    expect(scale({ pan: 0.6, tilt: -0.6, zoom: 0.6 }, 0.5)).toEqual({ pan: 0.3, tilt: -0.3, zoom: 0.6 });
  });

  it('scale has a floor: zero speed would become a command refused with 400', () => {
    expect(scale({ pan: 1, tilt: 0, zoom: 0 }, 0)).toEqual({ pan: MIN_SPEED, tilt: 0, zoom: 0 });
    expect(scale({ pan: 1, tilt: 0, zoom: 0 }, Number.NaN).pan).toBe(1);
  });

  it('directionVector builds the 8 directions with the speed ceiling', () => {
    expect(directionVector(0, 1)).toEqual({ pan: 0, tilt: 0.6, zoom: 0 });
    expect(directionVector(-1, 0)).toEqual({ pan: -0.6, tilt: 0, zoom: 0 });
  });

  it('the diagonal is normalized: without that it would be 41% faster than the cardinal one', () => {
    const d = directionVector(1, 1);
    expect(d.pan).toBeCloseTo(0.6 * Math.SQRT1_2, 10);
    expect(d.tilt).toBeCloseTo(0.6 * Math.SQRT1_2, 10);
    expect(Math.hypot(d.pan, d.tilt)).toBeCloseTo(0.6, 10);
  });

  it('errorStatus reads the status glued to the Error by the HTTP client', () => {
    expect(errorStatus(Object.assign(new Error('x'), { status: 403 }))).toBe(403);
    expect(errorStatus(new Error('x'))).toBe(0);
    expect(errorStatus(null)).toBe(0);
  });
});

import { MIN_SELECTION_PX, selectionBox } from './ptz';

describe('area selection box (spec 2026-10-18, section 5.2)', () => {
  const frame = { width: 800, height: 450 };

  it('normalizes both corners against the shown video and carries the aspect along', () => {
    const c = selectionBox({ ...frame, x0: 200, y0: 90, x1: 600, y1: 270 });
    expect(c).not.toBeNull();
    expect(c!.left).toBe(0.25);
    expect(c!.top).toBe(0.2);
    expect(c!.right).toBe(0.75);
    expect(c!.bottom).toBe(0.6);
    expect(c!.aspect).toBeCloseTo(16 / 9, 10);
  });

  it('dragging to the left/up gives the SAME box (the borders are ordered)', () => {
    const forward = selectionBox({ ...frame, x0: 200, y0: 90, x1: 600, y1: 270 });
    const backward = selectionBox({ ...frame, x0: 600, y0: 270, x1: 200, y1: 90 });
    expect(backward).toEqual(forward);
  });

  it('less than 12 px on ANY side is not worth a zoom (accidental click)', () => {
    expect(MIN_SELECTION_PX).toBe(12);
    const narrow = selectionBox({ ...frame, x0: 200, y0: 90, x1: 200 + MIN_SELECTION_PX - 1, y1: 270 });
    expect(narrow).toBeNull();
    const atLimit = selectionBox({ ...frame, x0: 200, y0: 90, x1: 200 + MIN_SELECTION_PX, y1: 270 });
    expect(atLimit).not.toBeNull();
  });

  it('pointer outside the frame is clamped to 0..1 and a box without area comes back null', () => {
    const c = selectionBox({ ...frame, x0: 700, y0: 400, x1: 1200, y1: 900 });
    expect(c!.left).toBeCloseTo(0.875, 10);
    expect(c!.right).toBe(1);
    expect(c!.bottom).toBe(1);
    // BOTH corners outside on the same side: clamped to the same border, there is no area
    expect(selectionBox({ ...frame, x0: 900, y0: 90, x1: 1000, y1: 270 })).toBeNull();
  });

  // Defect measured in the review of commit 9618755: the clamp propagates the NaN and the area guard does
  // not catch it (`NaN <= 0` is false), so the box came back non-null with NaN borders — which become null
  // in JSON and the server refuses with 400. Do not send a request already known to fail.
  it('a non-finite coordinate returns null instead of a box with NaN borders', () => {
    expect(selectionBox({ ...frame, x0: Number.NaN, y0: 90, x1: 600, y1: 270 })).toBeNull();
    expect(selectionBox({ ...frame, x0: 200, y0: 90, x1: Number.POSITIVE_INFINITY, y1: 270 })).toBeNull();
    expect(selectionBox({ width: 800, height: Number.NaN, x0: 200, y0: 90, x1: 600, y1: 270 })).toBeNull();
  });

  // Defect measured in the review of commit 9618755: the 12 px minimum was measured BEFORE the clamp. Two
  // corners outside on the same side leave the EFFECTIVE side below 12 px even with the drag in px being
  // huge — the box is not worth a zoom and has to come back null.
  it('the 12 px minimum applies over the ALREADY CLAMPED box (huge drag, tiny remainder)', () => {
    const remainder = selectionBox({ width: 800, height: 450, x0: 791, y0: 90, x1: 2000, y1: 270 });
    expect(remainder).toBeNull();
    const limit = selectionBox({ width: 800, height: 450, x0: 788, y0: 90, x1: 2000, y1: 270 });
    expect(limit, '12 px of effective side is still worth it').not.toBeNull();
  });
});

import { fixedRectangle } from './ptz';

describe('fixedRectangle: aspect lock of the zoom rectangle (Nx FixedArSelectionItem parity)', () => {
  it('horizontal drag dominates: w = dx, h = w/a, centered on the drag midpoint', () => {
    // box 640x360 (a = 16/9): origin (100,50), cursor (400,200)
    expect(fixedRectangle({ x0: 100, y0: 50, x1: 400, y1: 200, width: 640, height: 360 }))
      .toEqual({ x0: 100, y0: 40.625, x1: 400, y1: 209.375, width: 640, height: 360 });
  });
  it('vertical drag dominates and the rectangle slides inside the box', () => {
    // box 800x400 (a = 2): origin (100,50), cursor (400,250) -> w = 200*2 = 400, h = 200
    expect(fixedRectangle({ x0: 100, y0: 50, x1: 400, y1: 250, width: 800, height: 400 }))
      .toEqual({ x0: 50, y0: 50, x1: 450, y1: 250, width: 800, height: 400 });
  });
  it('a cursor outside the box is clamped before the math', () => {
    // box 800x400 (a = 2): origin (100,50), cursor (990,500) -> cursor becomes (800,400);
    // dx = 700, dy*a = 350*2 = 700 -> w = 700, h = 350; center (450,225) -> left 100, top 50
    expect(fixedRectangle({ x0: 100, y0: 50, x1: 990, y1: 500, width: 800, height: 400 }))
      .toEqual({ x0: 100, y0: 50, x1: 800, y1: 400, width: 800, height: 400 });
  });
  it('a degenerate box (no size) returns the raw corners (non-NaN)', () => {
    expect(fixedRectangle({ x0: 10, y0: 20, x1: 30, y1: 40, width: 0, height: 0 }))
      .toEqual({ x0: 10, y0: 20, x1: 30, y1: 40, width: 0, height: 0 });
  });
});

describe('arrow threshold shared with the drawing (spec 2026-10-23, D1)', () => {
  // The drawing and the command must read the SAME number: with a different threshold the arrow would
  // appear while no command goes out (or the opposite). The value is decision D1, not an accident.
  it('the gesture threshold is 4 px, the same the overlay uses to hide the arrow', () => {
    expect(ARROW_THRESHOLD_PX).toBe(4);
  });
});
