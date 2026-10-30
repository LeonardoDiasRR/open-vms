import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiClient, type Camera, type Group } from '@/shared/utils/api';
import type { OpenRequest, LayoutToOpen } from '@/shared/domain/pedidoAbrir';
import { useGlobalClock } from '../hooks/useRelogioGlobal';
import StagePalco from '@/shared/ui/StagePalco';
import StageTabs from '@/shared/ui/StageTabs';
import { useLayoutTabs, getStageTabsSnapshot, setStageTabsSnapshot, clearStageTabsSnapshot,
  stageSnapshotGeneration } from '@/shared/hooks/useAbasLayout';
import CameraMenu from '@/shared/ui/CameraMenu';
import { usePromptDialog, PromptDialog } from '@/shared/components/PromptDialog';
import { useCellSelection } from '@/shared/hooks/useSelecaoCelula';
import { useLayoutDrop } from '@/shared/hooks/useDropDeLayout';
import PlaybackCell from '../components/CelulaPlayback';
import BottomSheet from '../components/BottomSheet';
import ExportDialog from '../components/ExportarDialog';
import { runs, mergeTail, type Segment } from '../services/faixas';
// Removal goes through the SHARED domain function (same as Live, StageGrid.tsx:55): `remove` also
// recompacts with `center` (NX centralizeItems). A bare `filter` here kept the bounding rect big and
// left the stage with an empty column/row — the asymmetry measured on 2026-10-24.
import { remove } from '@/shared/domain/stage';
import type { PlayerHandle } from '../components/PlayerGravacao';
import { useT } from '@/shared/i18n';
import { HARD_SEEK_COOLDOWN_MS, recoveryTarget, wallReady } from '../services/playback-sync';

// spec 2026-10-18 (archive-bottom-sheet): the Archive tab became ONE playback stage with the Live
// behavior (drop, 1-click selection = select+expand / 2 clicks = undo keeping the border, resize
// handle, no scrollbars) and a fixed Bottom Sheet (play/pause + speed + clock; expanded: 24 h tracks
// — the calendar died, spec 2026-10-19). Individual/Wall no longer exist, nor a toolbar or control
// panel: time belongs to the global clock and does NOT advance with the clock (D1); the day changes
// through the date picker or by dragging the timeline, ALWAYS in
// The layout is not persisted (same rule as the extinct wall); the stage is the live saved layout
// when the request carries `layout`; opening a layout (request, drop or double click) opens/focuses
// a TAB, like in Live (spec 2026-10-18 videowall-recording-tabs, D1 — revokes D6).
//
// The skin comes from the `.player` class; `player-bar` is hidden by CSS inside `.stage-cell` —
// whoever commands is the sheet through the global clock.

// ponytail: the api error is an Error with .status glued by hand (see api.mjs), with no type of its
// own in the JS module — the status comes out by narrowing, not by cast
const errMessage = (e: unknown) => `${e instanceof Error ? e.message : String(e)}`.trim();

const MIDNIGHT = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return Math.floor(d.getTime() / 1000); };
const SECONDS_PER_DAY = 86400;
const COVERAGE_POLL_MS = 30_000;   // spec 2026-10-20 (D4): coverage tail poll (current day only)
const pid = (c: Camera) => c.recording_profile_id || (c.profile_ids || [])[0] || null;
type Cam = Camera & { profile_ids?: string[] };

export type Props = {
  api: ApiClient;
  // Multi-server (spec 2026-10-30, 5.6): o ApiClient do servidor da câmera — timeline, player e o
  // export do modal resolvem por ele. Ausente = tudo no `api` (chamador de um servidor só).
  apiFor?: (serverId: string) => ApiClient;
  // The App hands the catalog as a prop (same invoice as Live); the page test attaches
  // cameras/groups to the api object itself (pinned format of the plan) — both paths hold.
  cameras?: Cam[];
  groups?: Group[];
  // Catalog for the layout drop from the tree (spec 2026-10-18 videowall-parity, D2).
  layouts?: LayoutToOpen[];
  openRequest?: OpenRequest;
  onRequestConsumed?: () => void;
  // Saving a layout in Recording has to refresh the App tree (same prop as LiveView;
  // spec videowall-recording-tabs, section 6.5).
  onLayoutsChanged?: () => void;
  // defect 2026-10-25: the App that owns the right panel must learn a new export was created
  onExportsChanged?: () => void;
  // correction 2026-10-26: the cell menu needs the same two actions as the sidebar (App owns the dialog
  // and the settings modal, this page only forwards them).
  onConfig?: (cameraId: string, name: string) => void;
  onRename?: (cameraId: string, name: string) => void;
  // spec 2026-10-27 (hide-actions-without-permission, Task 4.5): the export button belongs to
  // camera.manage (POST /archive/export demands it on the server). Default true keeps every
  // existing caller (tests included) on the old behavior; the App passes can('camera.manage').
  canExport?: boolean;
  // phase 4.3 (Tarefa 4.3): forwarded to the playback cell menu (rename = camera.manage).
  canManageCameras?: boolean;
};

