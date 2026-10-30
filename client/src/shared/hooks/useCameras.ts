import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// Servidor do poll (spec 2026-10-30, 5.5): id = a base do api (identidade estável).
export type ServerRef = { id: string; api: Api };
// Conexão POR servidor: o banner do App nomeia o servidor que falhou (o App tem o rótulo, o hook não).
export type ServerConnection = { serverId: string; ok: boolean; message: string | null };

// 5s poll do catálogo de CADA servidor (cameras + folders + devices) com health, o estado de
// re-streaming e a conexão por servidor — um tick só, Promise.allSettled: um servidor que falha
// mantém a própria última fatia e só ele marca offline (spec 5.5). A saída mescla e etiqueta
// server_id. `rtsp` = o do primeiro servidor (legado); `rtspByServer` é o contrato novo (5.6).
// ponytail (transição, emenda 5 do plano): um api pelouro ainda entra como lista de um servidor
// (id = a base do próprio cliente) — o App só para de passar o legado na Fase 4.
export function useCameras(servers: ServerRef[] | (Api & { base?: string }) | null) {
  const { t } = useT();
  const refs: ServerRef[] = !servers ? []
    : Array.isArray(servers) ? servers
    : [{ id: (servers as { base?: string }).base ?? '', api: servers as Api }];
  const refsRef = useRef(refs); refsRef.current = refs;
  const idsKey = JSON.stringify(refs.map((r) => r.id));

  // A fatia de cada servidor é substituída inteira; o tick que falha deixa a anterior na mesa.
  type Slice = { cameras: Camera[]; devices: Device[]; groups: Group[]; rtsp: Rtsp | null; health: Health | null };
  const [sliceByServer, setSliceByServer] = useState<Record<string, Slice>>({});
  const [statusByServer, setStatusByServer] = useState<Record<string, ServerConnection>>({});

  // etiqueta server_id só quando existe (o caminho legado sem id deixa as listas como são)
  const tag = <T extends { id: string }>(list: T[], id: string): T[] => (id ? list.map((x) => ({ ...x, server_id: id })) : list);

  // manual refresh (o move o chama): catálogo + conexão por servidor, sem esperar o tick de 5 s
  const refresh = useCallback(async () => {
    const rs = await Promise.allSettled(refsRef.current.map(async ({ api }) => {
      const [cams, gs, ds] = await Promise.all([api.cameras(), api.groups(), api.devices().catch(() => [])]);
      return { cams, gs, ds };
    }));
    rs.forEach((r, i) => {
      const id = refsRef.current[i].id;
      if (r.status === 'fulfilled') {
        setSliceByServer((cur) => {
          const prev = cur[id];
          return { ...cur, [id]: { cameras: tag(r.value.cams, id), devices: tag(r.value.ds, id), groups: tag(r.value.gs, id), rtsp: prev?.rtsp ?? null, health: prev?.health ?? null } };
        });
        setStatusByServer((cur) => ({ ...cur, [id]: { serverId: id, ok: true, message: null } }));
      } else {
        setStatusByServer((cur) => ({ ...cur, [id]: { serverId: id, ok: false, message: r.reason instanceof Error ? r.reason.message : t('shared.connection_failed') } }));
      }
    });
  }, [t]);

  useEffect(() => {
    if (refsRef.current.length === 0) return;
    let stop = false;
    const tick = async () => {
      const rs = await Promise.allSettled(refsRef.current.map(async ({ id, api }) => {
        // ponytail: rtsp with catch — an old server (no route) cannot take down its own slice
        const [cams, h, gs, rt, ds] = await Promise.all([
          api.cameras(), api.health(), api.groups(), api.rtsp().catch(() => null), api.devices().catch(() => []),
        ]);
        return { id, cams, h, gs, rt, ds };
      }));
      if (stop) return;
      rs.forEach((r, i) => {
        const id = refsRef.current[i].id;
        if (r.status === 'fulfilled') {
          const { cams, h, gs, rt, ds } = r.value;
          setSliceByServer((cur) => ({ ...cur, [id]: { cameras: tag(cams, id), devices: tag(ds, id), groups: tag(gs, id), rtsp: rt, health: h } }));
          setStatusByServer((cur) => ({ ...cur, [id]: { serverId: id, ok: true, message: null } }));
        } else {
          setStatusByServer((cur) => ({ ...cur, [id]: { serverId: id, ok: false, message: r.reason instanceof Error ? r.reason.message : t('shared.connection_failed') } }));
        }
      });
    };
    tick();
    const int = setInterval(tick, 5000);
    return () => { stop = true; clearInterval(int); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- os apis são lidos do refsRef vivo; só a lista de servidores rearma o intervalo
  }, [idsKey, t]);

  const cameras = useMemo(() => refs.flatMap((r) => sliceByServer[r.id]?.cameras ?? []), [idsKey, sliceByServer]);
  const devices = useMemo(() => refs.flatMap((r) => sliceByServer[r.id]?.devices ?? []), [idsKey, sliceByServer]);
  const groups = useMemo(() => refs.flatMap((r) => sliceByServer[r.id]?.groups ?? []), [idsKey, sliceByServer]);
  // rtsp/health do primeiro servidor = compat com o shell antigo; o contrato novo é o mapa
  const rtspByServer: Record<string, Rtsp | null> = {};
  for (const r of refs) rtspByServer[r.id] = sliceByServer[r.id]?.rtsp ?? null;
  const firstId = refs[0]?.id;
  const rtsp = firstId !== undefined ? sliceByServer[firstId]?.rtsp ?? null : null;
  const health = firstId !== undefined ? sliceByServer[firstId]?.health ?? null : null;

  // Conexões na ordem dos servidores (o nó servidor da árvore lê daqui, spec 5.5). Antes do primeiro
  // tick: desconectado — o banner inicial do shell antigo era exatamente esse estado.
  const noConnection: ServerConnection = { serverId: '', ok: false, message: t('shared.no_connection') };
  const connections: ServerConnection[] = refs.map((r) => statusByServer[r.id] ?? { ...noConnection, serverId: r.id });
  const polled = refs.map((r) => statusByServer[r.id]).filter((c): c is ServerConnection => !!c);
  const failing = polled.find((c) => !c.ok);
  const connection: Connection = polled.length === 0
    ? { ok: false, message: t('shared.no_connection') }
    : failing ? { ok: false, message: failing.message } : { ok: true, message: null };

  // logout: o catálogo e a health somem (o resto do estado fica como estava — comportamento antigo)
  const reset = useCallback(() => { setSliceByServer({}); setStatusByServer({}); }, []);

  // drop na sidebar: câmera(s) → pasta; pasta → pasta (recusa ciclo). Retorna a mensagem de erro ou
  // null — o App só pendura no banner de ação.
  // Vários folders no payload: só o primeiro (o arrastado) anda — não existe batch de pasta.
  // CROSS-SERVER (spec 5.5): uma pasta de destino de OUTRO servidor nunca recebe o move — os ids do
  // catálogo pertencem ao servidor que os emitiu. Sem server_id (fixtures de um servidor) a regra é
  // inerte. Drop na raiz (target null) é sempre aceito: a raiz de cada servidor é a raiz dele.
  const move = useCallback(async ({ cameraIds, groupIds, target, device_id }: DropPayload): Promise<string | null> => {
    const list = refsRef.current;
    if (!list.length) return null;
    if (target) {
      const targetServer = groups.find((g) => g.id === target)?.server_id;
      const sourceServers = device_id ? [devices.find((d) => d.id === device_id)?.server_id]
        : cameraIds.length ? cameraIds.map((cid) => cameras.find((c) => c.id === cid)?.server_id)
        : groupIds.map((gid) => groups.find((g) => g.id === gid)?.server_id);
      if (targetServer && sourceServers.some((s) => s && s !== targetServer)) return t('servers.cross_server_move');
    }
    // quem responde o PATCH: o servidor do destino (ou do item movido — o mesmo depois da regra)
    const targetSid = target ? groups.find((g) => g.id === target)?.server_id
      : device_id ? devices.find((d) => d.id === device_id)?.server_id
      : cameraIds.length ? cameras.find((c) => c.id === cameraIds[0])?.server_id
      : undefined;
    const api = (list.find((r) => r.id === targetSid) ?? list[0]).api;
    try {
      // payload PRECEDENCE (spec 1.3b, declared risk): a drag do DVR publica o payload de câmera
      // (os filhos, que o palco lê) E o do dispositivo. Quando o do dispositivo chega, o alvo é o
      // GRAVADOR: mover os filhos soltos espalharia os canais em vez de mover o DVR para a pasta.
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
  }, [cameras, devices, groups, refresh, t]);

  return { cameras, devices, groups, health, rtsp, rtspByServer, connection, connections, refresh, reset, move };
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

// Menu do nó servidor (spec 5.4): Rename e Disconnect SEMPRE (Disconnect é o único danger);
// "Add camera" entra só com camera.manage.global (D6) — o MESMO padrão de `can` opcional de
// cameraMenuItems: ausente = tudo aberto (o chamador que esquecer o gate degrada, nunca esvazia).
export function serverMenuItems(m: MenuTarget, { t }: Pick<Translate, 't'>, can?: (cap: Capability) => boolean): ItemMenu[] {
  const allow = (cap: Capability) => !can || can(cap);
  const items: ItemMenu[] = [
    { id: 'rename-server', label: t('servers.rename') },
    { id: 'disconnect-server', label: t('servers.disconnect'), danger: true },
  ];
  if (allow('camera.manage.global')) items.push({ id: 'add-camera', label: t('servers.add_camera') });
  void m; // o alvo do menu de servidor é sempre um servidor; a assinatura só alinha com os outros builders
  return items;
}
