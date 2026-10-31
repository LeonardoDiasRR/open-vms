import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, Camera, Device, Group, Health, Rtsp } from '@/shared/utils/api';
import { canMove } from '@/shared/domain/groups';
import type { ItemMenu } from '@/shared/ui/CameraMenu';
import type { Capability } from '@/shared/domain/capabilities';
import { useT } from '@/shared/i18n';

// Connection banner: the same pair the App used to keep.
export type Connection = { ok: boolean; message: string | null };
// Drop on the sidebar (same shape as CameraTree's onDrop).
// `device_id` is the new drag payload from the DVR (spec 2026-10-17, 1.3b): it comes TOGETHER with
// the camera one and takes PRECEDENCE — dropping a DVR on a folder moves the recorder, never its
// loose channels.
export type DropPayload = { cameraIds: string[]; groupIds: string[]; target: string | null; device_id?: string | null };
// Menu target and selection: the menu only READS kind/id from both (`ativa` is read by the camera
// menu too, task 4.2: absent/true = active, ONLY false is inactive — the tolerant read).
type MenuTarget = { kind: string; id: string; ativa?: boolean };

// Only what the hook reads: the catalog, health, the poll and the sidebar moves.
type Api = Pick<ApiClient, 'cameras' | 'devices' | 'health' | 'groups' | 'rtsp' | 'moveCamera' | 'updateGroup' | 'moveDevice'>;

// 5s poll of the catalog (cameras + folders) together with server health, the re-streaming state
// and the connection banner — it was a single Promise.all in the App, so it is still a single tick:
// the banner reflects the same call that brought the catalog.
export function useCameras(api: Api | null) {
  const { t } = useT();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [rtsp, setRtsp] = useState<Rtsp | null>(null); // {enabled, port, active} from GET /api/v1/rtsp
  const [connection, setConnection] = useState<Connection>({ ok: false, message: t('shared.no_connection') });

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [cams, gs, ds] = await Promise.all([api.cameras(), api.groups(), api.devices().catch(() => [])]);
      setCameras(cams); setGroups(gs); setDevices(ds);
    } catch { /* the 5s poll reconnects */ }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let stop = false;
    const tick = async () => {
      try {
        // ponytail: rtsp with catch — an old server (no route) cannot take down the whole poll
        const [cams, h, gs, rt, ds] = await Promise.all([
          api.cameras(), api.health(), api.groups(), api.rtsp().catch(() => null), api.devices().catch(() => []),
        ]);
        if (stop) return;
        setCameras(cams);
        setHealth(h);
        setGroups(gs);
        setRtsp(rt);
        setDevices(ds);
        setConnection({ ok: true, message: null });
      } catch (e) {
        if (!stop) setConnection({ ok: false, message: e instanceof Error ? e.message : t('shared.connection_failed') });
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(id); };
  }, [api, t]);

  // logout: the catalog and health go away (the rest of the state stays as it was)
  const reset = useCallback(() => { setCameras([]); setDevices([]); setHealth(null); }, []);

  // drop on the sidebar: camera(s) -> folder; folder -> folder (refuses a cycle). Returns the error
  // message or null — the App only hangs it on the action banner.
  // Several folders in the payload: only the first (the dragged row) moves — there is no batch
  // folder-move API; the other groups stay where they are.
  const move = useCallback(async ({ cameraIds, groupIds, target, device_id }: DropPayload): Promise<string | null> => {
    if (!api) return null;
    try {
      // payload PRECEDENCE (spec 1.3b, declared risk): the DVR drag publishes the camera payload
      // (the children, which the stage reads) AND the device one. When the device one arrives, the
      // target is the RECORDER: moving the loose children would spread the channels instead of
      // moving the DVR into the folder.
      if (device_id) {
        await api.moveDevice(device_id, target);
        await refresh();
        return null;
      }
      for (const cid of cameraIds) await api.moveCamera(cid, target);
      if (groupIds.length) {
        if (!canMove(Object.fromEntries(groups.map((g): [string, Group] => [g.id, g])), groupIds[0], target)) {
          return t('shared.folder_into_itself');
        }
        await api.updateGroup(groupIds[0], { parent_id: target });
      }
      await refresh();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : t('shared.move_failed');
    }
  }, [api, groups, refresh, t]);

  return { cameras, devices, groups, health, rtsp, connection, refresh, reset, move };
}

