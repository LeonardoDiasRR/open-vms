import { useState } from 'react';
import CameraMenu from '@/shared/ui/CameraMenu';
import RecordingPlayer, { type PlayerHandle, type PlayerState } from './PlayerGravacao';
import type { Camera } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';
import type { MessageKey } from '@/shared/i18n/en';

// spec 2026-10-18 (archive-bottom-sheet, C3): the playback cell body inside StagePalco. The stage
// handles the 1st/2nd click (selects+expands / undoes keeping the border) and the resize; here live
// the video, the thin footer with the name, the no-recording warning and the context menu.
// correction 2026-10-26: the menu mirrors the live cell — settings, rename, remove (destructive last).
// The `player` class reuses the player skin (styles.css) and `player-bar` is hidden by CSS inside
// .stage-cell: the Bottom Sheet drives everything through the global clock.
// spec 2026-10-18 (videowall-recording-tabs, section 6.4): the cell got the live bar — the
// `.cell-overlay` on hover with `.cell-actions`: ⛶ and ✕ (onRemove). The double click got the live
// guard: it only asks for fullscreen when not in it yet. The context menu stays — parity with live,
// which keeps both paths.
// spec 2026-10-19 (selection-sheet-floating-fullscreen, S2/S3/S5): the Archive fullscreen became the
// CONTAINER's (.arquivo-stage), owned by ArchiveView. The useFullscreen hook leaves playback (it
// stays only in live): the cell is driven by the `fullscreen`/`onFullscreen` props and receives the
// `celula-tela-cheia` class when expanded.

// spec 2026-10-19 (state-feedback): centre of the cell while there is no frame. The text is short
// and the icon follows: a spinning spinner while waiting, a still '!' on error. HEVC in the camera =
// server-side transcoding, a cold window takes seconds — without this the cell is silent black
// screen (the measured complaint).
const STATE_KEY = {
  connecting: 'auth.connecting',
  loading: 'archive.loading',
  buffering: 'archive.loading',
  recovering: 'archive.recovering',
  transcoding: 'archive.h264_server',
} as const satisfies Record<'connecting' | 'loading' | 'buffering' | 'recovering' | 'transcoding', MessageKey>;

// the profile that RECORDS (same math as the extinct wall and the single page)
const pid = (c: Camera) => c.recording_profile_id || (c.profile_ids || [])[0] || null;

// Local HH:MM:SS for the hole label (spec 2026-10-21): the operator's own clock, 24 h.
const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString([], {
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

type Props = {
  cam: Camera | undefined;
  covered: boolean;
  instant: number;
  autoPlay?: boolean;                      // clock playing: the remounted window cell resumes
  speed: number;                           // pace of the global clock: the video must follow (20/10)
  api: { base: string; token: string };
  handleRef: (h: PlayerHandle | null) => void;
  onRemove: () => void;
  onConfig?: (cameraId: string, name: string) => void;
  onRename?: (cameraId: string, name: string) => void;
  fullscreen: boolean;                     // page ownership (S3): drives the class and the ⛶ label
  onFullscreen: () => void;                // gesture: the page decides and requests container fullscreen
  /** Recording gap under the playhead (global clock, spec 2026-10-21); null outside it */
  hole?: { from: number; to: number } | null;
  /** Coverage may grow (today, live): the cell says "waiting", not "no recording" */
  atEdge?: boolean;
  seekRequest?: { id: number; target: number };
  // phase 4.3: the menu's 'rename' PATCHes the camera (POLICY camera.manage). Absent = everything (default).
  canManageCameras?: boolean;
};

export default function PlaybackCell({ cam, covered, instant, autoPlay, speed, api, handleRef, onRemove, onConfig = () => {}, onRename = () => {}, fullscreen, onFullscreen, hole = null, atEdge = false, seekRequest, canManageCameras = true }: Props) {
  const { t } = useT();
  // freezes initialTs on mount: the clock runs on rAF and the live prop would fire the seek effect
  // on every frame (PlayerGravacao.tsx:172-178; contract inherited from the extinct wall)
  const [mountTs] = useState(() => instant);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // last state told by the player (connecting/loading/transcoding/ready/error)
  const [state, setState] = useState<PlayerState | null>(null);
  if (!cam) return <div className="slot-empty">{t('live.no_camera')}</div>;
  const profile = pid(cam);
  const hasProfile = !!profile;
  const items = [
    { id: 'settings', label: t('cameras.camera_settings') },
    ...(canManageCameras ? [{ id: 'rename', label: t('cameras.rename') }] : []),
    { id: 'remove', label: t('shared.remove_from_layout'), danger: true },
  ];
  return (
    <div className={'celula-playback player' + (fullscreen ? ' celula-tela-cheia' : '')}
      onDoubleClick={() => {
        // live guard (StreamCell.tsx:327-334): in fullscreen the double click becomes a native gesture
        if (!document.fullscreenElement) onFullscreen();
      }}
      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}>
      <RecordingPlayer ref={handleRef} api={api} profile={profile} initialTs={mountTs}
        initialSpeed={speed}
        shortcuts={false} autoPlay={autoPlay} covered={covered} onState={setState}
        continuous seekRequest={seekRequest} resumeTs={instant} />
      {covered && hasProfile && state !== null && state.kind !== 'ready' && (
        state.kind === 'error' ? (
          <div className="no-signal" role="status" title={state.message || ''}>
            <span className="no-signal-x" aria-hidden="true">✕</span>
            <strong>{state.message || t('archive.load_failed')}</strong>
          </div>
        ) : (
          <div className="cell-loading" role="status">
            <span className="cell-spinner" aria-hidden="true" />
            <span>{t(STATE_KEY[state.kind])}</span>
          </div>
        )
      )}
      <div className="cell-overlay">
        <div className="cell-actions">
          <button title={fullscreen ? t('archive.close_options') : t('archive.fullscreen')} onClick={onFullscreen}>⛶</button>
          <button title={t('archive.remove')} onClick={onRemove}>✕</button>
        </div>
      </div>
      <div className="celula-playback-nome">{cam.name}{state?.quality === 'preview' ? ` · ${t('archive.preview')}` : ''}</div>
      {!covered && hole && (
        <div className="sem-gravacao" role="status">
          {t('archive.recording_hole', { from: fmtTime(hole.from), to: fmtTime(hole.to) })}
        </div>
      )}
      {!covered && !hole && atEdge && (
        <div className="sem-gravacao" role="status">{t('archive.recording_wait')}</div>
      )}
      {!covered && !hole && !atEdge && <div className="sem-gravacao">{t('archive.no_recording')}</div>}
      {menu && <CameraMenu x={menu.x} y={menu.y} items={items}
        onPick={(id) => {
          setMenu(null);
          if (id === 'remove') onRemove();
          else if (id === 'settings') onConfig(cam.id, cam.name);
          else if (id === 'rename') onRename(cam.id, cam.name);
        }}
        onClose={() => setMenu(null)} />}
    </div>
  );
}

