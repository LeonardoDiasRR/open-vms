import { useCallback, useEffect, useRef, useState } from 'react';
import { createInstrument, scale, errorStatus, type SelectionBox, type Instrument, type Vector } from '@/features/live/services/ptz';
import { LIMIT, type Position } from '@/features/live/services/posicoes';
import { useT } from '@/shared/i18n';

// The api arrives structurally (not as Pick<ApiClient>) so the tests can pass partial doubles;
// every method is optional and the hook disconnects itself from what does not exist.
type Api = {
  ptzMove?: (id: string, v: Vector) => Promise<unknown>;
  ptzStop?: (id: string) => Promise<unknown>;
  // ponytail: `supported` is in the shape beyond the PER-AXIS fields the hook reads: it is the
  // mandatory field of the server `PtzCapability`, and without a shared key the cell view (which
  // reuses this type) would not accept the capability.
  ptzCapability?: (id: string, refresh?: boolean) =>
    Promise<{ supported?: boolean; absolutePanTilt?: boolean; absoluteZoom?: boolean }>;
  ptzPositions?: (id: string) => Promise<{ positions: Position[]; error?: string | null }>;
  ptzSavePosition?: (id: string) => Promise<{ id: number; name: string }>;
  ptzGoToPosition?: (id: string, position: number) => Promise<unknown>;
  ptzRenamePosition?: (id: string, position: number, name: string) => Promise<unknown>;
  ptzDeletePosition?: (id: string, position: number) => Promise<unknown>;
  ptzZoomArea?: (id: string, box: SelectionBox) => Promise<unknown>;
  ptzUndoZoom?: (id: string) => Promise<unknown>;
};

// A still pointer generates no event: holding the joystick requires resending the command. 100 ms stays
// below the instrument's 400 ms dead-man and the 80 ms throttle discards the excess.
export const REPEAT_INTERVAL_MS = 100;

// The action hint lives HERE because every command goes through `send`: the vector already says whether
// it is a movement (pan/tilt) or a zoom, and the zoom sign says the direction. That way the keys, the
// wheel, the joystick and the panel buttons show the same hint without one extra line of code (spec
// section 4.1).
export const HINT_TIMEOUT_MS = 700;
export type PtzHint = 'moving' | 'zoom-in' | 'zoom-out';