// D5 (amendment E6): snapshot per module, read on mount and written on every render (the effect
// without deps below). It cannot become localStorage: the key would survive the App logout —
// EXCEPT the sheet (spec 2026-10-27 sheet-expandido-default): that one IS a preference, lives in
// its own key `openvms.sheet` and survives the logout, exactly like `openvms.panels` (usePaineis).
// spec 2026-10-27 (shared videowall): tabs/activeKey live in the SHARED registry now; the page keeps
// only what is Archive's own (day, playhead, speed). The generation guard moved with them
// (stageSnapshotGeneration): a logout clear must still beat the last render of a dying instance.
const SHEET_KEY = 'openvms.sheet';
// any value that is not the string "false" (missing, corrupt, blocked storage) reads as OPEN:
// the default of the operator who never touched the strip is the expanded sheet.
const readSheetOpen = (): boolean => { try { return localStorage.getItem(SHEET_KEY) !== 'false'; } catch { return true; } };
let archiveSnapshot: { from: number; playhead: number | null; speed: number } | null = null;
export function clearArchiveSnapshot(): void { archiveSnapshot = null; clearStageTabsSnapshot(); }

export default function ArchiveView({ api, apiFor, cameras: camerasProp, groups: groupsProp, layouts = [], openRequest = null, onRequestConsumed = () => {}, onLayoutsChanged, onExportsChanged, onConfig = () => {}, onRename = () => {}, canExport = true, canManageCameras }: Props) {
  const { t } = useT();
  const cameras = camerasProp ?? (api as unknown as { cameras?: Cam[] }).cameras ?? [];
  const groups = groupsProp ?? (api as unknown as { groups?: Group[] }).groups;
  const noToken = !api.token;
  // generation of this instance (see clearArchiveSnapshot): mounts on the current epoch
  const generation = useRef(stageSnapshotGeneration()).current;

  // The tabs are the shared hook of both modes (spec videowall-recording-tabs, section 6.5): same
  // actions, same dirty, same save. The initial state comes from the module snapshot, if any.
  const dialog = usePromptDialog();
  const { tabs, active, activeKey, setActiveKey, patchTab, openLayout, closeTab, handleRequest,
    error: tabError, menu, openMenu, closeMenu, menuItems, handleMenu } =
    useLayoutTabs({ api, onLayoutsChanged, dlg: dialog, initial: getStageTabsSnapshot() });
  const [day, setDay] = useState(() => archiveSnapshot?.from || MIDNIGHT(Date.now()));
  const [sheetOpen, setSheetOpen] = useState(readSheetOpen);   // spec 2026-10-27: the choice survives reload/logout
  // spec 2026-10-19 (video-export): the modal state lives in the page; the sheet only notifies (dumb).
  const [exportOpen, setExportOpen] = useState(false);
  // spec 2026-10-18-cell-size-1s-wait: the selection cycle is the SAME hook as Live (immediate
  // border; size 1 s after the last click; fullscreen drives the size). No selection snapshot: the
  // Archive snapshot does not save the selection today and stays that way.
  const { selection, clickCell, clearSelection } = useCellSelection();

  // ─── fullscreen of the CONTAINER (spec 2026-10-19 selection-sheet-floating-fullscreen, S2/S3/S4) ──
  // The ownership lives HERE (S3): the cell DOM is recreated on every 120 s window (key in
  // renderCell) and cannot hold the state. `requestFullscreen` requires transient activation, so it
  // is called in the gesture (never inside an effect) and the state is only committed in the
  // `.then` (with no real fullscreen, `.catch` clears it: "invisible fullscreen" cannot exist).
  const rootRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState<string | null>(null);

  function onFullscreen(id: string) {
    if (fullscreen === id) { setFullscreen(null); return; }
    rootRef.current?.requestFullscreen?.().then(() => setFullscreen(id)).catch(() => setFullscreen(null));
  }

  // exit by state (⛶ again, ✕, S4): fullscreen ended but the browser is still in the container
  useEffect(() => {
    if (fullscreen === null && document.fullscreenElement && document.fullscreenElement === rootRef.current) {
      document.exitFullscreen().catch(() => {});
    }
  }, [fullscreen]);

  // native ESC / browser gesture: fullscreenElement is gone -> the state follows (class off)
  useEffect(() => {
    const h = () => { if (!document.fullscreenElement) setFullscreen(null); };
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);

  // S4: the cell in fullscreen left the active tab (✕) -> leave fullscreen
  useEffect(() => {
    if (fullscreen !== null && !active.cells.some((c) => c.id === fullscreen)) setFullscreen(null);
  }, [fullscreen, active.cells]);

  // spec 2026-10-19 (D5): `selection.id` is a CELL id; resolve the camera to border the track in the sheet
  const selectedCamera = active.cells.find((c) => c.id === selection.id)?.content?.camera_id ?? null;
  const [error, setError] = useState<string | null>(null);
  const coverageRef = useRef<Record<string, Segment[]>>({});
  const [coverage, setCoverage] = useState<Record<string, Segment[]>>({});

  const cellCameras = useMemo(() => {
    const seen = new Set<string>(); const out: string[] = [];
    active.cells.forEach((c) => { const id = c.content?.camera_id; if (id && !seen.has(id)) { seen.add(id); out.push(id); } });
    return out;
  }, [active.cells]);
  const cellCamerasKey = cellCameras.join(',');
  // spec 2026-10-20 (timeline-unica-tela-cheia): in fullscreen, the dumb sheet receives only the camera
  // of the expanded cell. The clock and the coverage stay with the whole wall (spec "O que não muda").
  const fsCameraId = fullscreen ? active.cells.find((c) => c.id === fullscreen)?.content?.camera_id ?? null : null;
  const sheetCameraIds = fsCameraId && cellCameras.includes(fsCameraId) ? [fsCameraId] : cellCameras;
  // spec 2026-10-19 (video-export, section 5): the dropdown lists the stage cameras with a recording
  // profile (pid = recording_profile_id with fallback); the default is the profile of the stage camera.
  const exportCameras = useMemo(() => cellCameras
    .map((id) => { const c = cameras.find((x) => x.id === id); const pr = c && pid(c); return pr ? { profileId: pr, name: c!.name } : null; })
    .filter((x): x is { profileId: string; name: string } => !!x), [cellCameras.join(','), cameras]);
  const selectedProfile = useMemo(() => {
    const c = cameras.find((x) => x.id === selectedCamera);
    return (c && pid(c)) || null;
  }, [selectedCamera, cameras]);
  // `day` is already an epoch midnight; MIDNIGHT only protects an old snapshot written on the hour
  const midnight = MIDNIGHT(day * 1000);
  // spec 2026-10-20 (D4/D5): the viewed day is the current day. Coverage can grow
  const isToday = midnight === MIDNIGHT(Date.now());

  // ─── the global clock (C6): owner of the instant; the players only follow it; speed from the snapshot ─
  const handles = useRef(new Map<string, PlayerHandle>());
  const handleCallbacks = useRef(new Map<string, (h: PlayerHandle | null) => void>());
  const barrier = useRef(performance.now());
  // One sample snapshot per tick, shared by the barrier and the recovery decision: a second read
  // could observe a different buffered state inside the same tick (and doubles the ref work).
  const collectSamples = useCallback((epoch: number) => active.cells.flatMap(cell => {
    const camera = cell.content?.camera_id;
    if (!camera || !(coverageRef.current[camera] ?? []).some(s => s.start_ts <= epoch && epoch < s.end_ts)) return [];
    const h = handles.current.get(cell.id);
    return [h?.sample?.() ?? { epoch, ready: false, presentedAt: 0 }];
  }), [active.cells]);
  const canAdvance = useCallback((epoch: number) =>
    wallReady(collectSamples(epoch), performance.now() - barrier.current), [collectSamples]);
  const clock = useGlobalClock({ midnight, cameras: cellCameras, coverage: coverageRef.current,
    mayGrow: isToday, canAdvance,
    initialInstant: archiveSnapshot?.playhead ?? null, initialSpeed: archiveSnapshot?.speed });

  // ─── shortcuts (E2 of the plan): only space and ←/→, over the clock; a text field commands ───────
  const { toggle } = clock;
  const handleKey = useCallback((e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (e.code === 'Space') { e.preventDefault(); toggle(); }
    else if (e.code === 'ArrowLeft') { e.preventDefault(); clock.seek(clock.instant - 5); }
    else if (e.code === 'ArrowRight') { e.preventDefault(); clock.seek(clock.instant + 5); }
  }, [toggle, clock]);
  useEffect(() => { window.addEventListener('keydown', handleKey); return () => window.removeEventListener('keydown', handleKey); }, [handleKey]);

  // ─── handles: each cell registers ITS player; unmount mid-play re-synchronizes ───
  const mirrors = useRef({ clock, day, sheetOpen, collectSamples });
  mirrors.current = { clock, day, sheetOpen, collectSamples };
  const handleFor = useCallback((id: string) => {
    if (!handleCallbacks.current.has(id)) handleCallbacks.current.set(id, h => {
      if (h) handles.current.set(id, h); else handles.current.delete(id);
    });
    return handleCallbacks.current.get(id)!;
  }, []);

  useEffect(() => { barrier.current = performance.now(); }, [clock.seekRequest?.id, clock.playing, active.key]);
  // spec 2026-10-24 (continuous-hour-playback, 4.1): the coordinator runs the recovery decision even
  // with the barrier closed. All-stalled wall + a real buffered successor (short gap, skipGaps on) =
  // ONE global seek; the cooldown keeps the same recovery from being re-issued while it is pending,
  // and no evidence means the clock stays where it is (never fabricated progress).
  const recovery = useRef({ at: -Infinity });
  useEffect(() => {
    const timer = setInterval(() => {
      const c = mirrors.current.clock;
      if (!c.playing) return;
      const target = c.read?.() ?? c.instant;
      const samples = mirrors.current.collectSamples(target);
      const ready = wallReady(samples, performance.now() - barrier.current);
      if (!ready) {
        const next = recoveryTarget(samples, target, c.skipGaps);
        const now = performance.now();
        // ponytail: HARD_SEEK_COOLDOWN_MS is the existing 2 s seek cooldown of the players.
        if (next !== null && now - recovery.current.at >= HARD_SEEK_COOLDOWN_MS) {
          recovery.current.at = now;
          c.seek(next);
        }
      }
      for (const h of handles.current.values()) {
        h.play(ready);
        if (ready) h.sync?.(target, c.speed);
      }
    }, 250);
    return () => clearInterval(timer);
  }, []);

  // The global ▶ (Space/bar) only moved the virtual clock: the cell player only got play on the
  // remount of the next window (up to 2 min of "frozen snapshot", measured in the browser 19/10).
  useEffect(() => { for (const h of handles.current.values()) h.play(clock.playing); }, [clock.playing]);

  // ─── whole-day coverage (N+1 in parallel, same math as the extinct wall) ─────────────
  // The `requestCoverage` the plan pinned does not exist in faixas.ts: the block is the wall math
  // (old ArchiveView.tsx:148-158) moved into the page, over api.timeline+runs.
  async function fetchCoverage(): Promise<{ error?: string } | undefined> {
    const end = midnight + SECONDS_PER_DAY;
    try {
      const rs = await Promise.all(cellCameras.map(async (id) => {
        const c = cameras.find((x) => x.id === id);
        const p = c && pid(c);
        if (!p) return { id, segs: [] as Segment[] };
        const d = await (apiFor && c?.server_id ? apiFor(c.server_id) : api).timeline({ stream_profile_id: p, from: midnight, to: end, bucket_seconds: 60 });
        return { id, segs: runs(d.buckets, d.bucket_seconds, end) };
      }));
      const map: Record<string, Segment[]> = Object.fromEntries(rs.map((r) => [r.id, r.segs]));
      coverageRef.current = map; setCoverage(map);      // only writes on success: a failure does not overwrite anything
      // spec 2026-10-27 (ponteiro no drop, past day): the answer of the drop day resolves the pending
      // ids. Consume ALWAYS: a late answer (after a day/tab change cleared the ref) must never jump.
      // The clock goes through the mirror — this runs in a `.then` after re-renders (same reason as
      // `mirrors` below: the closure clock would be frozen at this render).
      const pend = pendingDropRef.current;
      if (pend.length) {
        pendingDropRef.current = [];
        const starts = pend.map((id) => (map[id] ?? [])[0]?.start_ts).filter((s): s is number => s != null);
        if (starts.length) mirrors.current.clock.seek(Math.min(...starts));
      }
    } catch (e) {
      return { error: `${t('archive.load_failed')} — ${errMessage(e)}` };
    }
  }
  useEffect(() => {
    if (!cameras.length || !cellCameras.length) return;
    let alive = true;
    fetchCoverage().then((r) => { if (alive && r?.error) setError(r.error); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellCamerasKey, cameras, midnight, api]);

  // ─── spec 2026-10-20 (D4): today, the coverage tail grows. It asks for the last 15 min every
  // ─── 30 s and merges it into the day (mergeTail keeps the head). A network error skips the tick.
  // ─── Nothing is erased and the next tick tries again. The interval stops on the day change
  // ─── (isToday) and ignores ticks while the tab is hidden.
  async function fetchCoverageTail(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const from = Math.max(midnight, now - 900);
    const to = Math.min(midnight + SECONDS_PER_DAY, now + 120);
    try {
      const rs = await Promise.all(cellCameras.map(async (id) => {
        const c = cameras.find((x) => x.id === id);
        const p = c && pid(c);
        if (!p) return { id, segs: [] as Segment[] };
        const d = await (apiFor && c?.server_id ? apiFor(c.server_id) : api).timeline({ stream_profile_id: p, from, to, bucket_seconds: 60 });
        return { id, segs: runs(d.buckets, d.bucket_seconds, to) };
      }));
      const prev = coverageRef.current;
      const map: Record<string, Segment[]> = Object.fromEntries(
        rs.map((r) => [r.id, mergeTail(prev[r.id] ?? [], r.segs)]));
      coverageRef.current = map; setCoverage(map);
    } catch { /* the previous map stays. The next tick tries again (spec: Casos de borda) */ }
  }
  useEffect(() => {
    if (!isToday || !cameras.length || !cellCameras.length) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void fetchCoverageTail();
    }, COVERAGE_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cellCamerasKey, cameras, midnight, api, isToday]);

  function changeDay(next: number) {
    if (next === day) return;
    pendingDropRef.current = [];   // spec 2026-10-27: the pending drop belonged to the old day
    setDay(next);
    clock.seek(Math.max(next, Math.min(next + SECONDS_PER_DAY - 1, clock.instant)));  // manual clamp (the clock only knows the midnight of the frame)
  }

  // spec 2026-10-27 (ponteiro no drop): today -> clock.now() right away (coverage-independent);
  // a past day -> wait for the dropped cameras' coverage, then seek to the oldest first start
  // (resolved in fetchCoverage). The handler runs in the drop event of the CURRENT render, so the
  // fresh `clock`/`isToday` closure is safe here — only the `.then` needs the mirror.
  const pendingDropRef = useRef<string[]>([]);
  function onCamerasDropped(ids: string[]) {
    if (isToday) { clock.now(); return; }
    pendingDropRef.current = [...pendingDropRef.current, ...ids]; // union: consecutive drops accumulate
  }
  // switching tabs also invalidates the pending drop (spec 2.2: it belongs to the (day, tab) pair)
  const selectTab = (k: string) => { pendingDropRef.current = []; setActiveKey(k); };

  // ─── open request (App): the handling belongs to the shared hook, same contract as live ───
  // {new} creates a tab; {cameras} enters the active tab with conditional dirty; a layout
  // opens/focuses the tab (spec videowall-recording-tabs, D1 — the D6 "replaces the stage" died).
  // Opening a layout does not carry the selection of the previous tab into the new one.
  useEffect(() => {
    if (!openRequest) return;
    if ('id' in openRequest) clearSelection();
    handleRequest(openRequest);
    onRequestConsumed();
  }, [openRequest]);

  // ─── LAYOUT drop from the panel opens/focuses the tab of the layout (spec recording-tabs, D1; revokes D6) ─
  // ─── camera/group stay in StagePalco: without the layout type in the payload, nothing is consumed ─
  const dropLayout = useLayoutDrop(layouts, (l) => {
    openLayout(l); // the saved geometry opens in its own tab, like in Live
    clearSelection();
  });

  // ponytail: the player asks for `token: string` and ApiClient has `string | null`. The object is
  // MEMOIZED because a new identity would make the player effect swap the playlist `src` on every
  // render of the page (PlayerGravacao.tsx:106 depends on the identity of `api`; the clock runs on
  // rAF). The `?? ''` only exists to satisfy the type: with a null token the URL comes out empty and
  // the banner above already warns.
  const playerApi = useMemo(() => ({ base: api.base, token: api.token ?? '' }), [api.base, api.token]);

  // Player api POR servidor (5.6): o cache guarda a identidade estável de cada par (servidor, token)
  // — a mesma razão do memo acima. Sem apiFor é exatamente `playerApi` (compat pinada).
  const playerApiCache = useRef(new Map<string, { base: string; token: string }>());
  const playerApiFor = useCallback((serverId?: string | null) => {
    if (!apiFor) return playerApi;
    const a = serverId ? apiFor(serverId) : api;
    const key = `${serverId ?? '__primary__'}|${a.token ?? ''}`;
    let p = playerApiCache.current.get(key);
    if (!p) { p = { base: a.base, token: a.token ?? '' }; playerApiCache.current.set(key, p); }
    return p;
  }, [api, apiFor, playerApi]);
  const focusedServer = cameras.find((c) => c.id === selectedCamera)?.server_id;

  // ─── snapshot (D5): every render updates it (unmount does NOT rewrite: clearArchiveSnapshot of
  // ─── the logout has to beat the last render, and the last render already wrote the last photo) ─
  useEffect(() => {
    if (generation !== stageSnapshotGeneration()) return;   // logout cleared after this mount: the old photo does not come back
    archiveSnapshot = { from: day, playhead: clock.instant, speed: clock.speed };
    setStageTabsSnapshot({ tabs, activeKey });              // the videowall identity is SHARED with Live (spec 2026-10-27)
  });
  useEffect(() => () => { handles.current.clear(); }, []);

  return (
    <div className="arquivo-stage" ref={rootRef} onDropCapture={dropLayout}>
      {noToken && <div className="banner">{t('archive.no_token')}</div>}
      {error && <div className="banner">{error}</div>}
      <StageTabs tabs={tabs} activeKey={activeKey} onSwitch={selectTab} onClose={closeTab}
        error={tabError} onOpenMenu={openMenu} />
      <StagePalco
        cameras={cameras} groups={groups} cells={active.cells} kind="live"
        onChange={(cs) => patchTab(active.key, { cells: cs, dirty: true })}
        onCamerasDropped={onCamerasDropped}
        selected={selection.id} maximized={selection.expanded}
        onSelect={clickCell}
        onClearSelection={clearSelection}
        renderCell={(cell) => {
          const camId = cell.content?.camera_id;
          const cam = camId ? cameras.find((c) => c.id === camId) : undefined;
          return (
            <PlaybackCell key={`${active.key}:${cell.id}:${camId || ''}:${cam ? pid(cam) : ''}`} cam={cam}
              covered={!cam || clock.covered(cam.id, clock.instant)}
              instant={clock.instant}
              seekRequest={clock.seekRequest}
              hole={clock.hole}
              atEdge={clock.atEdge}
              autoPlay={clock.playing}
              speed={clock.speed}
              api={playerApiFor(cam?.server_id)}
              handleRef={handleFor(cell.id)}
              fullscreen={fullscreen === cell.id}
              onFullscreen={() => onFullscreen(cell.id)}
              onRemove={() => patchTab(active.key, { cells: remove(active.cells, cell.id), dirty: true })}
              onConfig={onConfig}
              onRename={onRename}
              canManageCameras={canManageCameras} />
          );
        }}
      />
      <BottomSheet
        clock={clock} open={sheetOpen} onToggleOpen={() => setSheetOpen((a) => {
          const next = !a;
    try { localStorage.setItem(SHEET_KEY, String(next)); } catch { /* storage full/blocked: only this session */ }
          return next;
        })}
        day={day} onDay={changeDay}
        cameras={sheetCameraIds.map((id) => ({ id, name: cameras.find((c) => c.id === id)?.name || id }))}
        coverage={coverage}
        selected={selectedCamera}
        onExport={canExport ? () => setExportOpen(true) : undefined}
      />
      <ExportDialog open={exportOpen} onOpenChange={setExportOpen}
        api={apiFor && focusedServer ? apiFor(focusedServer) : api}
        cameras={exportCameras} defaultProfile={selectedProfile} day={day} onCreated={onExportsChanged} />
      {menu && <CameraMenu x={menu.x} y={menu.y} items={menuItems} onPick={handleMenu} onClose={closeMenu} />}
      <PromptDialog request={dialog.request} onClosed={() => dialog.setRequest(null)} />
    </div>
  );
}

