import StagePalco, { type StageCell } from '@/shared/ui/StagePalco';
import StreamCell from './StreamCell';
import { remove } from '@/shared/domain/stage';
import type { ApiClient, Camera, Group } from '@/shared/utils/api';
import type { PtzApi } from '@/features/live/hooks/usePtz';
import type { Profile } from '@/features/live/services/perfis';
import { useT } from '@/shared/i18n';

// Right-click actions on the camera area (spec 2026-10-15, item 2.3): ONLY these two, decided by the
// user. Remove is local to the stage; the settings go up to the App (which mounts the
// CameraSettingsModal).

// The stage does not use the api: it only forwards it to StreamCell (liveToken)
type Api = Pick<ApiClient, 'liveToken'>;

// Signature UNCHANGED in meaning (the StageGrid.test.tsx guard is not bypassed): the geometric stage lives
// in shared/ui/StagePalco (plan 2026-10-18 archive-bottom-sheet, C2); here only "what the live cell
// contains" lives — StreamCell + context menu (remove/settings).
type Props = {
  api: Api;
  cameras: Camera[];
  groups?: Group[];
  cells: StageCell[];
  profiles?: Record<string, Profile[]>;
  onChange: (cells: StageCell[]) => void;
  onConfig?: (cameraId: string, name: string) => void;
  onRename?: (cameraId: string, name: string) => void;
  // fixup task 5.2: 'toggle-active' is the App's PATCH (one camera); the grid only forwards the id.
  onToggleActive?: (cameraId: string) => void;
  ptz?: PtzApi;
  selected?: string | null;
  expanded?: boolean;
  onSelect?: (cellId: string) => void;
  onClearSelection?: () => void;
  // phase 4.3: the menu's 'rename' PATCHes the camera (POLICY camera.manage). Absent = everything (default).
  canManageCameras?: boolean;
};

export default function StageGrid({ api, cameras, groups = [], cells, profiles = {}, onChange, onConfig = () => {}, onRename = () => {}, onToggleActive = () => {}, ptz, selected = null, expanded = false, onSelect = () => {}, onClearSelection = () => {}, canManageCameras = true }: Props) {
  const { t } = useT();
  const byId = new Map(cameras.map((c) => [c.id, c]));

  // phase 4.5 (camera ativa): 'toggle-active' joins the cell menu with the SAME id/label as the tree
  // menu (task 4.2). The label follows the TARGET camera, so the items are built per cell (a mural can
  // mix active and inactive cameras). Absent `ativa` = active. It is a camera mutation: canManageCameras.
  function cellItems(cam: Camera) {
    return [
      { id: 'settings', label: t('live.camera_settings') },
      ...(canManageCameras ? [{ id: 'toggle-active', label: t(cam.ativa === false ? 'menu.activate_camera' : 'menu.deactivate_camera') }] : []),
      ...(canManageCameras ? [{ id: 'rename', label: t('cameras.rename') }] : []),
      { id: 'remove', label: t('live.remove_from_layout'), danger: true },
    ];
  }

  // action coming from the cell context menu: remove is local, settings/rename/toggle-active go up
  // to the App (fixup task 5.2: the toggle PATCH lives in the App, the grid only forwards the id).
  function actOnCell(cell: StageCell, cam: Camera, id: string) {
    if (id === 'remove') onChange(remove(cells, cell.id));
    else if (id === 'settings') onConfig(cam.id, cam.name);
    else if (id === 'rename') onRename(cam.id, cam.name);
    else if (id === 'toggle-active') onToggleActive(cam.id);
  }

  return (
    <StagePalco cameras={cameras} groups={groups} cells={cells} kind="live" onChange={onChange}
      selected={selected} maximized={expanded} onSelect={onSelect} onClearSelection={onClearSelection}
      renderCell={(cell, _marked, _expanded) => {
        const cam = cell.content && byId.get(cell.content.camera_id);
        if (!cam) return <div className="slot-empty">{t('live.no_camera')}</div>;
        return <StreamCell api={api} camera={cam} profiles={profiles[cam.id] || []} ptz={ptz}
          onRemove={() => onChange(remove(cells, cell.id))}
          actions={cellItems(cam)}
          onAction={(id) => actOnCell(cell, cam, id)} />;
      }} />
  );
}
