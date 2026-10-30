import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ApiClient } from '@/shared/utils/api';
import LoginPage from '@/features/auth/pages/LoginPage';
import ForcedPasswordChange from '@/features/auth/components/TrocaSenhaObrigatoria';
import OnboardingWizard from '@/features/auth/components/WizardOnboarding';
import AdminModal from '@/features/admin/pages/AdminModal';
import DesignCatalog from '@/features/design/CatalogoDesign';
import LiveView, { clearLiveViewSnapshot } from '@/features/live/pages/LiveView';
import LayoutTree from '@/features/layouts/components/LayoutTree';
import ArchiveView, { clearArchiveSnapshot } from '@/features/archive/pages/ArchiveView';
import AddDeviceWizard from '@/features/cameras/pages/AddDeviceWizard';
import CameraSettingsModal from '@/features/cameras/pages/CameraSettingsModal';
import CameraTree, { type Marked } from '@/features/cameras/components/CameraTree';
import CameraMenu, { type ItemMenu } from '@/shared/ui/CameraMenu';
import UserMenu from '@/shared/ui/UserMenu';
import { directCameras } from '@/shared/domain/groups';
import { makeCan, type Capability } from '@/shared/domain/capabilities';
import { urlReStreaming } from '@/features/cameras/services/reStreaming';
import { useCameras, cameraMenuItems, serverMenuItems } from '@/shared/hooks/useCameras';
import { useServers } from '@/shared/hooks/useServers';
import AddServerModal from '@/features/servers/components/AddServerModal';
import type { DropPayload } from '@/shared/hooks/useCameras';
import { useLayouts, layoutMenuItems } from '@/features/layouts/hooks/useLayouts';
import { usePanels, clampWidth, maxWidth, MIN_WIDTH, DEFAULT_WIDTH, type Side } from '@/shared/hooks/usePaineis';
import PanelToggle from '@/shared/ui/PainelAlternancia';
import SearchField from '@/shared/ui/SearchField';
import { usePromptDialog, PromptDialog } from '@/shared/components/PromptDialog';
import { useToasts, Toasts } from '@/shared/components/Toast';
import PanelPtz from '@/features/live/components/PainelPtz';
import ExportsPanel from '@/features/archive/components/PainelExports';
import { usePtz } from '@/features/live/hooks/usePtz';
import { useT, type Language } from '@/shared/i18n';

const SERVER_KEY = 'openvms.server';
const TOKEN_KEY = 'openvms.token';
type Mode = 'live' | 'archive';
// ponytail: the annotated tuple keeps the literal — the map id is already a Mode and the label is a dictionary key
const MODES: [Mode, 'app.mode.live' | 'app.mode.archive'][] = [['live', 'app.mode.live'], ['archive', 'app.mode.archive']];
// Session in memory: the HTTP client + the identity read from the SERVER (`me`/login). There is no role:
// what the App uses is `profile_id` (spec §10) and the must-change flag (§7.1.4).
// spec 2026-10-19 (onboarding): `firstRun` comes from the server (login/me). `loginPassword` is the
// password TYPED at login — pure memory, never sessionStorage (D1/§8.3). F5 discards it; reloading in
// the middle of the wizard falls back to the classic flow (asks for the current one), a known fix for
// the cost in §8.2/§8.3.
type Session = { api: ApiClient; user: string; profile: string; capabilities: Capability[]; mustChangePassword: boolean; firstRun: boolean; loginPassword: string };
// Target of the double click in the camera/folder/DVR tree (spec 2026-10-17, 1.3a).
type Target = { kind: 'camera' | 'group' | 'device'; id: string };
// Actions that climb from the trees to the menu (same shape as CameraTree's and LayoutTree's onAction).
type CameraAction = { type: 'menu' | 'menu-toggle'; kind: 'camera' | 'group' | 'device' | 'server'; id: string; x: number; y: number; name: string };
type LayoutAction = { type: 'menu'; kind: 'layout'; id: string; name?: string; x: number; y: number };
// Stored menu: id/name are string (the null sentinel of the root went away with the root menu).
type Menu = { type: 'menu' | 'menu-toggle'; kind: 'camera' | 'group' | 'device' | 'layout' | 'server'; id: string; name: string; x: number; y: number };

