// Client PTZ instrument (spec 2026-10-16): the mouse/keyboard math and the Stop scheduling live HERE,
// outside the component — the command that goes out stays testable without a DOM. The server speaks
// ONVIF; this module only builds vectors and calls the api.

export type Vector = { pan: number; tilt: number; zoom: number };
export type PtzCommands = {
  ptzMove: (id: string, v: Vector) => Promise<unknown>;
  ptzStop: (id: string) => Promise<unknown>;
};

// Normalized ONVIF speed (-1..1). Well below full 1: at most the camera gets fast without becoming
// uncontrollable on a small drag.
export const MAX_SPEED = 0.6;
// Radius (px) that already means maximum speed: the drag is relative to the grab point, like Nx.
export const DRAG_RADIUS = 180;
// Below this the arrow is not drawn and no command goes out (spec 2026-10-23, D1): a zero-length arrow is
// zero speed, and a zero-speed vector is refused by the server with 400. Drawing AND command read the same
// number, so the constant lives here, in the module that owns the gesture math.
export const ARROW_THRESHOLD_PX = 4;

// Speed chosen in the panel (spec 2026-10-17, decision 4.7): multiplies pan and tilt in ONE place, in
// the hook. The floor avoids the zero-speed command, which the server refuses with 400.
export const MIN_SPEED = 0.1;

export function scale(v: Vector, factor: number): Vector {
  const f = Number.isFinite(factor) ? Math.max(MIN_SPEED, Math.min(1, factor)) : 1;
  // `|| 0` normalizes -0, which vitest's toEqual tells apart from 0 (lesson of spec 2026-10-16)
  return { pan: v.pan * f || 0, tilt: v.tilt * f || 0, zoom: v.zoom };
}

// The 8 joystick directions of the panel: pan and tilt in -1, 0 or 1, signed here.
// Diagonals are normalized by 1/sqrt(2) so their speed matches the cardinal ones.
export function directionVector(pan: number, tilt: number): Vector {
  const s = (v: number) => (v > 0 ? 1 : v < 0 ? -1 : 0);
  const p = s(pan), t = s(tilt);
  const m = MAX_SPEED * (p !== 0 && t !== 0 ? Math.SQRT1_2 : 1);
  return { pan: p * m || 0, tilt: t * m || 0, zoom: 0 };
}

// The fetch/API error is an Error with `.status` glued by hand (see api.ts): the status comes out by
// narrowing. It lives here because the hook and the cell need the SAME reading (spec 2026-10-17: a 403
// disarms).
export function errorStatus(e: unknown): number {
  return typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: number }).status === 'number'
    ? (e as { status: number }).status : 0;
}

const clip = (v: number) => Math.max(-1, Math.min(1, v));

// The mouse Y axis GROWS downwards and the ONVIF tilt grows UPWARDS: the tilt inversion lives here,
// in this single place.
export function dragVector(dx: number, dy: number, radius: number = DRAG_RADIUS): Vector {
  // `|| 0` normalizes the -0 that the negation of zero produces (toEqual tells -0 from 0); the rest is unchanged.
  return { pan: clip(dx / radius) * MAX_SPEED, tilt: -clip(dy / radius) * MAX_SPEED || 0, zoom: 0 };
}

export function keyVector(key: string): Vector | null {
  const v = MAX_SPEED;
  if (key === 'ArrowLeft') return { pan: -v, tilt: 0, zoom: 0 };
  if (key === 'ArrowRight') return { pan: v, tilt: 0, zoom: 0 };
  if (key === 'ArrowUp') return { pan: 0, tilt: v, zoom: 0 };
  if (key === 'ArrowDown') return { pan: 0, tilt: -v, zoom: 0 };
  return null;
}

// Mouse wheel and the +/- keys give a zoom speed STEP (not a continuous value): the dead-man Stop turns
// the step into a short zoom pulse.
export function zoomVector(direction: number): Vector {
  return { pan: 0, tilt: 0, zoom: direction > 0 ? MAX_SPEED : -MAX_SPEED };
}

export function zoomShortcutVector(key: string): Vector | null {
  if (key === '+' || key === '=') return zoomVector(1);
  if (key === '-' || key === '_') return zoomVector(-1);
  return null;
}

export type Instrument = { move: (v: Vector, now?: number) => boolean; stop: () => Promise<void> };

