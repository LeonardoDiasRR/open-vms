import { useEffect, useRef, useState } from 'react';
import CameraMenu, { type ItemMenu } from '@/shared/ui/CameraMenu';
import { cellProfile, type Profile } from '@/features/live/services/perfis';
import { cellState } from '@/shared/domain/stage';
import { useFullscreen } from '@/shared/hooks/useTelaCheia';
import { ARROW_THRESHOLD_PX, selectionBox, fixedRectangle, dragVector, keyVector, zoomVector, zoomShortcutVector } from '@/features/live/services/ptz';
import type { PtzApi } from '@/features/live/hooks/usePtz';
import { useT } from '@/shared/i18n';
import PtzPanel from './PainelPtz';
import OverlayPtz, { type OverlayPtzHandle } from './OverlayPtz';

// Props contracts of this cell (come from the importers: StageGrid passes api/camera/profiles).
// PTZ (spec 2026-10-16): the capability belongs to the SERVER (proved against the device and cached in
// cam.ptz); without it the button does not exist. The methods are optional so old importers stay valid.
type Api = {
  liveToken: (profileId: string) => Promise<{ whep_url: string; token: string }>;
  ptzCapability?: (id: string) => Promise<{ supported?: boolean; home?: boolean }>;
};
// recording (spec 2026-10-16): feeds the FULL dot when recording is on
// task 4.4: can_control comes from the server (grant per camera); absent means false (safe default)
type Camera = { id: string; name: string; state?: string; error_code?: string; recording?: boolean; ptz?: { supported?: boolean } | null; can_control?: boolean; ativa?: boolean };

type Props = {
  api: Api;
  camera: Camera;
  profiles?: Profile[];
  mode?: string;
  onRemove?: () => void;
  actions?: ItemMenu[];
  onAction?: (id: string) => void;
  ptz?: PtzApi;
};

// Joystick: Lucide drawing (lucide.dev), ISC license — the same object as the user's reference (base,
// small button on the base, stem and ball). Copied on 2026-10-16 from icons/joystick.svg.
// Off: outline. On: the color comes from CSS (.cell-ptz.ativo, design-system green) and the BALL becomes
// solid. Only the ball: the solid base turned into a blob at 18px (measured in Chromium). At 18px the
// drawing reads as a joystick; at 13px and 16px it does not — that is why the CSS fixes 18px.
function Joystick({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round" data-filled={filled ? 'yes' : 'no'} aria-hidden="true" focusable="false">
      <path d="M21 17a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2Z" />
      <path d="M6 15v-2" />
      <path d="M12 15V9" />
      <circle cx="12" cy="6" r="3" fill={filled ? 'currentColor' : 'none'} />
    </svg>
  );
}

