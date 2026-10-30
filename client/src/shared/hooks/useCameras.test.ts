import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ApiClient } from '@/shared/utils/api';
import { LanguageProvider, useT } from '@/shared/i18n';
import { useCameras, cameraMenuItems, serverMenuItems } from './useCameras';
import type { Capability } from '@/shared/domain/capabilities';

// ponytail: the hook receives the api as a parameter; the module mock guarantees no test here
// touches the real network of the HTTP client.
vi.mock('@/shared/utils/api', () => ({ ApiClient: vi.fn() }));

type Api = Pick<ApiClient, 'cameras' | 'devices' | 'health' | 'groups' | 'rtsp' | 'moveCamera' | 'updateGroup' | 'moveDevice'>;
const camera = { id: 'c1', name: 'Portaria', state: 'online', profile_ids: [] };
const device = { id: 'd1', name: 'DVR' };

const wrapper = ({ children }: { children: ReactNode }) => createElement(LanguageProvider, null, children);
const labels = () => renderHook(() => useT(), { wrapper }).result.current;
const menu = (target: { kind: string; id: string }, marked: { kind: string; id: string }[], inGroup = false,
  can?: (cap: Capability) => boolean) =>
  cameraMenuItems(target, marked, inGroup, labels(), can);

const fakeApi = (over: Partial<Api> = {}): Api => ({
  cameras: async () => [camera],
  devices: async () => [device],
  health: async () => ({ ok: true, version: '1.2.3' }),
  groups: async () => [{ id: 'g1', name: 'Alfa' }],
  rtsp: async () => ({ enabled: true, port: 7100, active: [] }),
  moveCamera: async () => camera,
  updateGroup: async () => ({ id: 'g1', name: 'Alfa' }),
  moveDevice: async () => device,
  ...over,
});