export default function App() {
  const { t, tn, lang, setLang } = useT();
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<Mode>('live');
  const [selected, setSelected] = useState<string | null>(null);
  const [marked, setMarked] = useState<Marked[]>([]); // multiple selection: {kind: 'camera'|'group'|'layout', id} pairs
  const [wizard, setWizard] = useState<string | null>(null); // base do servidor do wizard de câmera (D6)
  const [connectOpen, setConnectOpen] = useState(false);      // AddServerModal
  const [menu, setMenu] = useState<Menu | null>(null);   // {kind, id, x, y, name}
  // side panels: state + persistence (the hook reads/writes openvms.panels). `widths` is the EXPLICIT
  // width from the drag (spec 2026-10-17, 1.2): absent = the CSS default.
  const { collapsed, widths, toggle, setWidth } = usePanels();
  // The drag writes the width DIRECTLY into this element's style (never setState per pointermove:
  // one re-render per event would re-render the <video> — lesson from wave 4A.2).
  const shellRef = useRef<HTMLDivElement>(null);
  const [config, setConfig] = useState<{ id: string; name: string } | null>(null); // {id, name} of the settings modal
  // spec §12-F4/A1 (phase 4): the administration modal only opens for who holds users/profiles/retention
  // management (can() from login/me). State here, not in the modal, because the button lives in the topbar.
  const [admin, setAdmin] = useState(false);
  // user icon dropdown (spec 2026-10-18): state in the App, like `admin` above.
  const [userMenu, setUserMenu] = useState(false);
  const [filter, setFilter] = useState('');
  // spec 2026-10-18 (header "Cameras" filters): the 📁 sends a SIGNAL to both trees (n grows on every
  // click; open toggles: 1st click opens everything, 2nd closes everything). The dot cycles the camera
  // section: null (all) -> 'with' recording -> 'without' recording -> null.
  const [folderSignal, setFolderSignal] = useState({ open: false, n: 0 });
  const [recordingFilter, setRecordingFilter] = useState<'with' | 'without' | null>(null);
  // spec 2026-10-17: new export notice. The list lives in the right panel and this counter is what tells
  // it to refetch when the Archive page export flow finishes (no polling in the panel).
  const [exportTick, setExportTick] = useState(0);
  // defect 2026-10-25: the tick existed and never went up; the right panel only saw a new export on F5.
  const onExportsChanged = useCallback(() => setExportTick((n) => n + 1), []);
  const dlg = usePromptDialog();
  // spec 2026-10-18 (4.5): the app's ephemeral notices are toasts; the inline error action is gone.
  const { notices, notify } = useToasts();

  // The catalog/health poll (5s), the layouts one (5s) and the events one (3s) live in the hooks.
  const cli = session ? session.api : null;
  // phase 4: the global gates read the EFFECTIVE capabilities from the server (login/me) — the old
  // CAN_INSTALL profile list is gone. makeCan builds one Set per render; an 8-item Set does not
  // deserve a memo (the lookups themselves are O(1)).
  const can: (cap: Capability) => boolean = session ? makeCan(session.capabilities) : () => false;
  // Registry (spec 5.1): o primário é o api da sessão; o boot-restore dos extras mora no hook e só
  // roda com sessão (sem primário não se monta extra — 5.1). reset = logout limpa extras e tokens.
  const { servers, addServer, disconnectServer, renameServer, reset: resetServers, apiFor } =
    useServers(session ? session.api : null);
  const { cameras, devices, groups, rtsp, rtspByServer, connection, connections, refresh: refreshCameras, reset: resetCameras, move } =
    useCameras(servers.length ? servers.map(({ id, api }) => ({ id, api })) : null);
  const { layouts, openRequest, openOnStage, consumeRequest, refreshLayouts, handleLayoutAction } = useLayouts(cli);

  // PTZ state belongs to the App (spec 2026-10-17): the right panel and the cell show the same panel,
  // and only one camera is armed at a time.
  // PTZ (5.6): cada comando resolve o servidor da câmera armada NO MOMENTO do comando — o App não
  // conhece a câmera armada antes do usePtz devolver, e o hook lê o api por ref de qualquer forma.
  // A facade é estável: a identidade nunca rearma o instrumento do hook.
  const apiForRef = useRef(apiFor); apiForRef.current = apiFor;
  const camerasRef = useRef(cameras); camerasRef.current = cameras;
  const sessionRef = useRef(session); sessionRef.current = session;
  const ptzApi = useMemo(() => {
    const of = (id: string) => apiForRef.current(camerasRef.current.find((c) => c.id === id)?.server_id)
      ?? sessionRef.current?.api ?? null;
    // rejection LAZY (deviation): created at memo time it would sit unhandled on every mount
    const noServer = () => Promise.reject(new Error('no server'));
    return {
      ptzMove: (id: string, v: never) => { const a = of(id); return a ? a.ptzMove(id, v) : noServer(); },
      ptzStop: (id: string) => { const a = of(id); return a ? a.ptzStop(id) : noServer(); },
      ptzCapability: (id: string, refresh?: boolean) => { const a = of(id); return a ? a.ptzCapability(id, refresh) : noServer(); },
      ptzPositions: (id: string) => { const a = of(id); return a ? a.ptzPositions(id) : noServer(); },
      ptzSavePosition: (id: string) => { const a = of(id); return a ? a.ptzSavePosition(id) : noServer(); },
      ptzGoToPosition: (id: string, position: number) => { const a = of(id); return a ? a.ptzGoToPosition(id, position) : noServer(); },
      ptzRenamePosition: (id: string, position: number, name: string) => { const a = of(id); return a ? a.ptzRenamePosition(id, position, name) : noServer(); },
      ptzDeletePosition: (id: string, position: number) => { const a = of(id); return a ? a.ptzDeletePosition(id, position) : noServer(); },
      ptzZoomArea: (id: string, box: never) => { const a = of(id); return a ? a.ptzZoomArea(id, box) : noServer(); },
      ptzUndoZoom: (id: string) => { const a = of(id); return a ? a.ptzUndoZoom(id) : noServer(); },
    };
  }, []);
  const ptz = usePtz(ptzApi);
  const ptzCamera = ptz.cameraId ? cameras.find((c) => c.id === ptz.cameraId) : null;

  // ---- panel drag handle (spec 2026-10-17, item 1.2) ----
  // Panel OPEN right now: the right one stays open with PTZ mode on, even with the saved preference
  // saying "closed" — it is the same condition that drops the `rec-dir` class from the shell.
  const isOpen = (side: Side) => (side === 'left' ? !collapsed.left : !collapsed.right || !!ptzCamera);
  // EFFECTIVE width: collapsed is the 32px strip from the CSS; without an explicit width, the CSS default.
  const currentWidth = (side: Side) => (isOpen(side) ? widths[side] ?? DEFAULT_WIDTH[side] : 32);
  // Both keys ALWAYS go into the style, even when empty: `style.setProperty('--col-esq', '')` REMOVES
  // the inline variable (CSSOM) and hands the decision back to the CSS. Without that the inline value
  // written by the drag would beat the `.shell.rec-*` class and the collapse button would stop working
  // after a gesture.
  const shellStyle = {
    '--col-esq': isOpen('left') && widths.left != null ? `${widths.left}px` : '',
    '--col-dir': isOpen('right') && widths.right != null ? `${widths.right}px` : '',
  } as CSSProperties;

  // halves of the old 5s refresh(): catalog on one side, layouts on the other
  const refresh = useCallback(async () => { await refreshCameras(); await refreshLayouts(); }, [refreshCameras, refreshLayouts]);

  // ponytail: token in sessionStorage survives the reload; the identity comes from the SERVER (`me`), not
  // from a localStorage cache — the user/role cache died with the `role` bridge (F4).
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    const server = localStorage.getItem(SERVER_KEY);
    if (!token || !server) return;
    const api = new ApiClient(server);
    api.token = token;
    api.me().then(
      (me) => setSession({ api, user: me.username, profile: me.profile_id || '', capabilities: me.capabilities as Capability[],
        mustChangePassword: me.must_change_password === true,
        firstRun: me.first_run === true, loginPassword: '' }),
      () => { sessionStorage.removeItem(TOKEN_KEY); },
    );
  }, []);

  const onLogin = useCallback((s: Session) => {
    setSession({ ...s });
  }, []);

  function logout() {
    if (!session) return;
    session.api.logout();
    sessionStorage.removeItem(TOKEN_KEY);
    resetServers(); // spec 5.4 + emenda: o logout derruba os extras (os aliases ficam — preferência)
    setSession(null);
    resetCameras();
    // spec 2026-10-17: the stage and Archive playback state live in the VIEW MODULES — logging out has
    // to clear both, otherwise whoever logs in next opens with the previous operator's state.
    clearLiveViewSnapshot();
    clearArchiveSnapshot();
  }

  // The stage cells (live and archive) and the sidebar rename through the SAME dialog and the same rule
  // per target kind (1.3f): the DVR renames through the device PATCH, the children follow on the server.
  async function applyRename(target: { kind: string; id: string; name: string }) {
    const name = await dlg.ask(t('cameras.rename_prompt'), t('shared.name'), target.name);
    if (!name || name === target.name) return;
    if (target.kind === 'camera') await session!.api.renameCamera(target.id, name);
    else if (target.kind === 'device') await session!.api.renameDevice(target.id, name);
    else await session!.api.updateGroup(target.id, { name });
  }

  // The cell menu renames ONE camera; the refresh is what `act` also does at the end of the sidebar path.
  async function renameFromStage(id: string, name: string) {
    if (!session) return;
    try { await applyRename({ kind: 'camera', id, name }); await refresh(); }
    catch (e) { notify(e instanceof Error ? e.message : t('app.action_failed'), 'error'); }
  }

  // fixup task 5.2: the cell menu's 'toggle-active' takes the SAME path as `act`'s branch — one PATCH
  // {ativa} with the tolerant catalog read (only `ativa === false` is inactive) + the same refresh.
  async function toggleActiveFromStage(id: string) {
    if (!session) return;
    try {
      await session.api.setCameraOptions(id, { ativa: cameras.find((c) => c.id === id)?.ativa === false });
      await refresh();
    } catch (e) { notify(e instanceof Error ? e.message : t('app.action_failed'), 'error'); }
  }

  // Servidor do alvo do menu (5.6): a lookup espelha groupOf — câmera/DVR/pasta pela lista mescla.
  function serverIdOf(a: Menu): string | undefined {
    if (a.kind === 'camera') return cameras.find((c) => c.id === a.id)?.server_id;
    if (a.kind === 'device') return devices.find((d) => d.id === a.id)?.server_id;
    if (a.kind === 'group') return groups.find((g) => g.id === a.id)?.server_id;
    return undefined;
  }

  // Menu do nó servidor (5.4). Primário OU último conectado: desconectar é logout (requisito 3 + D5).
  async function serverAction(id: string, target: Menu) {
    if (id === 'rename-server') {
      const name = await dlg.ask(t('cameras.rename_prompt'), t('shared.name'), target.name);
      if (name && name !== target.name) renameServer(target.id, name); // alias local — nunca no backend
    } else if (id === 'disconnect-server') {
      const entry = servers.find((s) => s.id === target.id);
      const go = await dlg.confirm(t('servers.disconnect'),
        [entry?.primary ? t('servers.disconnect_primary_confirm') : t('servers.disconnect_confirm', { name: target.name })],
        { danger: true });
      if (!go) return; // sem confirmar, nada faz (5.4)
      if (entry?.primary || servers.length === 1) logout();
      else disconnectServer(target.id); // remove entrada, token e alias; as células caem em slot-empty s/ código novo
    } else if (id === 'add-camera') {
      setWizard(target.id); // D6: o wizard abre COM o api deste servidor
    }
  }

  // the menu closes BEFORE the dialog opens — nothing stays stuck behind the modal.
  async function act(id: string) {
    const target = menu;
    setMenu(null);
    if (!target || !session) return;
    if (target.kind === 'server') { await serverAction(id, target); return; } // o api próprio não se PATCH-a
    // 5.6: PATCH/DELETE de câmera/pasta/DVR vão ao SERVIDOR do alvo (fallback no primário)
    const api = apiFor(serverIdOf(target));
    // it is only a batch when the menu was opened on an item OF the selection and there is more than one
    const selection = marked.length > 1 && marked.some((m) => m.kind === target.kind && m.id === target.id) ? marked : null;
    try {
      if (await handleLayoutAction(id, target, marked, setMarked, dlg)) return; // layout id: the action already reloaded the layouts
      if (id === 'rename') {
        await applyRename({ kind: target.kind, id: target.id, name: target.name });
      } else if (id === 'create-group') {
        const name = await dlg.ask(t('cameras.group_name_prompt'), t('shared.name'), t('cameras.new_folder'));
        if (!name) return;
        // 1.3c/1.3e: the DESTINATION of the new folder depends on where the target is. At the root, a
        // folder at the root; inside a folder, a subfolder OF IT (sibling of the target). The folder rule
        // (which creates inside itself) still holds when the menu was opened on a folder.
        const parent = target.kind === 'group' && !selection ? target.id : groupOf(target);
        const g = await api.createGroup({ name, parent_id: parent });
        // ponytail: creating a group FROM THE SELECTION puts cameras inside it; selected folders have no
        // batch move API and stay where they are
        // 1.3c: the DVR does not enter the new folder — neither it nor its children: the order only
        // creates the folder
        const cams = target.kind === 'device' ? [] : selection ? selection.filter((x) => x.kind === 'camera').map((x) => x.id) : target.kind === 'camera' ? [target.id] : [];
        for (const cid of cams) await api.moveCamera(cid, g.id);
        if (cams.length) setMarked([]);
      } else if (id === 'delete' && target.kind === 'device') {
        // 1.3g: deleting the DVR takes its N children. The confirmation says HOW MANY cameras come along
        // (the operator's decision) and the cascade belongs to the SERVER, through the same camera
        // deletion path.
        const children = cameras.filter((c) => c.device_id === target.id);
        const go = await dlg.confirm(t('shared.confirm_delete'),
          [t('cameras.delete_recorder_question', { name: target.name, n: children.length })],
          { danger: true, text: t('shared.delete') });
        if (go) await api.deleteDevice(target.id);
      } else if (id === 'delete') {
        const cams = selection ? selection.filter((x) => x.kind === 'camera').map((x) => x.id) : target.kind === 'camera' ? [target.id] : [];
        const folders = selection ? selection.filter((x) => x.kind === 'group').map((x) => x.id) : target.kind === 'group' ? [target.id] : [];
        const total = cams.length + folders.length;
        let question;
        if (total > 1) {
          const parts: string[] = [];
          if (cams.length) parts.push(`${cams.length} ${t('shared.cameras')}`);
          if (folders.length) parts.push(`${folders.length} ${t('shared.folders')}`);
          question = t('cameras.delete_selection_question', { n: total, items: parts.join(', ') });
        } else if (cams.length) {
          question = t('cameras.delete_camera_question', { name: target.name });
        } else {
          question = t('cameras.delete_folder_question', { name: target.name });
        }
        const go = await dlg.confirm(t('shared.confirm_delete'), [question], { danger: true, text: t('shared.delete') });
        if (!go) return;
        let failed = 0;
        for (const cid of cams) { try { await api.deleteCamera(cid); } catch { failed += 1; } }
        for (const gid of folders) { try { await api.deleteGroup(gid); } catch { failed += 1; } }
        if (failed) notify(t('app.delete_partial', { total, ok: total - failed, failed }), 'error');
        setMarked((ms) => ms.filter((m) => !cams.includes(m.id) && !folders.includes(m.id)));
        if (selected && cams.includes(selected)) setSelected(null);
      } else if (id === 'toggle-active' || id === 'activate-all' || id === 'deactivate-all') {
        // plan 2026-10-27 (camera ativa, 5.1): ONE PATCH {ativa} PER camera — the batch uses the same
        // sequential loop as the move/create-group above. The toggle reads the catalog tolerantly:
        // only `ativa === false` is inactive, so absent/true flips to false.
        const cams = selection ? selection.filter((x) => x.kind === 'camera').map((x) => x.id)
          : target.kind === 'camera' ? [target.id] : [];
        const ativa = id === 'activate-all' ? true : id === 'deactivate-all' ? false
          : cameras.find((c) => c.id === target.id)?.ativa === false;
        for (const cid of cams) await api.setCameraOptions(cid, { ativa });
      } else if (id === 'settings') {
        setConfig({ id: target.id, name: target.name });
        return;
      }
      await refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : t('app.action_failed'), 'error');
    }
  }

  // drop on the sidebar: camera(s) -> folder; folder -> folder (refuses a cycle).
  async function onDrop(d: DropPayload) {
    const error = await move(d);
    if (error) { notify(error, 'error'); return; }
    if (d.cameraIds.length) setMarked([]);
  }

  function openMenu(ev: CameraAction | LayoutAction) { // ev comes from CameraTree/LayoutTree
    // the layouts root sends id null: it becomes '' (sentinel) so the stored menu has a string id
    if (ev.type === 'menu') return setMenu({ ...ev, id: ev.id ?? '', name: ev.name ?? '' });
    // clicking the "..." toggles: the same open target closes
    setMenu((m) => (m && m.kind === ev.kind && m.id === ev.id ? null : ev));
  }

  // ---- 1.2: the handle gesture ----
  // The drag writes the width DIRECTLY into the shell style (no setState per pointermove) and only the
  // END of the gesture becomes state — which is what persists and what counts as an explicit width.
  function startDrag(e: ReactPointerEvent, side: Side) {
    if (e.button !== 0) return;
    const shell = shellRef.current;
    if (!shell) return;
    e.preventDefault();
    const column = side === 'left' ? '--col-esq' : '--col-dir';
    // The handle lives in the grid's OWN 2px track, plus 1px of gap on each side (spec 2026-10-18, 4.2):
    // the panel's inner border is no longer the pointer point — the track center sits 2px away from it
    // (1px gap + 1px of the 2px half-track; `divisor.test.ts` ties this value to the track and the gap of
    // `.shell`). Without the compensation the first pointermove would add 2px at once and the finger
    // would leave the handle it grabbed.
    const HANDLE_COMPENSATION = 2;
    // the panel width: on the left side it grows to the right, on the right side to the left
    // (the shell box's `right` is the reference)
    const measure = (clientX: number) => {
      const box = shell.getBoundingClientRect();
      const border = side === 'left' ? clientX - box.left : box.right - clientX;
      return clampWidth(border - HANDLE_COMPENSATION, window.innerWidth);
    };
    let width = currentWidth(side);
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      moved = true;
      width = measure(ev.clientX);
      shell.style.setProperty(column, `${width}px`);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
      // a click without a drag stores nothing: only a real gesture becomes an explicit width
      if (moved) setWidth(side, width);
    };
    // during the gesture: no text selection in the panel and a resize cursor on the whole page
    // (otherwise the panel text gets selected while the pointer moves)
    document.body.style.setProperty('cursor', 'col-resize');
    document.body.style.setProperty('user-select', 'none');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  // Handle accessibility (CHOICE aligned with M3): arrows in 8px steps, in the direction of the side.
  function adjust(side: Side, e: ReactKeyboardEvent) {
    const grow = side === 'left' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = side === 'left' ? 'ArrowLeft' : 'ArrowRight';
    if (e.key !== grow && e.key !== shrink) return;
    e.preventDefault();
    // collapsed, the arrow EXPANDS with the minimum clamp (32px is not a useful floor to add 8 to)
    setWidth(side, clampWidth(currentWidth(side) + (e.key === grow ? 8 : -8), window.innerWidth));
  }

  // The divider handle: one drawing for both sides (the CSS picks the grid area by class). It is a SIBLING
  // of the panels and lives in the 2px track between the panel and the scene (spec 2026-10-18) — that is
  // why the App only has to mount it and say which side.
  const handle = (side: Side) => (
    <div
      className={`alca-painel alca-${side === 'left' ? 'esq' : 'dir'}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Panel width (${side})`}
      aria-valuenow={currentWidth(side)}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth(window.innerWidth)}
      tabIndex={0}
      onPointerDown={(e) => startDrag(e, side)}
      onDoubleClick={() => setWidth(side, null)}
      onKeyDown={(e) => adjust(side, e)}
    />
  );

  // double click in the tree (camera, folder or DVR) opens on the wall through the SAME channel as a
  // layout. The folder expands through the same function as the drop (tree order, no duplication); the
  // DVR takes its CHILDREN (the cameras with its `device_id`) — the stage semantics do not change (1.3a).
  function openOnWall(node: Target) {
    const ids = node.kind === 'camera' ? [node.id]
      : node.kind === 'device' ? cameras.filter((c) => c.device_id === node.id).map((c) => c.id)
      : directCameras(cameras, node.id); // spec 2026-10-27: level-direct only
    if (!ids.length) return;
    openOnStage({ cameras: ids });
  }

  // The group WHERE the target lived when the menu opened (null = root). It is what decides the
  // destination of the new folder and the "Create group" x "Create subgroup" label (spec 2026-10-17,
  // 1.3c/1.3e). A folder returns null: its destination is itself, with the usual rule.
  function groupOf(a: Menu): string | null {
    if (a.kind === 'camera') return cameras.find((c) => c.id === a.id)?.group_id ?? null;
    if (a.kind === 'device') return devices.find((d) => d.id === a.id)?.group_id ?? null;
    return null;
  }

  // each tree builds ITS OWN menu (the App only picks by the kind of the opened item). The third argument
  // says whether the target is inside a folder — CameraTree does not choose the label, the menu does.
  // plan 2026-10-27 (5.1): the camera target carries `ativa` from the catalog (the menu label and the
  // toggle read it; the tolerant rule lives in cameraMenuItems — only false is inactive).
  const menuItems = (m: Menu): ItemMenu[] => (
    m.kind === 'layout' ? layoutMenuItems(m, marked, { t }, can)
      : m.kind === 'server' ? serverMenuItems(m, { t }, can)
      : cameraMenuItems({ ...m, ativa: cameras.find((c) => c.id === m.id)?.ativa }, marked, groupOf(m) != null, { t, tn }, can)
  );

  if (!session) return <LoginPage onLogin={onLogin} />;

  // §7.1.4 (F4): the pending password change does NOT let the system be used. The server blocks it too
  // (and that is the only way the temporary password has value) — here is the face of the same rule: no
  // shell, only the modal, until the password is changed or the user leaves.
  if (session.mustChangePassword) {
    // spec 2026-10-19 (onboarding D1/D2): first use = two-step wizard; any other pending change
    // (password reset, another user, or F5 in the middle of the wizard — without the password in
    // memory) follows the classic ForcedPasswordChange.
    if (session.firstRun && session.loginPassword) {
      return <OnboardingWizard api={session.api} loginPassword={session.loginPassword}
        onDone={(token: string) => {
          sessionStorage.setItem(TOKEN_KEY, token);
          // §5.4: clears the flag AND the password from memory; the shell mounts without a relogin.
          setSession((s) => (s ? { ...s, mustChangePassword: false, firstRun: false, loginPassword: '' } : s));
        }} />;
    }
    return (
      <ForcedPasswordChange api={session.api}
        onChanged={(token: string) => { sessionStorage.setItem(TOKEN_KEY, token); setSession((s) => (s ? { ...s, mustChangePassword: false } : s)); }}
        onExit={logout} />
    );
  }

  // Design system catalog (spec 2026-10-17, M4). The repository has NO router and one is not justified
  // for a screen that only opens by URL: the route is derived from the path, read at render. It sits
  // AFTER login (it is an authenticated session route) and does not enter the navigation menu — it is a
  // reference screen, not an operation one. `/design` does not exist on the server: the Vite SPA serves it.
  if (window.location.pathname === '/design') return <DesignCatalog />;

  const online = cameras.filter((c) => c.state === 'online').length;
  // O banner nomeia o PRIMEIRO servidor que falhou (5.5): a falha vem do poll, o rótulo do registry.
  const failing = connections.find((c) => !c.ok);
  const bannerMessage = failing
    ? `${servers.find((s) => s.id === failing.serverId)?.label ?? failing.serverId}: ${failing.message ?? t('shared.connection_failed')}`
    : connection.message;
  return (
    <div className={`shell${collapsed.left ? ' rec-esq' : ''}${collapsed.right && !ptzCamera ? ' rec-dir' : ''}`}
      style={shellStyle} ref={shellRef}>
      {/* A · top bar */}
      <header className="topbar">
        <span className="brand"><span className="dot" /> OpenVMS</span>
        <nav className="modes">
          {MODES.map(([id, label]) => (
            <button key={id} className={mode === id ? 'active' : ''} onClick={() => setMode(id)}>
              {t(label)}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {/* spec 2026-10-19: the language is chosen here, before anything else — the <select> is the
              FIRST child of the right corner, to the left of the user menu. */}
          <select className="lang-select" aria-label={t('topbar.language')}
            value={lang} onChange={(e) => setLang(e.target.value as Language)}>
            <option value="en">English</option>
            <option value="pt-BR">Português (Brasil)</option>
          </select>
          {/* spec 2026-10-18: URL, name/profile, Events, Administration and Log out left the topbar and
              live in the dropdown. The "Settings" gate is the capability `settings.manage` (phase 4:
              the effective capabilities come from login/me; the server checks again). */}
          <UserMenu open={userMenu} user={session.user} profile={session.profile}
            canConfigure={can('settings.manage')}
            onToggle={() => setUserMenu((v) => !v)}
            onConfig={() => { setUserMenu(false); setAdmin(true); }}
            onExit={logout} onClose={() => setUserMenu(false)} />
        </div>
      </header>

      {/* B · left sidebar */}
      <aside className="sidebar">
        <div className="sidebar-head">
          {/* spec 2026-10-17 (header search): the "Server" row + counts are gone; the search that already
              filtered both trees through this same state takes its place */}
          <SearchField value={filter} onChange={setFilter} />
          <PanelToggle side="left" collapsed={collapsed.left} onToggle={() => toggle('left')} />
        </div>
        {/* ponytail: ONE scroll region for both trees. The overflow leaves `.tree` (styles.css) and comes
            here — with two scroll owners the camera list was squeezed to 8px by the flex column
            (measured in the spec, section 1). */}
        <div className="sidebar-rolagem">
        <CameraTree
          groups={groups}
          cameras={cameras}
          selected={selected}
          // the selection is a single one: the same array carries 'layout' coming from LayoutTree
          marked={marked}
          onSelect={setSelected}
          onMark={setMarked}
          onAction={openMenu}
          onDrop={onDrop}
          onOpen={openOnWall}
          // spec 5.3: o App MESCLA o ok do poll no array que desce (useServers não conhece o poll)
          servers={servers.map((s) => ({ id: s.id, label: s.label, online: connections.find((c) => c.serverId === s.id)?.ok ?? false }))}
          onConnectServer={() => setConnectOpen(true)}
          filter={filter}
          devices={devices}
          folderSignal={folderSignal}
          onToggleFolders={() => setFolderSignal((p) => ({ open: !p.open, n: p.n + 1 }))}
          recordingFilter={recordingFilter}
          onCycleRecording={() => setRecordingFilter((f) => (f === null ? 'with' : f === 'with' ? 'without' : null))}
        />
        <LayoutTree
          layouts={layouts}
          cameras={cameras}
          marked={marked}
          onMark={setMarked}
          onAction={openMenu}
          onCreate={() => openOnStage({ new: true })}
          onOpen={openOnStage}
          onOpenCamera={(id) => openOnStage({ cameras: [id] })}
          filter={filter}
          folderSignal={folderSignal}
          recordingFilter={recordingFilter}
        />
        </div>
      </aside>

      {/* left panel divider (spec 2026-10-17, item 1.2): it occupies the 2px track between the panel and
          the scene (spec 2026-10-18), with the whole panel's scrollbar on the inside. */}
      {handle('left')}

      {/* C · main scene */}
      <main className="scene">
        {!connection.ok && <div className="banner">{bannerMessage}</div>}
        {mode === 'live' && (
          <LiveView api={session.api} apiFor={apiFor} cameras={cameras} groups={groups} ptz={ptz}
            layouts={layouts} openRequest={openRequest} onConsumeRequest={consumeRequest}
            onLayoutsChanged={refresh}
            onConfig={(id: string, name: string) => setConfig({ id, name })}
            onRename={renameFromStage} onToggleActive={toggleActiveFromStage} canManageCameras={can('camera.manage')} />
        )}
        {mode === 'archive' && (
          <ArchiveView api={session.api} apiFor={apiFor} cameras={cameras} groups={groups} layouts={layouts}
            openRequest={openRequest} onRequestConsumed={consumeRequest} onLayoutsChanged={refresh}
            onExportsChanged={onExportsChanged} canExport={can('camera.manage')}
            onConfig={(id: string, name: string) => setConfig({ id, name })}
            onRename={renameFromStage} canManageCameras={can('camera.manage')} />
        )}
      </main>

      {/* D · right panel */}
      <aside className={`rightpanel${ptzCamera ? ' ptz' : ''}`}>
        {/* ponytail: with PTZ mode on the header shows the armed camera and the collapse button leaves —
            the panel has to stay open (spec 2026-10-17, decision 4.3). The saved preference does not change. */}
        <div className="rightpanel-head">
          {ptzCamera
            ? <span className="rightpanel-titulo">{ptzCamera.name}</span>
            : <PanelToggle side="right" collapsed={collapsed.right} onToggle={() => toggle('right')} />}
        </div>
        {/* spec 2026-10-17: the export list lives in the panel body, not on the Archive stage. DIRECT
            child of the panel — the collapse (`.shell.rec-dir .rightpanel > *:not(.rightpanel-head)`)
            hides every child that is not the header, and a wrapper in between would break that. Only on
            the Archive tab, and BEFORE the body that already existed (the camera details do not change). */}
        {mode === 'archive' && can('camera.manage.global') && <ExportsPanel api={session.api} tick={exportTick} />}
        {ptzCamera
          ? <PanelPtz ptz={ptz} />
          : selected
            ? cameras.filter((c) => c.id === selected).map((c) => (
                <div key={c.id} className="panel">
                  <h2>{c.name}</h2>
                  <dl>
                    <dt>{t('cameras.settings.state')}</dt><dd>{c.state}</dd>
                    <dt>{t('cameras.discovery.added')}</dt><dd>{new Date(c.created_at ?? '').toLocaleString()}</dd>
                    <dt>{t('cameras.status.error')}</dt><dd>{c.error_code || '—'}</dd>
                  </dl>
                </div>
              ))
            : <p className="muted">{t('app.select_camera')}</p>}
      </aside>

      {/* right panel divider (spec 2026-10-17, item 1.2) */}
      {handle('right')}

      {/* E · footer (spec 2026-10-18): status, server URL (left the topbar) and cameras; the version and
          the UTC clock are gone. The URL is read straight from localStorage, as the topbar used to do. */}
      <footer className="statusbar">
        <span className={connection.ok ? 'ok' : 'warn'}>
          {connection.ok ? `● ${t('cameras.status.online')}` : `⚠ ${connection.message}`}
        </span>
        <span>{t('servers.count', { n: servers.length })} · {servers[0]?.label ?? localStorage.getItem(SERVER_KEY) ?? ''}</span>
        <span>{t('cameras.title')}: {online} / {cameras.length} {t('cameras.status.online')}</span>
      </footer>

      {wizard && (
        // ponytail: no onAdded — the dialog stays open showing what just came in; the sidebar updates on the 5s poll
        <AddDeviceWizard api={apiFor(wizard)} onClose={() => setWizard(null)} />
      )}
      {/* conecta servidor (spec 5.2): sem portão (D4); a lista de bases vivas fecha a duplicata */}
      {connectOpen && (
        <AddServerModal existingBases={servers.map((s) => s.id)} onSubmit={addServer} onClose={() => setConnectOpen(false)} />
      )}

      {config && (() => {
        // 5.6: as settings falam com o servidor da câmera e o re-streaming usa o hub RTSP DELE
        // (host = hostname da base; porta = o rtsp.port daquele servidor no poll de 5.5)
        const cam = cameras.find((c) => c.id === config.id);
        const srv = apiFor(cam?.server_id);
        const r = rtspByServer[srv.base] ?? rtsp;
        const hostOf = (base: string) => { try { return new URL(base).hostname; } catch { return base; } };
        return (
          <CameraSettingsModal api={srv} dlg={dlg} camera={config} onClose={() => setConfig(null)}
            // the Recording tab is editable by whoever administers cameras globally (measured: the POLICY of
            // PATCH /api/v1/cameras/:id is `camera.manage`, admin and operator);
            canEdit={can('camera.manage.global')}
            reStreaming={r && r.enabled
              ? urlReStreaming({ user: session.user, host: hostOf(srv.base), port: r.port, cameraId: config.id })
              : null} />
        );
      })()}

      {/* E8: the App's PromptDialog goes down as a prop (the administration's destructive confirmations)
          and sits in front of the modal backdrop — it is mounted LATER in the tree. */}
      {/* phase 4: it mounts only for who holds one of the three tab capabilities; AdminModal
          filters its own tabs with the props below (contract consumed in 4.5). */}
      {admin && (can('users.manage') || can('profiles.manage') || can('retention.manage')) && (
        <AdminModal api={session.api} dlg={dlg} notify={notify} onClose={() => setAdmin(false)}
          canUsers={can('users.manage')} canProfiles={can('profiles.manage')} canRetention={can('retention.manage')} />
      )}
      {menu && <CameraMenu x={menu.x} y={menu.y} items={menuItems(menu)} onPick={act} onClose={() => setMenu(null)} />}
      <PromptDialog request={dlg.request} onClosed={() => dlg.setRequest(null)} />
      {/* last in the tree: the toast (z-index 60) sits above the modal backdrop and Radix (50) */}
      <Toasts notices={notices} />
    </div>
  );
}