// Camera/folder/device menu items. Set menu: NO Rename and NO Settings — those belong to a single
// item; and "Create group" only enters with a camera in the selection (batch folder move does not
// exist, and creating an empty group would do nothing).
// `inGroup` says whether the target is INSIDE a folder: it chooses the label and the destination of
// the new folder (spec 2026-10-17, 1.3c/1.3e). Without the argument it means `false` — today's
// root behavior.
// A plain function cannot call hooks, so it receives the translator from the caller.
type Translate = Pick<ReturnType<typeof useT>, 't' | 'tn'>;

// phase 4.2: `can` is OPTIONAL — absent means everything allowed (old callers keep the old menu).
// Mutation gates: camera rename/delete/settings -> 'camera.manage' (server: PATCH/DELETE cameras/:id);
// folder/group/device items (rename, create group, delete) -> 'camera.manage.global'. No move item
// lives in this builder (moves come from drag/drop), so nothing else gates on the camera.
export function cameraMenuItems(m: MenuTarget, marked: MenuTarget[], inGroup = false, { t, tn }: Translate,
  can?: (cap: Capability) => boolean): ItemMenu[] {
  // Absent checker = everything open: a caller that forgets `can` degrades to the pre-4.2 menu,
  // never to an empty one.
  const allow = (cap: Capability) => !can || can(cap);
  const selection = marked.length > 1 && marked.some((x) => x.kind === m.kind && x.id === m.id) ? marked : null;
  if (selection) {
    const nc = selection.filter((x) => x.kind === 'camera').length;
    const nf = selection.length - nc;
    const noun = nc && nf ? t('shared.items') : nc ? t('shared.cameras') : t('shared.folders');
    const items: ItemMenu[] = [];
    // The batch delete needs EVERY capability its payload touches: cameras -> camera.manage,
    // folders -> camera.manage.global (a mixed selection needs both).
    if ((!nc || allow('camera.manage')) && (!nf || allow('camera.manage.global'))) {
      items.push({ id: 'delete', label: t('shared.delete_selected', { n: selection.length, items: noun }), danger: true });
    }
    if (nc && allow('camera.manage.global')) items.push({ id: 'create-group', label: tn('cameras.create_group_with', nc) });
    // Task 4.2 batch: ALWAYS both (the selection may mix states; the App applies the flag to every
    // camera in it). Camera mutation only -> camera.manage gate, same as the single toggle.
    if (nc && allow('camera.manage')) {
      items.push({ id: 'activate-all', label: t('menu.activate_all') });
      items.push({ id: 'deactivate-all', label: t('menu.deactivate_all') });
    }
    return items;
  }
  // 1.3c: the DVR has the folder menu. The group item neither moves the recorder nor its children
  // (the folder is only created); the `id` is the same 'delete' as camera/folder because the App
  // action reads the target kind.
  if (m.kind === 'device') {
    // The whole DVR trio mutates the recorder (a device), not one camera: global gate.
    if (!allow('camera.manage.global')) return [];
    return [{ id: 'rename', label: t('cameras.rename') },
            { id: 'create-group', label: inGroup ? t('cameras.create_subgroup') : t('cameras.create_group') },
            { id: 'delete', label: t('cameras.delete_recorder'), danger: true }];
  }
  if (m.kind !== 'camera') {
    // Folder/group: rename, subfolder and delete are all folder mutations -> global gate.
    if (!allow('camera.manage.global')) return [];
    return [{ id: 'rename', label: t('cameras.rename') },
            { id: 'create-group', label: t('cameras.create_subgroup') },
            { id: 'delete', label: t('cameras.delete_folder'), danger: true }];
  }
  // 1.3e: the same label pair as the DVR — a camera at the root creates a folder at the root, a
  // camera inside a folder creates a subfolder in its folder
  // correction 2026-10-26: the order the operator reads — settings, group, rename, delete.
  // settings/rename/delete edit the camera itself (PATCH/DELETE cameras/:id -> camera.manage);
  // the group item creates a FOLDER -> camera.manage.global.
  const items: ItemMenu[] = [];
  if (allow('camera.manage')) items.push({ id: 'settings', label: t('cameras.camera_settings') });
  // Task 4.2 single: ONE item, the label says where the click takes the camera (the tolerant read:
  // only ativa === false is inactive). Camera mutation -> camera.manage gate.
  if (allow('camera.manage')) {
    items.push({ id: 'toggle-active', label: t(m.ativa === false ? 'menu.activate_camera' : 'menu.deactivate_camera') });
  }
  if (allow('camera.manage.global')) items.push({ id: 'create-group', label: inGroup ? t('cameras.create_subgroup') : t('cameras.create_group') });
  if (allow('camera.manage')) items.push({ id: 'rename', label: t('cameras.rename') });
  if (allow('camera.manage')) items.push({ id: 'delete', label: t('cameras.delete_camera'), danger: true });
  return items;
}