describe('useCameras', () => {
  it('without an api it stays empty and disconnected', () => {
    const { result } = renderHook(() => useCameras(null), { wrapper });
    expect(result.current.cameras).toEqual([]);
    expect(result.current.groups).toEqual([]);
    expect(result.current.health).toBeNull();
    expect(result.current.connection).toEqual({ ok: false, message: 'No connection' });
  });

  it('the first tick brings catalog/health/re-streaming and marks connected', async () => {
    const { result } = renderHook(() => useCameras(fakeApi()), { wrapper });
    await waitFor(() => expect(result.current.connection.ok).toBe(true));
    expect(result.current.cameras.map((c) => c.name)).toEqual(['Portaria']);
    expect(result.current.groups).toEqual([{ id: 'g1', name: 'Alfa' }]);
    expect(result.current.health?.version).toBe('1.2.3');
    expect(result.current.rtsp?.enabled).toBe(true);
  });

  it('a failed poll becomes the connection banner', async () => {
    const api = fakeApi({ cameras: async () => { throw new Error('http 500'); } });
    const { result } = renderHook(() => useCameras(api), { wrapper });
    await waitFor(() => expect(result.current.connection).toEqual({ ok: false, message: 'http 500' }));
  });

  it('the catalog brings the devices and a missing route does not take down the poll', async () => {
    const { result } = renderHook(() => useCameras(fakeApi()), { wrapper });
    await waitFor(() => expect(result.current.devices.map((d) => d.name)).toEqual(['DVR']));

    // old server without GET /devices: the catalog (cameras) stays up
    const withoutRoute = fakeApi({ devices: async () => { throw new Error('404'); } });
    const { result: r2 } = renderHook(() => useCameras(withoutRoute), { wrapper });
    await waitFor(() => expect(r2.current.connection.ok).toBe(true));
    expect(r2.current.devices).toEqual([]);
    expect(r2.current.cameras).toHaveLength(1);
  });

  it('reset returns the catalog and health to the logout state', async () => {
    const { result } = renderHook(() => useCameras(fakeApi()), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
    act(() => { result.current.reset(); });
    expect(result.current.cameras).toEqual([]);
    expect(result.current.health).toBeNull();
  });

  it('dropping a folder into itself is refused before moving', async () => {
    const { result } = renderHook(() => useCameras(fakeApi()), { wrapper });
    const error = await result.current.move({ cameraIds: [], groupIds: ['g1'], target: 'g1' });
    expect(error).toBe('A folder cannot be moved into itself');
  });

  it('the set menu does not offer rename/settings', () => {
    const two = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2' }];
    // task 4.2: the batch also offers the always-on activate/deactivate pair (camera.manage)
    expect(menu({ kind: 'camera', id: 'c1' }, two).map((i) => i.id))
      .toEqual(['delete', 'create-group', 'activate-all', 'deactivate-all']);
  });

  // spec 2026-10-17 (1.3b/d): the DVR drag publishes TWO payloads and the DEVICE one wins — without
  // that precedence, dropping a DVR on a folder would spread the 24 channels instead of moving the recorder.
  it('dropping a DVR on a folder moves the DEVICE (1 node) and NONE of its children', async () => {
    const moveDevice = vi.fn(async () => device);
    const moveCamera = vi.fn(async () => camera);
    const { result } = renderHook(() => useCameras(fakeApi({ moveDevice, moveCamera })), { wrapper });
    await waitFor(() => expect(result.current.connection.ok).toBe(true));
    const error = await result.current.move({ cameraIds: ['c10', 'c11'], groupIds: [], target: 'g1', device_id: 'd1' });
    expect(error).toBeNull();
    expect(moveDevice).toHaveBeenCalledWith('d1', 'g1');
    expect(moveCamera).not.toHaveBeenCalled();
  });

  it('without the device payload the drop keeps moving the cameras', async () => {
    const moveDevice = vi.fn(async () => device);
    const moveCamera = vi.fn(async () => camera);
    const { result } = renderHook(() => useCameras(fakeApi({ moveDevice, moveCamera })), { wrapper });
    await result.current.move({ cameraIds: ['c1'], groupIds: [], target: null });
    expect(moveCamera).toHaveBeenCalledWith('c1', null);
    expect(moveDevice).not.toHaveBeenCalled();
  });

  // 1.3c/1.3e: the group item LABEL depends on where the node is (root vs inside a folder), and the
  // DVR has its own trio (Rename, create group/subgroup, Delete recorder). The id stays 'delete'
  // because the App action is the same menu entry — the target kind decides what is deleted.
  it('the DVR menu has its own labels and Delete recorder', () => {
    expect(menu({ kind: 'device', id: 'd1' }, []).map((i) => i.id))
      .toEqual(['rename', 'create-group', 'delete']);
    expect(menu({ kind: 'device', id: 'd1' }, []).map((i) => i.label))
      .toEqual(['Rename', 'Create group', 'Delete recorder']);
    expect(menu({ kind: 'device', id: 'd1' }, [], true).map((i) => i.label))
      .toEqual(['Rename', 'Create subgroup', 'Delete recorder']);
  });

  it('a camera inside a folder has the SAME label pair as the DVR (1.3e)', () => {
    expect(menu({ kind: 'camera', id: 'c1' }, []).map((i) => i.label)).toContain('Create group');
    expect(menu({ kind: 'camera', id: 'c1' }, []).map((i) => i.label)).not.toContain('Create subgroup');
    expect(menu({ kind: 'camera', id: 'c1' }, [], true).map((i) => i.label)).toContain('Create subgroup');
    expect(menu({ kind: 'camera', id: 'c1' }, [], true).map((i) => i.label)).not.toContain('Create group');
  });

  // correction 2026-10-26: the order the operator reads is settings, group, rename, delete.
  // task 4.2: the activate/deactivate toggle sits right after the settings (same camera mutation).
  it('camera menu order: settings, toggle, group, rename, delete', () => {
    expect(menu({ kind: 'camera', id: 'c1' }, [], true).map((i) => i.label))
      .toEqual(['Camera settings', 'Deactivate camera', 'Create subgroup', 'Rename', 'Delete camera']);
    expect(menu({ kind: 'camera', id: 'c1' }, []).map((i) => i.label))
      .toEqual(['Camera settings', 'Deactivate camera', 'Create group', 'Rename', 'Delete camera']);
    expect(menu({ kind: 'camera', id: 'c1' }, [], true).map((i) => i.id))
      .toEqual(['settings', 'toggle-active', 'create-group', 'rename', 'delete']);
  });
});

// phase 4.2: capability gate. Camera mutations (settings/rename/delete) -> camera.manage;
// folder/group/device mutations -> camera.manage.global. Absent `can` = everything allowed.
describe('cameraMenuItems capability gate', () => {
  const ids = (items: { id: string }[]) => items.map((i) => i.id);
  const viewer: (cap: Capability) => boolean = (cap) => cap !== 'camera.manage' && cap !== 'camera.manage.global';
  const globalOnly: (cap: Capability) => boolean = (cap) => cap === 'camera.manage.global';
  const manageOnly: (cap: Capability) => boolean = (cap) => cap === 'camera.manage';

  it('without `can` the menu is byte-identical to the pre-4.2 behavior', () => {
    const all = () => true;
    expect(menu({ kind: 'camera', id: 'c1' }, [], true, all))
      .toEqual(menu({ kind: 'camera', id: 'c1' }, [], true));
    expect(menu({ kind: 'device', id: 'd1' }, [], false, all))
      .toEqual(menu({ kind: 'device', id: 'd1' }, []));
    const two = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2' }];
    expect(menu({ kind: 'camera', id: 'c1' }, two, false, all))
      .toEqual(menu({ kind: 'camera', id: 'c1' }, two));
  });

  it('viewer (manage and manage.global false): camera menu has no rename, delete or create-group', () => {
    const items = ids(menu({ kind: 'camera', id: 'c1' }, [], true, viewer));
    expect(items).not.toContain('rename');
    expect(items).not.toContain('delete');
    expect(items).not.toContain('create-group');
    // settings edits the camera too (PATCH cameras/:id = camera.manage): hidden from the viewer
    expect(items).not.toContain('settings');
    expect(items).toEqual([]);
    // folder and device menus collapse entirely without the global cap
    expect(ids(menu({ kind: 'group', id: 'g1' }, [], true, viewer))).toEqual([]);
    expect(ids(menu({ kind: 'device', id: 'd1' }, [], false, viewer))).toEqual([]);
    // a camera batch selection loses delete and create-group
    const two = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2' }];
    expect(ids(menu({ kind: 'camera', id: 'c1' }, two, false, viewer))).toEqual([]);
  });

  it('camera.manage.global only: no camera rename/delete, but the folder item stays', () => {
    expect(ids(menu({ kind: 'camera', id: 'c1' }, [], false, globalOnly))).toEqual(['create-group']);
    // folder/device menus are pure global-cap territory: intact
    expect(ids(menu({ kind: 'group', id: 'g1' }, [], true, globalOnly))).toEqual(['rename', 'create-group', 'delete']);
    expect(ids(menu({ kind: 'device', id: 'd1' }, [], false, globalOnly))).toEqual(['rename', 'create-group', 'delete']);
    // folder-only batch delete needs just the global cap
    const folders = [{ kind: 'group', id: 'g1' }, { kind: 'group', id: 'g2' }];
    expect(ids(menu({ kind: 'group', id: 'g1' }, folders, true, globalOnly))).toEqual(['delete']);
  });

  it('camera.manage only: camera edits stay, folder/device items go', () => {
    // toggle-active is a camera mutation -> it stays with manageOnly (task 4.2)
    expect(ids(menu({ kind: 'camera', id: 'c1' }, [], true, manageOnly))).toEqual(['settings', 'toggle-active', 'rename', 'delete']);
    expect(ids(menu({ kind: 'group', id: 'g1' }, [], true, manageOnly))).toEqual([]);
    expect(ids(menu({ kind: 'device', id: 'd1' }, [], false, manageOnly))).toEqual([]);
    // camera-only batch delete needs only camera.manage; so does the activate/deactivate pair
    const two = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2' }];
    expect(ids(menu({ kind: 'camera', id: 'c1' }, two, false, manageOnly))).toEqual(['delete', 'activate-all', 'deactivate-all']);
  });

  it('a mixed batch delete needs BOTH caps (camera.manage + camera.manage.global)', () => {
    const mixed = [{ kind: 'camera', id: 'c1' }, { kind: 'group', id: 'g1' }];
    expect(ids(menu({ kind: 'camera', id: 'c1' }, mixed, false, globalOnly))).toEqual(['create-group']);
    // task 4.2: the activate pair touches ONLY the cameras of the selection -> camera.manage alone
    expect(ids(menu({ kind: 'camera', id: 'c1' }, mixed, false, manageOnly))).toEqual(['activate-all', 'deactivate-all']);
    expect(ids(menu({ kind: 'camera', id: 'c1' }, mixed, false, () => true))).toEqual(['delete', 'create-group', 'activate-all', 'deactivate-all']);
  });
});

// plan 2026-10-30 (multi-server, spec 5.5)
describe('useCameras multi-server', () => {
  const cam = (id: string) => ({ id, name: id, state: 'online', profile_ids: [] });
  const srvApi = (over: Partial<Api> = {}): Api => ({
    cameras: async () => [],
    devices: async () => [],
    health: async () => ({ ok: true, version: '1' }),
    groups: async () => [],
    rtsp: async () => ({ enabled: false, port: 8554, active: [] }),
    moveCamera: async () => cam('x'),
    updateGroup: async () => ({ id: 'g', name: 'g' }),
    moveDevice: async () => ({ id: 'd', name: 'd' }),
    ...over,
  });

  it('merges the slices tagged with server_id and answers rtspByServer per server', async () => {
    const A = srvApi({ cameras: async () => [cam('a1')], rtsp: async () => ({ enabled: true, port: 9001, active: [] }) });
    const B = srvApi({ cameras: async () => [cam('b1')], groups: async () => [{ id: 'gb', name: 'Pasta B' }], rtsp: async () => ({ enabled: true, port: 9002, active: [] }) });
    const { result } = renderHook(() => useCameras([{ id: 'A', api: A }, { id: 'B', api: B }]), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(2));
    expect(result.current.cameras.map((c) => [c.id, c.server_id])).toEqual([['a1', 'A'], ['b1', 'B']]);
    expect(result.current.groups).toEqual([{ id: 'gb', name: 'Pasta B', server_id: 'B' }]);
    expect(result.current.rtspByServer['A']?.port).toBe(9001);
    expect(result.current.rtspByServer['B']?.port).toBe(9002);
    expect(result.current.connection.ok).toBe(true);
    expect(result.current.connections.map((c) => c.ok)).toEqual([true, true]);
  });

  it('a server rejected from the start keeps the OTHER slice, names itself offline and the aggregate fails', async () => {
    const dead = srvApi({ cameras: async () => { throw new Error('http 503'); } });
    const A = srvApi({ cameras: async () => [cam('a1')] });
    const { result } = renderHook(() => useCameras([{ id: 'A', api: A }, { id: 'B', api: dead }]), { wrapper });
    await waitFor(() => expect(result.current.connection.ok).toBe(false));
    expect(result.current.cameras.map((c) => c.id)).toEqual(['a1']);
    expect(result.current.connections.find((c) => c.serverId === 'B')).toEqual({ serverId: 'B', ok: false, message: 'http 503' });
    expect(result.current.connections.find((c) => c.serverId === 'A')?.ok).toBe(true);
  });

  it('after a good tick a failed tick keeps the last slice of the own server (spec 5.5)', async () => {
    let fail = false;
    const B = srvApi({ cameras: async () => { if (fail) throw new Error('http 503'); return [cam('b1')]; } });
    const A = srvApi({ cameras: async () => [cam('a1')] });
    const { result } = renderHook(() => useCameras([{ id: 'A', api: A }, { id: 'B', api: B }]), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(2));
    fail = true;
    await act(async () => { await result.current.refresh(); });
    expect(result.current.cameras.map((c) => c.id)).toEqual(['a1', 'b1']); // a fatia B congelou na última leitura
    expect(result.current.connections.find((c) => c.serverId === 'B')?.ok).toBe(false);
  });

  it('move refuses a target of another server and calls NO PATCH', async () => {
    const moveA = vi.fn(async () => cam('a1'));
    const A = srvApi({ cameras: async () => [cam('a1')], moveCamera: moveA });
    const B = srvApi({ groups: async () => [{ id: 'gb', name: 'Pasta B' }] });
    const { result } = renderHook(() => useCameras([{ id: 'A', api: A }, { id: 'B', api: B }]), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
    const err = await result.current.move({ cameraIds: ['a1'], groupIds: [], target: 'gb' });
    expect(err).toBe(labels().t('servers.cross_server_move'));
    expect(moveA).not.toHaveBeenCalled();
  });

  it('move inside the same server PATCHes the api of the camera server', async () => {
    const moveA = vi.fn(async () => cam('a1'));
    const A = srvApi({ cameras: async () => [cam('a1')], groups: async () => [{ id: 'ga', name: 'Pasta A' }], moveCamera: moveA });
    const { result } = renderHook(() => useCameras([{ id: 'A', api: A }]), { wrapper });
    await waitFor(() => expect(result.current.cameras).toHaveLength(1));
    expect(await result.current.move({ cameraIds: ['a1'], groupIds: [], target: 'ga' })).toBeNull();
    expect(moveA).toHaveBeenCalledWith('a1', 'ga');
  });
});

describe('serverMenuItems', () => {
  const items = (can?: (c: Capability) => boolean) => serverMenuItems({ kind: 'server', id: 'http://a' }, labels(), can);

  it('rename, disconnect (danger only) and add-camera with the global cap (spec 5.4)', () => {
    const L = labels();
    expect(items(() => true).map((i) => i.id)).toEqual(['rename-server', 'disconnect-server', 'add-camera']);
    expect(items(() => true)[1].danger).toBe(true);
    expect(items(() => true)[0].danger).toBeUndefined();
    const noGlobal = items(() => false);
    expect(noGlobal.map((i) => i.id)).toEqual(['rename-server', 'disconnect-server']);
    expect(noGlobal.map((i) => i.label)).toEqual([L.t('servers.rename'), L.t('servers.disconnect')]);
  });
});