// Single owner of the PTZ control (spec 2026-10-17): one armed camera at a time, one instrument, one
// dead-man. The state lives here because the right sidebar and the cell (including in fullscreen) show
// the SAME thing, and two competing instruments would send two Stops to the same camera.
export function usePtz(api: Api | null) {
  const { t } = useT();
  const [cameraId, setCameraId] = useState<string | null>(null);
  // The error carries the originating camera: without that, the strip of every cell on the stage would
  // show one camera's defect
  const [error, setError] = useState<{ cameraId: string; text: string } | null>(null);
  const [speed, setSpeed] = useState(1);
  const [positions, setPositions] = useState<Position[]>([]);
  // The capability is read on arm, PER AXIS (spec 2026-10-17, section 3): a camera with continuous zoom
  // only still saves a pan/tilt position.
  const [absolute, setAbsolute] = useState<{ panTilt: boolean; zoom: boolean }>({ panTilt: false, zoom: false });
  const [runningPreset, setRunningPreset] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [hint, setHint] = useState<PtzHint | null>(null);
  const instrument = useRef<Instrument | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs: the callbacks keep a STABLE identity (the cell stores them in effects) and always read the live value
  const apiRef = useRef(api); apiRef.current = api;
  const cameraRef = useRef(cameraId); cameraRef.current = cameraId;
  const speedRef = useRef(speed); speedRef.current = speed;
  const savingRef = useRef(false);

  // stable identity: a language switch must not rebuild the instrument (the cleanup would stop the camera)
  const tRef = useRef(t); tRef.current = t;
  const message = useCallback(
    (e: unknown) => (e instanceof Error && e.message ? e.message : tRef.current('live.ptz.command_failed')),
    [],
  );

  // SINGLE deadline for the three actions (spec 4.4): the last one to arrive owns the text, and two
  // hints never pile up. Each repetition of `hold` (100 ms) pushes the end, so the hint lasts as long as
  // the joystick is held.
  const showHint = useCallback((v: Vector) => {
    setHint(v.zoom ? (v.zoom > 0 ? 'zoom-in' : 'zoom-out') : 'moving');
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), HINT_TIMEOUT_MS);
  }, []);

  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  const stopRepeat = useCallback(() => {
    if (repeatTimer.current) { clearInterval(repeatTimer.current); repeatTimer.current = null; }
  }, []);

  const disarm = useCallback((id?: string) => {
    setError(null);
    setRunningPreset(null);
    setCameraId((current) => (id && current !== id ? current : null));
  }, []);

  const toggle = useCallback((id: string) => {
    setError(null);
    setRunningPreset(null);
    setCameraId((current) => (current === id ? null : id));
  }, []);

  // One instrument per armed camera. Switching camera (or disarming) goes through the cleanup and STOPS
  // the camera: ContinuousMove does not expire on its own.
  useEffect(() => {
    const a = api;
    if (!a || !cameraId || !a.ptzMove || !a.ptzStop) { instrument.current = null; return undefined; }
    // ponytail: ApiClient defines these methods with `this.req`; called detached `this` is lost and the
    // command throws BEFORE leaving the browser (defect measured in production on 2026-10-16). `.call(api)`
    // pins the owner.
    const inst = createInstrument({
      ptzMove: (id, v) => a.ptzMove!.call(a, id, v),
      ptzStop: (id) => a.ptzStop!.call(a, id),
    }, cameraId, 80, 400, (e) => {
      setError({ cameraId, text: message(e) });
      if (errorStatus(e) === 403) setCameraId(null); // insufficient role does not improve by retrying
    });
    instrument.current = inst;
    return () => { stopRepeat(); void inst.stop(); instrument.current = null; };
  }, [api, cameraId, stopRepeat, message]);

  // Saved positions and capability: one read per arm. No cache (the list changes when someone touches the camera).
  useEffect(() => {
    const a = api;
    if (!a || !cameraId) { setPositions([]); setAbsolute({ panTilt: false, zoom: false }); return undefined; }
    let alive = true;
    if (a.ptzPositions) {
      a.ptzPositions(cameraId).then(
        (r) => { if (alive) setPositions(r.positions || []); },
        (e) => { if (alive) setError({ cameraId, text: message(e) }); },
      );
    }
    if (a.ptzCapability) {
      // Revalidation is requested when OPENING live (spec 2026-10-17, section 2): the server cache stops
      // being eternal, and a camera that gained the capability counts on the next arm.
      a.ptzCapability(cameraId, true).then(
        (c) => { if (alive) setAbsolute({ panTilt: c.absolutePanTilt === true, zoom: c.absoluteZoom === true }); },
        () => { if (alive) setAbsolute({ panTilt: false, zoom: false }); },
      );
    }
    return () => { alive = false; };
  }, [api, cameraId, message]);

  // Losing window focus with the camera moving is the classic case of a camera spinning on its own.
  const stop = useCallback(() => { stopRepeat(); void instrument.current?.stop(); }, [stopRepeat]);
  useEffect(() => {
    if (!cameraId) return undefined;
    window.addEventListener('blur', stop);
    return () => window.removeEventListener('blur', stop);
  }, [cameraId, stop]);

  // The factor is optional on purpose (spec 2026-10-23): the joystick and the keyboard keep the panel speed,
  // while the arrow drag already carries the speed in its own length and passes 1.
  const send = useCallback((v: Vector, factor: number = speedRef.current) => {
    showHint(v);
    instrument.current?.move(scale(v, factor));
  }, [showHint]);

  const hold = useCallback((v: Vector, factor?: number) => {
    stopRepeat();
    send(v, factor);
    repeatTimer.current = setInterval(() => send(v, factor), REPEAT_INTERVAL_MS);
  }, [send, stopRepeat]);

  const reload = useCallback(async () => {
    const a = apiRef.current, id = cameraRef.current;
    if (!a || !id || !a.ptzPositions) return;
    try {
      const r = await a.ptzPositions(id);
      setPositions(r.positions || []);
    } catch (e) {
      setError({ cameraId: id, text: message(e) });
    }
  }, [message]);

  // Every position action follows the same design: failure becomes the camera error, 403 disarms, success reloads.
  const run = useCallback(async (fn: (a: Api, id: string) => Promise<unknown>, reloadAfter = false) => {
    const a = apiRef.current, id = cameraRef.current;
    if (!a || !id) return;
    setError(null);
    try {
      await fn(a, id);
      if (reloadAfter) await reload();
    } catch (e) {
      setError({ cameraId: id, text: message(e) });
      if (errorStatus(e) === 403) setCameraId(null);
    }
  }, [reload, message]);

  const goTo = useCallback((position: number) => {
    setRunningPreset(position);
    return run((a, id) => a.ptzGoToPosition!(id, position)).finally(() => setRunningPreset(null));
  }, [run]);

  // The default name belongs to the SERVER (amendment E1): the client sends only the camera and receives `{ id, name }`.
  const save = useCallback(() => {
    if (savingRef.current) return Promise.resolve();  // save already running
    savingRef.current = true;
    setSaving(true);
    return run((a, id) => a.ptzSavePosition!(id), true)
      .finally(() => { savingRef.current = false; setSaving(false); });
  }, [run]);

  const rename = useCallback((position: number, name: string) =>
    run((a, id) => a.ptzRenamePosition!(id, position, name), true), [run]);

  const remove = useCallback((position: number) =>
    run((a, id) => a.ptzDeletePosition!(id, position), true), [run]);

  // Zoom into the marked area (spec 2026-10-18): the box already comes computed by the component; here
  // only the error enters the SAME channel as the other actions — the 409 of a camera without absolute
  // position shows in the cell chip.
  const zoomArea = useCallback((box: SelectionBox) =>
    run((a, id) => a.ptzZoomArea!(id, box)), [run]);

  // Nx's `ptzUnzoom` (spec 5.4): the origin of the return belongs to the SERVER (amendment E5).
  const undoZoom = useCallback(() => run((a, id) => a.ptzUndoZoom!(id)), [run]);

  return {
    cameraId, active: cameraId !== null, error, hint, speed, positions, absolute, runningPreset, saving,
    canSave: (absolute.panTilt || absolute.zoom) && positions.length < LIMIT && !saving,
    toggle, disarm, move: send, hold, release: stop, stop,
    applySpeed: (factor: number) => setSpeed(factor),
    goTo, save, rename, remove, zoomArea, undoZoom,
  };
}

export type PtzApi = ReturnType<typeof usePtz>;