// Video cell (spec 2026-10-15): plays the secondary profile and falls back to the primary when the
// secondary delivers no frames. Fullscreen uses the primary. No snapshot: without a frame, the cell
// shows "No signal" with the red X and retries every 10 s.
// The context menu (spec 2026-10-15, item 2.3) is rendered INSIDE this root: in fullscreen the browser
// only paints the subtree of the fullscreen element, so a menu mounted in LiveView would be invisible there.
export default function StreamCell({ api, camera, profiles = [], mode = 'live', onRemove, actions = [], onAction = () => {}, ptz }: Props) {
  const { t } = useT();
  // t stays out of the effect deps (a language switch must not renegotiate the stream): the ref keeps the text current
  const tRef = useRef(t); tRef.current = t;
  const [failed, setFailed] = useState(false);       // current attempt failed
  const [blocked, setBlocked] = useState(false);     // codec refused by the browser: retry does not resolve
  const [inactive, setInactive] = useState(false);   // plan 2026-10-27: camera_inactive (409): retry does not resolve
  const [reason, setReason] = useState<string | null>(null); // goes in the warning title
  const [fellBack, setFellBack] = useState(false);   // sticky fallback of this cell
  const [attempt, setAttempt] = useState(0);         // bump to retry
  // spec 2026-10-27 (graca-reativacao-spinner): flipping `ativa` false→true re-arms the session, but the
  // Hub needs up to 30 s of reconcile + camera pull before WHEP can answer; in that window the attempt
  // fails ("WHEP answered 503") and the cell would flash "No signal" while nothing is broken. Grace keeps
  // the spinner and hides every failure overlay for 60 s.
  const [grace, setGrace] = useState(false);
  const wasAtiva = useRef(camera.ativa);            // mount = current value: mounting never triggers grace
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // {x, y} of the right click
  const [playing, setPlaying] = useState(false);     // the video already delivered a frame on this attempt
  const [ptzSupported, setPtzSupported] = useState(camera.ptz?.supported === true);
  const [dragging, setDragging] = useState(false);
  const [selecting, setSelecting] = useState(false); // Shift+drag rectangle in progress
  const ptzRef = useRef(ptz);
  ptzRef.current = ptz;
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const overlay = useRef<OverlayPtzHandle>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { isFullscreen, toggleFullscreen } = useFullscreen(ref);
  const grab = useRef({ x: 0, y: 0 }); // point where the left button went down: the vector is relative to it
  // spec 2026-10-23: the drag session has a state (moving / idle). The ref keeps it out of React state, so a
  // pointermove below the threshold does not re-render the cell — and the Stop goes out once, not per event.
  const dragMoving = useRef(false);
  const zoomOrigin = useRef({ x: 0, y: 0 }); // corner of the Shift mousedown, in px inside the box
  const zoomCurrent = useRef({ x: 0, y: 0 });  // last drag point: it is the corner that counts on pointerup
  // The browser fires `click` after mousedown+mouseup on the same element, even with a displacement in
  // between. Without this guard Shift+drag would TOGGLE the cell mark (sibling spec 2026-10-18). The guard
  // covers the whole gesture, including a short Shift+click — Shift is a PTZ gesture, not a mark one.
  const suppressClick = useRef(false);
  // The mode is GLOBAL (spec 2026-10-17): the armed camera belongs to the hook, and only one at a time.
  const ptzActive = !!ptz && ptz.cameraId === camera.id;
  const ptzError = ptz?.error && ptz.error.cameraId === camera.id ? ptz.error.text : null;

  // cell swapped to another camera: the fallback does not travel along
  useEffect(() => { setFellBack(false); }, [camera.id]);

  // PTZ capability: uses what the server already cached in cam.ptz; without a cache, probes ONCE per
  // camera (the server stores it and answers the next navigations without touching the device)
  useEffect(() => {
    if (camera.ptz) { setPtzSupported(camera.ptz.supported === true); return undefined; }
    if (!api.ptzCapability) { setPtzSupported(false); return undefined; }
    let cancelled = false;
    api.ptzCapability(camera.id)
      .then((c) => { if (!cancelled) setPtzSupported(c.supported === true); })
      .catch(() => { if (!cancelled) setPtzSupported(false); });
    return () => { cancelled = true; };
  }, [api, camera.id, camera.ptz?.supported]);

  // Unmounting the armed cell disarms the mode and stops the camera (switching layout cannot leave the camera spinning)
  useEffect(() => () => { ptzRef.current?.disarm(camera.id); }, [camera.id]);

  // task 4.4: the grant revoked while this cell is the armed one (can_control flips to false on a refresh):
  // run the SAME teardown the manual click uses (disarmPtz), so the mode never survives the grant.
  useEffect(() => {
    if (ptzActive && camera.can_control !== true) disarmPtz();
  }, [ptzActive, camera.can_control]);

  const activeProfile = cellProfile(profiles, { fullscreen: isFullscreen, fellBack });

  // The image format (width/height, unitless number). Source 1: the resolution of the active profile,
  // which exists before the first frame. Source 2: the video itself, on loadedmetadata — only needed when
  // the profile carries no resolution (the manual profile). With neither, the box stays `cheia` (today's
  // behavior).
  const [videoAspect, setVideoAspect] = useState<number | null>(null);
  const aspect = activeProfile?.width && activeProfile?.height
    ? activeProfile.width / activeProfile.height
    : videoAspect;

  // Live over WebRTC (WHEP): the Hub delivers the stream straight to the browser, no proxy. The read token
  // is short-lived and bound to this profile; it goes in the QUERY because that is how mediamtx hands it
  // to our auth callback. The watchdog, the secondary->primary fallback and the 10 s retry are the same as
  // before — only the transport changed.
  useEffect(() => {
    setFailed(false);
    setReason(null);
    setBlocked(false);
    setInactive(false);
    setPlaying(false);
    const video = videoRef.current;
    if (!activeProfile?.id || !video) return undefined;

    const currentId = activeProfile.id;
    const primaryId = cellProfile(profiles, { fullscreen: true })?.id || null;
    let pc: RTCPeerConnection | null = null;
    let cancelled = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;

    // ponytail: "has image" is wider than "is playing": the first painted frame (loadeddata) clears the
    // warning, but ONLY 'playing' disarms the watchdog
    const markImage = () => setPlaying(true);
    const onPlaying = () => { if (watchdog) clearTimeout(watchdog); setFailed(false); markImage(); };
    const onNativeError = () => fail(tRef.current('live.playback_error'));
    const fail = (text: string, codecBlocked = false, cameraInactive = false) => {
      setBlocked(codecBlocked);
      setInactive(cameraInactive);
      if (pc) { pc.close(); pc = null; }
      if (watchdog) clearTimeout(watchdog);
      setReason(text);
      setPlaying(false);
      // still on the secondary: fall back to the primary in this cell and stop here
      if (primaryId && currentId !== primaryId) { setFellBack(true); return; }
      setFailed(true);
    };

    (async () => {
      try {
        const { whep_url, token } = await api.liveToken(currentId);
        if (cancelled) return;
        pc = new RTCPeerConnection({ iceServers: [] });
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });
        pc.ontrack = (ev) => { video.srcObject = ev.streams[0] || null; markImage(); };
        pc.onconnectionstatechange = () => {
          if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
            fail(tRef.current('live.webrtc_disconnected'));
          }
        };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const resp = await fetch(`${whep_url}?ovms_token=${encodeURIComponent(token)}`, {
          method: 'POST', headers: { 'content-type': 'application/sdp' }, body: offer.sdp,
        });
        if (!resp.ok) {
          // plan 2026-10-26: o mediamtx responde 400 com {"error":"codecs not supported by client"}
          // when the browser does not decode the path codec (H.265 on Firefox/Edge). The message
          // names H.265 because it is the only refused codec in this install; another codec would need
          // deriving the name from the response.
          const body = await resp.text().catch(() => '');
          const codec = resp.status === 400 && /codec/i.test(body);
          fail(codec ? tRef.current('live.codec_unsupported') : `WHEP answered ${resp.status}`, codec);
          return;
        }
        const answer = await resp.text();
        if (cancelled) return;
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      } catch (e) {
        if (cancelled) return;
        // plan 2026-10-27 (camera-ativa): POST /live/token returns 409 camera_inactive when the camera
        // is inactive (server/api/live.js). The thin ApiClient pastes the status onto the Error (the body `code`
        // does not survive); 409 is the only code of this route today. The `code` is checked at the source for the day
        // httpError starts attaching it.
        const err = e as { code?: string; status?: number };
        const off = err.code === 'camera_inactive' || err.status === 409;
        fail(e instanceof Error ? e.message : tRef.current('live.webrtc_failed'), false, off);
      }
    })();

    video.addEventListener('playing', onPlaying);
    video.addEventListener('loadeddata', markImage);
    video.addEventListener('error', onNativeError);
    // TODO(i18n): no `live.no_frames` key in en.ts yet (task 6.2).
    watchdog = setTimeout(() => fail('No frames in 10 s'), 10000);

    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('loadeddata', markImage);
      video.removeEventListener('error', onNativeError);
      if (pc) { pc.close(); pc = null; }
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    };
  }, [api, camera.id,
    // plan 2026-10-27 defect: the flag is the event that re-arms the cell. Flipping it re-runs the session:
    // off → cleanup closes the pc and the remount gets 409 (placeholder); on → new token, video returns.
    camera.ativa, activeProfile?.id, attempt]);

  // Persistent "No signal": retry 10 s after the failure (the watchdog already waited 10 s).
  // plan 2026-10-26: a codec refused by the browser is not transient — repeating it every 10 s never resolves.
  // plan 2026-10-27: an inactive camera is the same case (only the modal toggle re-arms it; remounting the cell
  // on camera/layout switch retries naturally).
  useEffect(() => {
    if (!failed || blocked || inactive) return undefined;
    const id = setInterval(() => { setFailed(false); setAttempt((n) => n + 1); }, 10000);
    return () => clearInterval(id);
  }, [failed, blocked, inactive]);

  // spec 2026-10-27 (graca-reativacao-spinner): grace starts on the FLIP only (never on mount) and ends
  // with the timer or the next flip — toggling off again must show "Camera inactive" immediately.
  useEffect(() => {
    const was = wasAtiva.current;
    wasAtiva.current = camera.ativa;
    if (graceTimer.current) { clearTimeout(graceTimer.current); graceTimer.current = null; }
    if (camera.ativa && !was) {
      setGrace(true);
      graceTimer.current = setTimeout(() => { graceTimer.current = null; setGrace(false); }, 60000);
    } else {
      setGrace(false);
    }
    return () => { if (graceTimer.current) { clearTimeout(graceTimer.current); graceTimer.current = null; } };
  }, [camera.ativa]);

  // ---- PTZ: the instrument only exists with proof of capability AND live video (in Nx, checkPlayingLive)
  const live = !!activeProfile?.id;
  const offline = failed || camera.state !== 'online';
  const state = cellState({ hasProfile: live, failed, playing });
  // spec 2026-10-16: the icon does not look at the camera state — it requires an IMAGE ON SCREEN (first frame)
  // task 4.4: it also requires the grant on THIS camera (can_control strictly true; absent = false)
  const ptzAvailable = state === 'playing' && ptzSupported && camera.can_control === true && !!api.ptzCapability && !!ptz;

  function ptzDown(e: React.PointerEvent) {
    // The NEW gesture always re-arms the guard: if the previous gesture's `click` did not arrive (pointerup
    // outside the window), a stale flag would swallow the next ordinary click.
    suppressClick.current = false;
    if (!ptzActive || e.button !== 0) return;
    // ponytail: a click on the action bar (the joystick itself, fullscreen, X) does not enter the instrument.
    // Without this guard the cell pointer capture hands the click back to the cell and the button never turns off.
    if ((e.target as HTMLElement).closest('.cell-actions')) return;
    // the click position is relative to the BOX (the overlay lives inside it and the CSS positions it with
    // `position: absolute`), not to the window
    const r = frame.current?.getBoundingClientRect();
    if (e.shiftKey) {
      // Shift + left button = area selection (spec 2026-10-18, section 5.1). The gesture is decided HERE:
      // Shift pressed after mousedown does NOT turn the arrow drag into a rectangle.
      suppressClick.current = true;
      // Pointer capture ONLY on this branch (the arrow one dismissed it: it handed the click back to the
      // cell and the action bar button did not turn off). Without it, a drag that ends on the stage gutter
      // delivers the `pointerup` to the stage, Chrome dispatches the `click` on the COMMON ANCESTOR (the
      // stage itself) and the guard does not see it — the click clears the cell mark. With the capture,
      // the `click` is born on `.stream-cell`.
      ref.current?.setPointerCapture?.(e.pointerId);
      zoomOrigin.current = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
      zoomCurrent.current = { ...zoomOrigin.current };
      overlay.current?.startSelection(zoomOrigin.current.x, zoomOrigin.current.y, r?.width ?? 0, r?.height ?? 0);
      setSelecting(true);
      return;
    }
    grab.current = { x: e.clientX, y: e.clientY };
    overlay.current?.show(e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
    setDragging(true);
  }
  // The pointer session lives on window: the gesture stays correct when the pointer leaves the cell and does
  // not depend on capture retargeting (which was what swallowed the button click).
  useEffect(() => {
    if (!dragging) return undefined;
    const onMove = (e: PointerEvent) => {
      const r = frame.current?.getBoundingClientRect();
      overlay.current?.update(e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0));
      // The arrow LENGTH is the speed, so the command REPEATS while the button is held: a still pointer
      // generates no event and the instrument dead-man would stop the camera after 400 ms (defect of
      // 2026-10-23). Below the threshold the arrow is not drawn and no zero-speed vector goes out (the
      // server refuses it with 400); the camera stops once, guarded by the ref.
      const dx = e.clientX - grab.current.x;
      const dy = e.clientY - grab.current.y;
      if (Math.hypot(dx, dy) >= ARROW_THRESHOLD_PX) {
        dragMoving.current = true;
        ptz?.hold(dragVector(dx, dy), 1);
      } else if (dragMoving.current) {
        dragMoving.current = false;
        ptz?.stop();
      }
    };
    const onRelease = () => {
      dragMoving.current = false;
      setDragging(false);
      overlay.current?.hide();
      ptz?.stop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, [dragging]);

  // Rectangle session: same technique as the arrow (window listener), so the gesture survives the pointer
  // leaving the cell. The rectangle disappears in ALL cases; the request only leaves with a valid box (spec 5.2).
  useEffect(() => {
    if (!selecting) return undefined;
    const onMove = (e: PointerEvent) => {
      const r = frame.current?.getBoundingClientRect();
      zoomCurrent.current = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
      overlay.current?.extend(zoomCurrent.current.x, zoomCurrent.current.y);
    };
    // The final corner comes from the LAST pointermove, not from the release event: `pointercancel` arrives
    // with a coordinate that does not count, and the last point is what the operator saw drawn.
    const onRelease = () => {
      setSelecting(false);
      overlay.current?.clearSelection();
      // The gesture's `click` is dispatched in the SAME task as `pointerup` (the capture guarantees it is
      // born on `.stream-cell`): disarming here, without waiting, would let the gesture's OWN click toggle the
      // mark. One macrotask later the guard is gone for the NEXT click — that was the opposite defect: the
      // `click` of a release outside the window is born on `HTML` (measured), outside the cell, and the guard
      // stayed stuck swallowing the next click and even an Enter on a focused button of the cell.
      setTimeout(() => { suppressClick.current = false; }, 0);
      const r = frame.current?.getBoundingClientRect();
      const marked = selectionBox(fixedRectangle({
        x0: zoomOrigin.current.x, y0: zoomOrigin.current.y,
        x1: zoomCurrent.current.x, y1: zoomCurrent.current.y,
        width: r?.width ?? 0, height: r?.height ?? 0,
      }));
      // below 12 px on any side is an accidental click: nothing is sent
      if (marked) ptzRef.current?.zoomArea(marked);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, [selecting]);
  function disarmPtz() { setDragging(false); ptz?.disarm(camera.id); }

  // Mouse wheel and keyboard: NATIVE listener (React registers wheel as passive and preventDefault does not count)
  useEffect(() => {
    const el = ref.current;
    if (!ptzActive || !el) return undefined;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); ptz?.move(zoomVector(e.deltaY < 0 ? 1 : -1)); };
    // a text field owns the arrows itself: the instrument does not steal a key from an input
    const isTextField = (target: EventTarget | null) =>
      target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextField(e.target)) return;
      const v = keyVector(e.key) || zoomShortcutVector(e.key);
      if (!v) return;
      e.preventDefault();
      // ponytail: do NOT skip e.repeat — the keyboard repetition is what re-arms the dead-man while the arrow
      // stays pressed; the instrument throttle limits the rate
      ptz?.move(v);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!keyVector(e.key) && !zoomShortcutVector(e.key)) return;
      ptz?.stop();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    // `true` = capture phase: a parent handler on the bubble path cannot swallow the arrows
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      el.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [ptzActive, ptz]);

  return (
    // double click on the stream = fullscreen (already in fullscreen, the double click is native to the video)
    <div className={`stream-cell${offline ? ' off' : ''}${ptzActive ? ' ptz-ativo' : ''}`} ref={ref}
      // spec 2026-10-18 (5.4) + amendment E6: in PTZ mode the double click is Nx's `ptzUnzoom`; fullscreen
      // stays on the button. Outside PTZ mode nothing changed.
      onDoubleClick={() => {
        if (ptzActive) { ptz?.undoZoom(); return; }
        if (!document.fullscreenElement) ref.current?.requestFullscreen?.().catch(() => {});
      }}
      // amendment E9: the `click` the browser fires after a Shift gesture dies in the CAPTURE phase, before
      // reaching the cell mark handler (sibling spec of the selected cell).
      onClickCapture={(e) => {
        if (!suppressClick.current) return;
        suppressClick.current = false;
        e.stopPropagation();
      }}
      onPointerDown={ptzDown}
      // Chrome cancels pointer events when a native media drag starts
      onDragStart={(e) => e.preventDefault()}
      // ponytail: the menu grows to the LEFT (translateX(-100%), min-width 190px) and the cell has
      // overflow:hidden — with the raw click point, the left/bottom edge opens the menu out of view
      // (measured: click at x=20 -> left=-170, bottom=619 in a 577 viewport). In fullscreen the cell IS the
      // viewport, so the limit holds in both contexts.
      onContextMenu={(e) => {
        // spec overlapping-menus 2026-10-18: in fullscreen the PTZ panel is painted INSIDE the cell; what is
        // born in the panel strip never opens the camera menu
        if ((e.target as HTMLElement).closest('.cell-painel-ptz')) return;
        e.preventDefault();
        const width = 200;  // min-width 190 + padding 4*2 + border 1*2
        const height = 76;  // measured: 2-item menu = 72px
        const margin = 6;
        setMenu({
          x: Math.min(Math.max(e.clientX, width + margin), window.innerWidth - margin),
          y: Math.min(Math.max(e.clientY, margin), window.innerHeight - height - margin),
        });
      }}>
      <div className={`cell-quadro${aspect ? '' : ' cheia'}${offline ? ' off' : ''}`}
        ref={frame}
        style={aspect ? ({ '--formato': aspect } as React.CSSProperties) : undefined}>
        {/* ponytail: the video stays mounted in ALL states, including "No signal" — the retry needs the ref to
            reattach the stream. The warning is a sibling overlay (.no-signal), never a replacement for the
            <video>: unmounting on failure would make the effect run with videoRef.current === null and exit
            without arming anything. Project invariant. */}
        {live && <video ref={videoRef} muted autoPlay playsInline draggable={false}
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight) setVideoAspect(v.videoWidth / v.videoHeight);
          }} />}
        {/* transitional interval: profile chosen, no frame and no failure. It sits BEFORE the name/badge
            overlay in the DOM so both stay readable above the warning. */}
        {(state === 'loading' || (grace && !playing)) && (
          <div className="cell-loading" role="status">
            <span className="cell-spinner" aria-hidden="true" />
            <span>{t('live.loading')}</span>
          </div>
        )}
        {failed && !grace && (
          // TODO(i18n): no `live.no_signal` key in en.ts yet (task 6.2).
          <div className="no-signal" title={reason || camera.error_code || ''}>
            <span className="no-signal-x" aria-hidden="true">✕</span>
            <strong>{inactive ? t('live.camera_inactive') : blocked ? t('live.codec_unsupported') : 'No signal'}</strong>
          </div>
        )}
        <div className="cell-overlay">
          <span className={`badge ${offline ? 'error' : 'online'}${camera.recording ? ' cheia' : ''}`} />
          <span className="cell-name">{camera.name}</span>
          <div className="cell-actions">
            {/* PTZ target: before fullscreen, to the left of the X — the same place as the instrument in Nx */}
            {ptzAvailable && (
              <button className={`cell-ptz${ptzActive ? ' ativo' : ''}`} aria-label="PTZ" title="PTZ"
                aria-pressed={ptzActive}
                onClick={() => (ptzActive ? disarmPtz() : ptz?.toggle(camera.id))}>
                <Joystick filled={ptzActive} />
              </button>
            )}
            {/* TODO(i18n): no `live.exit_fullscreen` key in en.ts yet (task 6.2). */}
            <button title={isFullscreen ? 'Exit fullscreen' : t('live.fullscreen')} onClick={toggleFullscreen}>⛶</button>
            {onRemove && <button title={t('live.remove')} onClick={onRemove}>✕</button>}
          </div>
        </div>
        {(ptzActive || ptzError) && (
          <div className={`cell-ptz-faixa${ptzError ? ' erro' : ''}`} role="status" aria-live="polite">
            {ptzError ? `PTZ: ${ptzError}` : t('live.ptz_active_hint')}
          </div>
        )}
        <div className="cell-stream">
          {activeProfile && <span className="cell-profile">{activeProfile.name || activeProfile.id}</span>}
          <span className="cell-mode">{mode}</span>
        </div>
        {/* outside React state: the target and arrow position enter by inline style (spec 4.2) */}
        <OverlayPtz ref={overlay} hint={ptzActive ? (ptz?.hint ?? null) : null} />
      </div>
      {/* spec 2026-10-17: in fullscreen the browser only paints this subtree, so the panel has to be rendered
          here. Outside fullscreen the App renders it, in the right sidebar. */}
      {isFullscreen && ptzActive && ptz && (
        <div className="cell-painel-ptz"><PtzPanel ptz={ptz} /></div>
      )}
      {menu && (
        <CameraMenu
          x={menu.x}
          y={menu.y}
          items={actions}
          onPick={(id) => { setMenu(null); onAction(id); }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
