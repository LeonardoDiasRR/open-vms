import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import LiveView, { clearLiveViewSnapshot } from './LiveView';

// REGRESSAO (bug 2026-11-13): o LiveView buscava os profiles so no servidor PRIMARIO (`api.profiles()`).
// O StreamCell so negocia WHEP quando recebe um profile, entao a camera de servidor EXTRA ficava sem
// imagem (o Pacaraima tocava com o PAC primario e ficava preto como extra do RR — 10.95.7.25).
// Plano: docs/superpowers/plans/2026-11-13-live-servidor-extra.md
const PRIM = 'http://10.95.7.25';
const EXTRA = 'http://10.95.13.61:7102';

beforeEach(() => {
  clearLiveViewSnapshot();
  vi.stubGlobal('RTCPeerConnection', class {
    addTransceiver() {} ontrack = null; onconnectionstatechange = null; connectionState = 'connecting';
    async createOffer() { return { type: 'offer', sdp: 'v=0' }; }
    async setLocalDescription() {} async setRemoteDescription() {} close() {}
  });
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 201, text: async () => 'v=0' })));
});

const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const saveLayout = () => Promise.resolve({ id: 'l1', name: 'Name' });

function dropCamera(container: HTMLElement, cameraId: string) {
  const grid = container.querySelector('.stage-grid') as HTMLElement;
  grid.getBoundingClientRect = () => ({ top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  fireEvent.drop(grid, { clientX: 10, clientY: 10, dataTransfer: { getData: (t: string) => (t === 'application/x-ovms-camera' ? cameraId : '') } });
}

const cam = (id: string, server_id: string) => ({ id, name: id, state: 'online', server_id, profile_ids: [] as string[] });

describe('live de camera de servidor extra (bug 2026-11-13)', () => {
  it('negocia WHEP com o profile do PROPRIO servidor da camera', async () => {
    const primaryToken = vi.fn(async () => ({ whep_url: `${PRIM}:8890/prim/whep`, token: 'tk1' }));
    const extraToken = vi.fn(async () => ({ whep_url: 'http://10.95.13.61:8890/extra/whep', token: 'tk2' }));
    const primary = { saveLayout, profiles: () => Promise.resolve([]), liveToken: primaryToken };
    const extra = { saveLayout, liveToken: extraToken,
      profiles: () => Promise.resolve([{ id: 'p-extra', camera_id: 'c-extra', width: 640, height: 360 }]) };

    const { container } = render(
      <LiveView api={primary as never} apiFor={() => extra as never} cameras={[cam('c-extra', EXTRA)]} />,
      { wrapper },
    );
    dropCamera(container, 'c-extra');

    await waitFor(() => expect(extraToken).toHaveBeenCalledWith('p-extra'), { timeout: 3000 });
    expect(primaryToken).not.toHaveBeenCalled();
  });

  it('busca profiles de TODOS os servidores das cameras (primario + cada extra)', async () => {
    const p1 = vi.fn(() => Promise.resolve([]));
    const p2 = vi.fn(() => Promise.resolve([]));
    const p3 = vi.fn(() => Promise.resolve([]));
    const api = { saveLayout, profiles: p1, liveToken: vi.fn() };
    const apis: Record<string, unknown> = { [EXTRA]: { saveLayout, profiles: p2, liveToken: vi.fn() }, 'http://10.95.13.62:7102': { saveLayout, profiles: p3, liveToken: vi.fn() } };

    render(
      <LiveView api={api as never} apiFor={(id) => apis[id] as never}
        cameras={[cam('c1', PRIM), cam('c2', EXTRA), cam('c3', 'http://10.95.13.62:7102')]} />,
      { wrapper },
    );

    await waitFor(() => expect(p2).toHaveBeenCalled());
    expect(p1).toHaveBeenCalled();
    expect(p3).toHaveBeenCalled();
  });

  it('servidor extra fora do ar nao derruba o live do primario', async () => {
    const primaryToken = vi.fn(async () => ({ whep_url: `${PRIM}:8890/prim/whep`, token: 'tk1' }));
    const primary = { saveLayout, liveToken: primaryToken,
      profiles: () => Promise.resolve([{ id: 'p-prim', camera_id: 'c-prim', width: 640, height: 360 }]) };
    const extra = { saveLayout, liveToken: vi.fn(), profiles: () => Promise.reject(new Error('ECONNREFUSED')) };

    const { container } = render(
      <LiveView api={primary as never} apiFor={((id: string) => (id === EXTRA ? extra : primary)) as never}
        cameras={[cam('c-prim', PRIM), cam('c-extra', EXTRA)]} />,
      { wrapper },
    );
    dropCamera(container, 'c-prim');

    await waitFor(() => expect(primaryToken).toHaveBeenCalledWith('p-prim'), { timeout: 3000 });
    expect(extra.liveToken).not.toHaveBeenCalled();
  });

  it('apiFor que cai no primario (server_id desconhecido) nao duplica o fetch', async () => {
    const p1 = vi.fn(() => Promise.resolve([]));
    const api = { saveLayout, profiles: p1, liveToken: vi.fn() };
    render(<LiveView api={api as never} apiFor={() => api as never} cameras={[cam('c1', PRIM), cam('c2', 'http://x')]} />, { wrapper });
    await waitFor(() => expect(p1).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(p1).toHaveBeenCalledTimes(1);
  });
});
