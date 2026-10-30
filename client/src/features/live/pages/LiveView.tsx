import { useEffect, useState } from 'react';
import StageGrid from '../components/StageGrid';
import CameraMenu from '@/shared/ui/CameraMenu';
import StageTabs from '@/shared/ui/StageTabs';
import { useLayoutTabs, getStageTabsSnapshot, setStageTabsSnapshot, clearStageTabsSnapshot, type Tab } from '@/shared/hooks/useAbasLayout';
import type { ApiClient, Camera, Group } from '@/shared/utils/api';
import { usePromptDialog, PromptDialog } from '@/shared/components/PromptDialog';
import type { PtzApi } from '@/features/live/hooks/usePtz';
import type { OpenRequest, LayoutToOpen } from '@/shared/domain/pedidoAbrir';
import { useCellSelection, NO_SELECTION, type Selection } from '@/shared/hooks/useSelecaoCelula';
import { useLayoutDrop } from '@/shared/hooks/useDropDeLayout';
import type { Profile } from '@/features/live/services/perfis';

// Streaming profile (same shape as /api/v1/profiles): LiveView only groups by camera.
type ProfileRow = Profile & { camera_id: string };

// Layout saved by the tree (same shape as /api/v1/layouts) and the request that arrives from the App.
type Layout = LayoutToOpen;

// The stage uses liveToken (StageGrid/StreamCell); LiveView also reads profiles and saves layouts.
type Api = Pick<ApiClient, 'profiles' | 'saveLayout' | 'liveToken'>;

type Props = {
  api: Api;
  // Multi-server (spec 2026-10-30, 5.6): a api do servidor da câmera. Ausente = toda célula usa
  // `api` (chamador de um servidor só — compat total).
  apiFor?: (serverId: string) => Api;
  cameras: Camera[];
  groups?: Group[];
  layouts?: Layout[];
  openRequest?: OpenRequest;
  onConsumeRequest?: () => void;
  onLayoutsChanged?: () => void;
  onConfig?: (cameraId: string, name: string) => void;
  onRename?: (cameraId: string, name: string) => void;
  // fixup task 5.2: the cell menu's 'toggle-active' (PATCH {ativa}) lives in the App; the page forwards.
  onToggleActive?: (cameraId: string) => void;
  ptz?: PtzApi;
  // phase 4.3: forwarded to the stage cell menu (rename = camera.manage).
  canManageCameras?: boolean;
};

// Layout stage (NX UX): "New Layout N" tabs; dropping a camera/folder positions it on the stage;
// dropping a layout from the tree opens/focuses the tab. The X closes ANY tab (spec 2026-10-15,
// item 2.1) — closing never asks (spec 2026-10-16): the * on the tab is the only warning. Save/
// rename/close also on the right button.
// Double click on the tree sends {cameras: [ids]}: the cameras enter through the same path as the
// drop, only through autoPlace (there is no drop point) and skipping what is already in the tab.
// spec 2026-10-18 (videowall-recording-tabs, sec 6.3): the tab state and actions live in the shared hook
// useLayoutTabs and the bar in StageTabs. Behavior IDENTICAL to before the refactor — Recording started
// using the same code, and that is why this page's suite is the gate.

// spec 2026-10-17 (tab state) + spec 2026-10-27 (shared videowall): tabs/activeKey live in the SHARED
// registry (getStageTabsSnapshot/setStageTabsSnapshot); the page keeps only what is Live's own — the
// selection border. Switching tabs in the App UNMOUNTS the stage; without this the operator comes back
// to an empty stage. Out of the snapshot: `profiles` (the existing effect refetches) and `error`
// (transient UI — today from the hook).
let liveSnapshot: { selection: Selection } | null = null;

// Exported for the App logout and for the tests' `beforeEach`.
export function clearLiveViewSnapshot() { liveSnapshot = null; clearStageTabsSnapshot(); }

export default function LiveView({ api, apiFor, cameras, groups = [], layouts = [], openRequest, onConsumeRequest, onLayoutsChanged, onConfig = () => {}, onRename = () => {}, onToggleActive = () => {}, ptz, canManageCameras }: Props) {
  const dlg = usePromptDialog();
  const { tabs, active, activeKey, setActiveKey, patchTab, openLayout, closeTab, handleRequest,
    error, menu, openMenu, closeMenu, menuItems, handleMenu } =
    useLayoutTabs({ api, onLayoutsChanged, dlg,
      initial: getStageTabsSnapshot() });
  const { selection, clickCell, clearSelection } =
    useCellSelection(liveSnapshot?.selection ?? NO_SELECTION);
  const [profilesByCamera, setProfilesByCamera] = useState<Record<string, Profile[]>>({}); // camera_id -> [profile]

  useEffect(() => {
    let alive = true;
    api.profiles()
      .then((list: ProfileRow[]) => {
        if (!alive) return;
        const map: Record<string, Profile[]> = {};
        for (const p of list) (map[p.camera_id] ||= []).push(p);
        setProfilesByCamera(map);
      })
      // ponytail: failure becomes an empty map, it does not break the screen
      .catch(() => { if (alive) setProfilesByCamera({}); });
    return () => { alive = false; };
  }, [api, cameras]);

  // spec 2026-10-17 (tab state) + spec 2026-10-18 (selection): the mark and the expansion survive a tab
  // switch and die on logout, because `clearLiveViewSnapshot()` is already called there and in the tests.
  useEffect(() => { liveSnapshot = { selection }; setStageTabsSnapshot({ tabs, activeKey }); }, [tabs, activeKey, selection]);

  // request from the tree ("Open"/double click/drag/"New"/camera): the App consumes and clears it; the
  // handling (new tab, cameras with conditional dirty, open/focus layout) belongs to the shared hook.
  useEffect(() => {
    if (!openRequest) return;
    handleRequest(openRequest);
    onConsumeRequest?.();
  }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // layout dragged from the tree; camera/folder go on to the StageGrid (shared hook, spec 2026-10-18
  // videowall-parity D3 — same contract as Archive)
  const onDropLayout = useLayoutDrop(layouts, openLayout);

  return (
    <div className="mode-view" onDropCapture={onDropLayout}>
      <StageTabs tabs={tabs} activeKey={activeKey} onSwitch={setActiveKey} onClose={closeTab}
        error={error} onOpenMenu={openMenu} />
      <StageGrid api={api} apiFor={apiFor} cameras={cameras} groups={groups} profiles={profilesByCamera} ptz={ptz}
        cells={active.cells}
        onChange={(cs) => patchTab(active.key, { cells: cs, dirty: true })}
        onConfig={onConfig}
        onRename={onRename}
        onToggleActive={onToggleActive}
        canManageCameras={canManageCameras}
        selected={selection.id}
        expanded={selection.expanded}
        onSelect={clickCell}
        onClearSelection={clearSelection} />
      {menu && <CameraMenu x={menu.x} y={menu.y} items={menuItems} onPick={handleMenu} onClose={closeMenu} />}
      <PromptDialog request={dlg.request} onClosed={() => dlg.setRequest(null)} />
    </div>
  );
}