// The instrument sends at most one command per interval (Nx limits the rate with a sequence executor)
// and ALWAYS closes with Stop. `stopAfterMs` is the client dead-man: releasing the button, losing focus
// or unmounting the cell cannot leave the camera spinning. The server has the same dead-man, larger,
// for the browser that dies for good.
// `onError` exists because the server can tell why it refused (403 for role, 502 from ONVIF): without
// it the cell has nothing to show and the operator cannot tell whether the command went out (measured
// defect).
export function createInstrument(api: PtzCommands, cameraId: string, intervalMs = 80, stopAfterMs = 400,
  onError?: (error: unknown) => void): Instrument {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sent = false;

  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };

  // The api fails in two ways: rejected promise (network/HTTP error) or a SYNCHRONOUS throw — a method
  // detached from its owner loses `this` (defect measured in production: "this.req is not a function").
  // The try/catch covers both: without it the sync exception climbs through the pointer/keyboard handler
  // and the cell never shows the reason.
  const call = async (fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e) { onError?.(e); }
  };

  const stop = async (): Promise<void> => {
    cancel();
    if (!sent) return;
    sent = false;
    await call(() => api.ptzStop(cameraId));
  };

  return {
    move(v: Vector, now: number = Date.now()): boolean {
      if (now - last < intervalMs) return false;
      last = now;
      sent = true;
      void call(() => api.ptzMove(cameraId, v));
      cancel();
      timer = setTimeout(() => { timer = null; void stop(); }, stopAfterMs);
      return true;
    },
    stop,
  };
}

// Minimum side (px) of the marked box: below this it is an accidental click and nothing goes out
// (spec 5.2, item 1).
export const MIN_SELECTION_PX = 12;

// The box the server receives (spec 5.2, item 2): borders in 0..1 against the SHOWN video plus the
// frame aspect. The type is declared here and not imported from `api.ts` for the same reason as
// `Position`: the service module does not depend on the HTTP edge, and TS matches both shapes
// structurally. `aspect` is the wire key owned by `shared/utils/api.ts` (server `api/ptz.js`).
export type SelectionBox = { left: number; top: number; right: number; bottom: number; aspect: number };

// Two points in px INSIDE the video box -> normalized box, or `null` when the gesture is not worth a zoom.
export function selectionBox(a: { x0: number; y0: number; x1: number; y1: number; width: number; height: number }): SelectionBox | null {
  // A non-finite coordinate (NaN/Infinity) is not an area: without this guard the clamp propagates the
  // NaN and the box would leave with NaN borders — which the area test lets through (`NaN <= 0` is false)
  // and the server refuses with 400. No point sending a request we already know will fail.
  if (![a.x0, a.y0, a.x1, a.y1, a.width, a.height].every(Number.isFinite)) return null;
  if (!(a.width > 0) || !(a.height > 0)) return null;
  // the pointer may leave the cell mid-gesture (the session lives on window): the border is clamped
  const n = (v: number, total: number) => Math.min(1, Math.max(0, v / total));
  const box: SelectionBox = {
    left: n(Math.min(a.x0, a.x1), a.width), top: n(Math.min(a.y0, a.y1), a.height),
    right: n(Math.max(a.x0, a.x1), a.width), bottom: n(Math.max(a.y0, a.y1), a.height),
    aspect: a.width / a.height,
  };
  // The 12 px minimum applies to the ALREADY CLAMPED box (the effective side in px): two corners outside
  // the frame on the same side shrink the side below 12 px even when the drag in px is larger. Without
  // this the request would leave with an area the operator did not draw (nor see).
  if ((box.right - box.left) * a.width < MIN_SELECTION_PX) return null;
  if ((box.bottom - box.top) * a.height < MIN_SELECTION_PX) return null;
  return box;
}

// Rectangle locked to the box aspect (Nx parity: FixedArSelectionItem::setGeometry does
// Geometry::expanded(KeepAspectRatioByExpanding) from the drag center and then movedInto). The
// geometric center of the drag (origin, clamped cursor) is preserved; the anchor may stop being a
// corner — that is Nx behavior, not a bug. The SAME helper draws (OverlayPtz) and produces the payload
// (StreamCell), which is why it lives in the service, not in the component.
export function fixedRectangle({ x0, y0, x1, y1, width, height }: {
  x0: number; y0: number; x1: number; y1: number; width: number; height: number;
}) {
  if (!(width > 0) || !(height > 0)) return { x0, y0, x1, y1, width, height };
  const a = width / height;
  const cx = Math.min(Math.max(x1, 0), width);
  const cy = Math.min(Math.max(y1, 0), height);
  const w = Math.max(Math.abs(cx - x0), Math.abs(cy - y0) * a);
  const h = w / a;
  const l = Math.min(Math.max((x0 + cx) / 2 - w / 2, 0), width - w);
  const t = Math.min(Math.max((y0 + cy) / 2 - h / 2, 0), height - h);
  return { x0: l, y0: t, x1: l + w, y1: t + h, width, height };
}
