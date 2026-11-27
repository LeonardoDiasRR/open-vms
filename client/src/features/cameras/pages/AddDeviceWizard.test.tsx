import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import AddDeviceWizard from './AddDeviceWizard';

// spec 2026-10-19: the labels come from the dictionary — the provider mounts with the default (en).
const renderWizard = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);

// on the first step the wizard does not touch the api (the poll only starts with a 'running' scan):
// a stub just to satisfy the type is enough
const api = {
  startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
  scanStatus: async () => ({ id: 's1', state: 'running', started_ts: '' }),
  discoveryResults: async () => [],
  addCamera: async () => ({ id: 'c1', name: 'Camera 1', state: 'provisioning', profile_ids: [] }),
  deviceChannels: async () => ({ multichannel: true, sources: 24, channels: [] }),
};

describe('AddDeviceWizard', () => {
  it('opens on the "Known address" step with title, tabs, fields and the search button', () => {
    const { container } = renderWizard(<AddDeviceWizard api={api} onClose={() => {}} />);
    expect(container.querySelector('.nx-title')).toHaveTextContent('Add devices');
    expect(screen.getByRole('button', { name: 'Known address' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subnet scan' })).toBeInTheDocument();
    expect(screen.getByLabelText('Address')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Default' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Search' })).toBeInTheDocument();
    expect(screen.getByText('Run a search to list the devices')).toBeInTheDocument();
  });

  // pedido 2026-10-30: o tooltip Examples so existe enquanto o mouse (ou o foco) esta sobre o ?
  it('the Examples popover shows on hover of the ? and hides when the mouse leaves', () => {
    const { container } = renderWizard(<AddDeviceWizard api={api} onClose={() => {}} />);
    const help = container.querySelector('.nx-help') as HTMLElement;
    expect(container.querySelector('.nx-help-pop')).toBeNull();
    fireEvent.mouseEnter(help);
    expect(container.querySelector('.nx-help-pop')).not.toBeNull();
    fireEvent.mouseLeave(help);
    expect(container.querySelector('.nx-help-pop')).toBeNull();
  });
});

describe('AddDeviceWizard: informed port', () => {
  it('sends the typed port in the address and in the source when adding the candidate', async () => {
    const sent: unknown[] = [];
    const api2 = {
      // the REAL scan starts 'running' and the poll effect (which only fires in that state) loads the
      // results; with 'done' up front the effect never runs and there is no row to select
      startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      discoveryResults: async () => [{ id: '138.219.129.186|5003', ip: '138.219.129.186', openPorts: [5003], outcome: 'pending', scan_id: 's1' }],
      addCamera: async (body: unknown) => { sent.push(body); return { id: 'c1', name: 'CAM', state: 'provisioning', profile_ids: [] }; },
    };
    renderWizard(<AddDeviceWizard api={api2 as never} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '138.219.129.186' } });
    // "Default" starts checked and disables the Port field: uncheck it before typing the port
    fireEvent.click(screen.getByLabelText('Default'));
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '5003' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const row = await screen.findByLabelText('Select 138.219.129.186', {}, { timeout: 4000 });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole('button', { name: /^Add \d/ }));
    await waitFor(() => expect(sent.length).toBe(1));
    const body = sent[0] as { addresses: { ip: string; port: number; informada: boolean }[]; source: string };
    expect(body.addresses[0].port).toBe(5003);
    expect(body.addresses[0].informada).toBe(true);
    expect(body.source).toBe('rtsp://138.219.129.186:5003/');
  });
});

describe('AddDeviceWizard: gate status in the table', () => {
  it('shows the protocol label that proved the camera and the refused-credential ones', async () => {
    const api4 = {
      startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      discoveryResults: async () => [
        { id: '10.0.0.1|80', ip: '10.0.0.1', openPorts: [80], status: 'verified', manufacturer: 'HIKVISION', model: 'DS-2CD', scan_id: 's1', outcome: 'pending' },
        { id: '10.0.0.2|554', ip: '10.0.0.2', openPorts: [554], status: 'invalid_credential', scan_id: 's1', outcome: 'pending' },
        { id: '10.0.0.3|554', ip: '10.0.0.3', openPorts: [554], status: 'credential_required', scan_id: 's1', outcome: 'pending' },
        { id: '10.0.0.4|8554', ip: '10.0.0.4', openPorts: [8554], status: 'rtsp', scan_id: 's1', outcome: 'pending' },
      ],
      addCamera: async () => ({ id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] }),
    };
    renderWizard(<AddDeviceWizard api={api4 as never} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '10.0.0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByLabelText('Select 10.0.0.1', {}, { timeout: 4000 });
    expect(screen.getByRole('columnheader', { name: 'Status' })).toBeInTheDocument();
    expect(screen.getByText('ONVIF')).toBeInTheDocument();
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    expect(screen.getByText('Requires credentials')).toBeInTheDocument();
    expect(screen.getByText('RTSP')).toBeInTheDocument();
  });
});

describe('AddDeviceWizard: an ineligible camera is not selectable', () => {
  it('disables the checkbox of the ineligible ones and "Select all" only counts the enabled ones', async () => {
    const api5 = {
      startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      discoveryResults: async () => [
        { id: '10.0.0.1|80', ip: '10.0.0.1', openPorts: [80], status: 'verified', scan_id: 's1', outcome: 'pending' },
        { id: '10.0.0.2|554', ip: '10.0.0.2', openPorts: [554], status: 'invalid_credential', scan_id: 's1', outcome: 'pending' },
        { id: '10.0.0.3|554', ip: '10.0.0.3', openPorts: [554], status: 'credential_required', scan_id: 's1', outcome: 'pending' },
        { id: '10.0.0.4|8554', ip: '10.0.0.4', openPorts: [8554], status: 'rtsp', scan_id: 's1', outcome: 'pending' },
      ],
      addCamera: async () => ({ id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] }),
    };
    renderWizard(<AddDeviceWizard api={api5 as never} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '10.0.0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByLabelText('Select 10.0.0.1', {}, { timeout: 4000 });
    // the two with proof of access stay selectable
    expect((screen.getByLabelText('Select 10.0.0.1') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByLabelText('Select 10.0.0.4') as HTMLInputElement).disabled).toBe(false);
    // the refused credential: checkbox off AND reason in Status (rule and reason go together)
    expect((screen.getByLabelText('Select 10.0.0.2') as HTMLInputElement).disabled).toBe(true);
    // decision D2: credential_required proves nothing about the credential — the row stays selectable
    expect((screen.getByLabelText('Select 10.0.0.3') as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    expect(screen.getByText('Requires credentials')).toBeInTheDocument();
    // "Select all" only hands the enabled ones to the owner: the button count is the proof
    fireEvent.click(screen.getByLabelText('Select all'));
    expect(await screen.findByRole('button', { name: 'Add 3 devices' })).toBeInTheDocument();
  });
});

// Regression (user request, 2026-10-16): after adding, the window no longer shows the row
// "<device name> — <state>" (it was the IP with the text "provisioning"). What confirms the addition
// is the Situation column of the table and the footer summary.
describe('AddDeviceWizard: no "<name> — <state>" row', () => {
  it('does not show the provisioning state under the table', async () => {
    const api6 = {
      startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      discoveryResults: async () => [
        { id: '10.0.0.1|80', ip: '10.0.0.1', openPorts: [80], status: 'verified', scan_id: 's1', outcome: 'pending' },
      ],
      addCamera: async () => ({ id: 'c1', name: '10.0.0.1', state: 'provisioning', profile_ids: [] }),
    };
    renderWizard(<AddDeviceWizard api={api6 as never} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Subnet scan' }));
    fireEvent.change(screen.getByLabelText('First IP'), { target: { value: '10.0.0.1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
    const row = await screen.findByLabelText('Select 10.0.0.1', {}, { timeout: 4000 });
    fireEvent.click(row);
    fireEvent.click(await screen.findByRole('button', { name: /^Add \d/ }));
    // the addition happened: the footer summary is the living proof
    expect(await screen.findByText('1 added')).toBeInTheDocument();
    // the table is still up after the add: the Situation column is what confirms it
    expect(screen.getByText('10.0.0.1:80')).toBeInTheDocument();
    // and the "<name> — <state>" row no longer exists
    expect(screen.queryByText(/provisioning/)).toBeNull();
  });
});

describe('AddDeviceWizard: ESC', () => {
  it('ESC closes the whole wizard, like the X and Cancel', () => {
    const onClose = vi.fn();
    renderWizard(<AddDeviceWizard api={api} onClose={onClose} />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('AddDeviceWizard: modal focus (M3)', () => {
  it('opens with the focus inside, Tab does not escape and the focus goes back to the trigger', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = renderWizard(<AddDeviceWizard api={api} onClose={() => {}} />);
    const dlg = document.querySelector('.nx-dialog') as HTMLElement;
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.contains(document.activeElement)).toBe(true);
    const focusable = Array.from(dlg.querySelectorAll<HTMLElement>('button, input'));
    focusable[focusable.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusable[0]);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });
});

// Spec decision 4 / amendments E2/E9: the multi-channel candidate enters through its own trigger, the
// click enumerates the channels on demand (outside the scan gate) and the addition goes in a SINGLE call.
describe('AddDeviceWizard: channels of the multi-channel candidate', () => {
  const DVR = { id: 'dvr1', ip: '10.0.0.201', openPorts: [80], status: 'verified', videoSources: 24, outcome: 'pending', scan_id: 's1' };
  const CHANNELS = [{ channel: 7, has_stream: true }, { channel: 13, has_stream: false }];
  type DvrBody = { device?: { kind: string }; channels?: number[] };

  // types the credential (the trigger only exists with it), fires the search and selects the candidate
  async function searchDvr(extra: Record<string, unknown> = {}) {
    const apiDvr = {
      startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      discoveryResults: async () => [DVR],
      deviceChannels: async () => ({ multichannel: true, sources: 24, channels: CHANNELS }),
      addCamera: async () => ({ id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] }),
      ...extra,
    };
    renderWizard(<AddDeviceWizard api={apiDvr as never} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '10.0.0.201' } });
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const row = await screen.findByLabelText('Select 10.0.0.201', {}, { timeout: 4000 });
    fireEvent.click(row);
  }

  it('the trigger opens the checklist with the default marks; unchecking the last one locks Add', async () => {
    await searchDvr();
    fireEvent.click(screen.getByRole('button', { name: 'Channels of 10.0.0.201' }));
    const c7 = await screen.findByRole('checkbox', { name: 'Channel 7' }, { timeout: 4000 });
    const c13 = screen.getByRole('checkbox', { name: 'Channel 13' });
    expect(c7).toBeChecked(); // has stream = arrives checked (defaultChannels)
    expect(c13).not.toBeChecked(); // without stream is born unchecked...
    expect(screen.getByText('no stream')).toBeInTheDocument(); // ...and with the warning
    fireEvent.click(c7); // the operator unchecks the only marked one
    const btn = screen.getByRole('button', { name: /^Add \d/ });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    expect(btn).toHaveAttribute('title', 'Select at least one channel');
  });

  it('the addition sends device + channels in a SINGLE call', async () => {
    const sent: DvrBody[] = [];
    const addCamera = async (body: DvrBody) => {
      sent.push(body); return { id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] };
    };
    await searchDvr({ addCamera });
    fireEvent.click(screen.getByRole('button', { name: 'Channels of 10.0.0.201' }));
    await screen.findByRole('checkbox', { name: 'Channel 7' }, { timeout: 4000 });
    fireEvent.click(screen.getByRole('button', { name: /^Add \d/ }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].device).toEqual({ kind: 'nvr' });
    expect(sent[0].channels).toEqual([7]); // 13 (no stream) stayed unchecked
  });

  it('multi-channel without opening the expander still becomes a DVR (classifies at add time)', async () => {
    const order: string[] = [];
    const sent: DvrBody[] = [];
    const deviceChannels = async () => { order.push('channels'); return { multichannel: true, sources: 24, channels: CHANNELS }; };
    const addCamera = async (body: DvrBody) => {
      order.push('add'); sent.push(body); return { id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] };
    };
    await searchDvr({ deviceChannels, addCamera }); // without clicking the trigger
    fireEvent.click(screen.getByRole('button', { name: /^Add \d/ }));
    await waitFor(() => expect(sent.length).toBe(1));
    expect(order).toEqual(['channels', 'add']); // it classified BEFORE adding
    expect(sent[0].device).toEqual({ kind: 'nvr' });
    expect(sent[0].channels).toEqual([7]);
  });
});

describe('AddDeviceWizard: left alignment (spec 2026-10-19)', () => {
  it('the actions block uses the left alignment modifier', () => {
    const { container } = renderWizard(<AddDeviceWizard api={api as never} onClose={() => {}} />);
    expect(container.querySelector('.nx-actions')?.className).toContain('nx-actions-esq');
  });
});

// spec 2026-10-27 (focus order): DOM order IS the tab order here - these inputs carry no
// tabIndex/autoFocus. `.nx-field input` skips the "Default" checkbox on purpose (it lives in
// label.nx-check). Identifiers are the real en i18n strings (measured en.ts:124-135).
const fieldOrder = (container: HTMLElement) =>
  [...container.querySelectorAll('.nx-body .nx-grid .nx-field input')].map((el) =>
    (el as HTMLElement).getAttribute('placeholder')
    || (el as HTMLElement).getAttribute('aria-label')
    || el.closest('label')!.querySelector('.nx-label')!.textContent);

describe('AddDeviceWizard: field focus order (spec 2026-10-27)', () => {
  it('known address tab: address, port, login, password', () => {
    const { container } = renderWizard(<AddDeviceWizard api={api} onClose={() => {}} />);
    expect(fieldOrder(container)).toEqual(['IP / host name / RTSP URL / UDP URL', 'Port', 'Login', 'Password']);
  });

  it('subnet scan tab: first IP, last IP, login, password, port', () => {
    const { container } = renderWizard(<AddDeviceWizard api={api} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Subnet scan' }));
    expect(fieldOrder(container)).toEqual(['First IP', 'Last IP', 'Login', 'Password', 'Port']);
  });
});

// REPRO 2026-10-30 (verde apos o encadeamento source->gate): servidor por caminho (mediamtx) com senha errada.
// Medido ao vivo no container dev: verifyCamera acha o canal na raiz (400 -> 'unknown'), NAO ve a
// recusa e devolve status 'rtsp' — o mesmo status de uma credencial válida. O checkbox deriva só do
// status (isCameraIneligible bloqueia apenas 'invalid_credential'), então o operador marca, clica
// Add e só então descobre o 401. Comportamento desejado: checkbox inativo quando a credencial é
// inválida — esta asserção falha enquanto o scan não souber distinguir.
describe('AddDeviceWizard: credencial inválida em servidor por caminho', () => {
  it('o checkbox fica INATIVO quando a busca com a URL do canal responde com credencial recusada', async () => {
    const apiRepro = {
      startScan: async () => ({ scan_id: 's1', state: 'running', started_ts: '' }),
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      // status medido ao vivo (docker exec ovms-api verifyCamera, senha errada, mediamtx 8555)
      discoveryResults: async () => [
        // status que o servidor passa a devolver apos o encadeamento do source (sondas 1.1/1.2 verdes;
        // medicao ao vivo com senha certa segue 'rtsp')
        { id: '10.95.7.30|8555', ip: '10.95.7.30', openPorts: [8555], status: 'invalid_credential', scan_id: 's1', outcome: 'pending' },
      ],
      addCamera: async () => {
        const e = new Error('Invalid credentials') as Error & { status: number; code: string };
        e.status = 401; e.code = 'invalid_credentials'; throw e;
      },
    };
    renderWizard(<AddDeviceWizard api={apiRepro as never} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'rtsp://10.95.7.30:8555/81f5a2dd-09a8-482e-acc6-3d385aa017bf' },
    });
    fireEvent.change(screen.getByLabelText('Login'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'SENHA-ERRADA' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const checkbox = await screen.findByLabelText('Select 10.95.7.30', {}, { timeout: 4000 });
    expect(checkbox).toBeDisabled();
    // 2026-10-30 pos-fix: sem candidata elegivel o rotulo do botao e 'Add devices' (sem numero)
    expect(screen.getByRole('button', { name: /^Add / })).toBeDisabled();
  });
});

// CONTRATO 2026-10-30: "Known address" com URL completa deve levar o path ao scan (scope.source) —
// e a unica forma do gate autenticar um servidor por caminho (mediamtx) antes do checkbox.
describe('AddDeviceWizard: busca com URL de canal envia scope.source', () => {
  it('o body de startScan traz a URL digitada em scope.source', async () => {
    const bodies: unknown[] = [];
    const apiS = {
      startScan: async (b: unknown) => { bodies.push(b); return { scan_id: 's1', state: 'done', started_ts: '' }; },
      scanStatus: async () => ({ id: 's1', state: 'done', started_ts: '' }),
      discoveryResults: async () => [],
      addCamera: async () => ({ id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] }),
      deviceChannels: async () => ({ multichannel: false, sources: 1, channels: [] }),
    };
    renderWizard(<AddDeviceWizard api={apiS as never} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: 'rtsp://10.95.7.30:8555/81f5a2dd-09a8-482e-acc6-3d385aa017bf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(bodies.length).toBe(1));
    expect((bodies[0] as { scope: { source?: string } }).scope.source)
      .toBe('rtsp://10.95.7.30:8555/81f5a2dd-09a8-482e-acc6-3d385aa017bf');
  });
});

// PLANO 2026-11-27: o guarda de 60 s media Date.now() - Date.parse(started_ts), isto e, dois relogios
// de maquinas diferentes. Com o relogio do navegador seis minutos a frente, o primeiro tick ja
// estourava, apagava o job e a tabela ficava vazia embora o servidor tivesse sete cameras. O
// servidor devolve started_ts deslocado de proposito: o wizard nao deve mais ler esse campo.
const SKEW_MS = 6 * 60 * 1000;
// pega o setTimeout VERDADEIRO no import (antes de qualquer useFakeTimers): serve para ceder
// macrotasks reais enquanto os timers do teste estao fake — o React precisa deles para renderizar
// um setJob que chegou fora do act (scheduler + passive effects = varios macrotasks)
const realSetTimeout = setTimeout;
const CAMERA_ROW = { id: '10.69.36.56|554', ip: '10.69.36.56', openPorts: [554], status: 'rtsp', scan_id: 's1', outcome: 'pending' };

type ScanStatus = { id: string; state: string; started_ts: string };

function openSubnetScan(status: () => ScanStatus | Promise<ScanStatus>,
  results: () => unknown[] | Promise<unknown[]> = () => [CAMERA_ROW]) {
  const apiSkew = {
    startScan: async () => ({
      scan_id: 's1', state: 'running',
      started_ts: new Date(Date.now() - SKEW_MS).toISOString(),
    }),
    scanStatus: async () => status(),
    discoveryResults: async () => results(),
    addCamera: async () => ({ id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] }),
    deviceChannels: async () => ({ multichannel: false, sources: 1, channels: [] }),
  };
  renderWizard(<AddDeviceWizard api={apiSkew as never} onClose={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Subnet scan' }));
  fireEvent.change(screen.getByLabelText('First IP'), { target: { value: '10.69.36.50' } });
  fireEvent.change(screen.getByLabelText('Last IP'), { target: { value: '10.69.36.50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Scan' }));
}

describe('AddDeviceWizard: sem limite de tempo na varredura', () => {
  // REVIEW 2026-11-27 (3): se uma assercao falhar no meio, so o useRealTimers do fim nao roda — o
  // teardown devolve os timers reais para o proximo teste do arquivo nao herdar o relogio fake.
  afterEach(() => vi.useRealTimers());

  it('mostra a camera encontrada mesmo com o servidor seis minutos atras', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openSubnetScan(() => ({ id: 's1', state: 'done', started_ts: '' }));
    await waitFor(() => expect(screen.getByText('10.69.36.56:554')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText(/took too long|demorou demais/i)).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('depois de dois minutos de scan lento segue esperando, sem aviso e sem esvaziar a tabela', async () => {
    let calls = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openSubnetScan(() => { calls += 1; return { id: 's1', state: 'running', started_ts: '' }; });
    await waitFor(() => expect(screen.getByText('10.69.36.56:554')).toBeInTheDocument(), { timeout: 4000 });
    await vi.advanceTimersByTimeAsync(122_000);
    expect(screen.queryByText(/took too long|demorou demais/i)).not.toBeInTheDocument();
    expect(screen.getByText('10.69.36.56:554')).toBeInTheDocument();
    const before = calls;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBeGreaterThan(before);   // o polling continua vivo: quem encerra o scan e o servidor
    vi.useRealTimers();
  });

  // REVIEW 2026-11-27 (1): o state terminal NAO pode depender do request separado das results.
  // Antes, um done do servidor com a busca de results quebrada caia no catch, o job ficava
  // 'running' para sempre e o polling nunca parava.
  it('fecha o scan em done mesmo com a busca de results quebrada e para o polling', async () => {
    let calls = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openSubnetScan(
      () => { calls += 1; return { id: 's1', state: 'done', started_ts: '' }; },
      () => { throw new Error('results 500'); },
    );
    await waitFor(() => expect(calls).toBe(1), { timeout: 4000 });      // primeiro tick aplicado
    expect(screen.getByText(/warning: results 500/)).toBeInTheDocument(); // a falha aparece como aviso
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(1);                       // done fechou o scan: a queda das results nao rearma o polling
    vi.useRealTimers();
  }, 15_000);

  // REVIEW 2026-11-27 (2): a resposta LENTA do tick 1 so chega depois que o tick 2 ja aplicou o done
  // e o efeito foi desmontado. Essa conclusao atrasada e obsoleta: aplicar 'running' aqui reacenderia
  // um scan que o servidor encerrou (polling + Scan desabilitado de novo, para sempre).
  it('a resposta atrasada com running nao reativa um scan que o servidor ja encerrou', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    let serverClosed = false;
    let resolveSlow: (v: ScanStatus) => void = () => {};
    const slowRunning = new Promise<ScanStatus>((r) => { resolveSlow = r; });
    openSubnetScan(() => {
      calls += 1;
      if (calls === 1) return slowRunning;       // sonda lenta: a resposta chega depois do done
      return { id: 's1', state: serverClosed ? 'done' : 'running', started_ts: '' };
    });
    await waitFor(() => expect(calls).toBe(1), { timeout: 4000 });
    serverClosed = true;                          // o servidor encerra; o tick 2 ve 'done' e desliga o efeito
    await waitFor(() => expect(screen.getByText('10.69.36.56:554')).toBeInTheDocument(), { timeout: 4000 });
    expect(calls).toBe(2);
    resolveSlow({ id: 's1', state: 'running', started_ts: '' }); // a conclusao obsoleta chega AGORA
    await new Promise((r) => realSetTimeout(r, 20)); // macrotasks REAIS: o React aplica o setJob obsoleto e o efeito fantasma monta o setInterval
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);                         // descartada: o scan continua fechado
    expect(screen.getByText('10.69.36.56:554')).toBeInTheDocument();
    vi.useRealTimers();
  }, 15_000);

  // REVIEW ROUND 2 (1): o done tem de valer ANTES de esperar as results. Com a request das results
  // pendurada PARA SEMPRE (servidor travado), o state terminal atrasado deixava o scan em 'running'
  // por baixo: o polling continuava pedindo status e o Scan seguia desabilitado.
  it('um done do servidor fecha o scan mesmo com a request de results pendurada para sempre', async () => {
    let calls = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    openSubnetScan(
      () => { calls += 1; return { id: 's1', state: 'done', started_ts: '' }; },
      () => new Promise(() => {}),                 // as results NUNCA resolvem
    );
    await waitFor(() => expect(calls).toBe(1), { timeout: 4000 });
    await new Promise((r) => realSetTimeout(r, 20));            // commit do state num macrotask real
    expect(screen.getByRole('button', { name: 'Scan' })).toBeEnabled(); // done aplicado: Scan reabilitado
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(1);                                       // a request pendurada nao rearma o polling
    vi.useRealTimers();
  }, 15_000);

  // REVIEW ROUND 2 (2) + ROUND 3 (OPEN 1): a janela entre a RESPOSTA done e o RENDER do state
  // terminal. 'cancelled' so existe depois da cleanup, que roda no commit; o 'running' obsoleto que
  // resolve ANTES de qualquer commit passa por ela e, aplicado por ultimo, VENCE o batch do React:
  // running ganha e o scan reacende. O obsoleto e liberado SINCRONAMENTE dentro da chamada de
  // results do tick do done — o MESMO macrotask da resposta done, onde commit/cleanup nao podem
  // existir: quem descarta o obsoleto so pode ser a flag sincronica (stopped).
  it('o running obsoleto que chega entre a resposta done e o commit terminal nao reaceso o scan', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let calls = 0;
    let staleReleased = false;
    let resolveSlow: (v: ScanStatus) => void = () => {};
    const slowRunning = new Promise<ScanStatus>((r) => { resolveSlow = r; });
    openSubnetScan(
      () => {
        calls += 1;
        if (calls === 1) return slowRunning;       // tick 1: sonda lenta, resposta so depois do done
        return { id: 's1', state: 'done', started_ts: '' }; // tick 2: o servidor encerrou o scan
      },
      () => {
        // results do tick do done: e aqui (sincrono, antes de qualquer await) que o obsoleto entra
        // na janela — sem nenhum macrotask entre a resposta done e a conclusao atrasada
        if (calls >= 2 && !staleReleased) {
          staleReleased = true;
          resolveSlow({ id: 's1', state: 'running', started_ts: '' });
        }
        return [CAMERA_ROW];
      },
    );
    await waitFor(() => expect(calls).toBe(1), { timeout: 4000 });
    await vi.advanceTimersByTimeAsync(2000);        // tick 2 ve o done; o obsoleto cai na MESMA hora
    await new Promise((r) => realSetTimeout(r, 20));            // commit dos updates pendentes
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toBe(2);                                       // o obsoleto foi descartado: nada reaceso
    expect(screen.getByText('10.69.36.56:554')).toBeInTheDocument();
    vi.useRealTimers();
  }, 15_000);

  // REVIEW ROUND 3 (OPEN 2): o operador inicia o scan B enquanto a primeira request de results do
  // scan A (ja terminal) segue em voo. A resposta de A que chega depois de B escreve na tabela:
  // sem o dono da tabela, os dispositivos de A aparecem (e ficam selecionaveis) dentro de B.
  it('a resposta atrasada das results do scan A nao escreve na tabela do scan B', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const A_ROW = { id: '10.69.36.56|554', ip: '10.69.36.56', openPorts: [554], status: 'rtsp', scan_id: 's1', outcome: 'pending' };
    const B_ROW = { id: '10.0.0.9|554', ip: '10.0.0.9', openPorts: [554], status: 'rtsp', scan_id: 's2', outcome: 'pending' };
    let started = 0;
    let bStatus = 0;
    let aHeld = false;
    let releaseA: (rows: unknown[]) => void = () => {};
    const aPending = new Promise<unknown[]>((r) => { releaseA = r; });
    const apiMix = {
      startScan: async () => { started += 1; return { scan_id: started === 1 ? 's1' : 's2', state: 'running', started_ts: '' }; },
      scanStatus: async () => {
        if (started === 1) return { id: 's1', state: 'done', started_ts: '' };  // A fecha no primeiro tick
        bStatus += 1;
        return { id: 's2', state: bStatus === 1 ? 'running' : 'done', started_ts: '' }; // B fecha no 2o
      },
      discoveryResults: async () => {
        if (!aHeld) { aHeld = true; return aPending; }  // a FINAL request de A fica em voo
        return started === 1 ? [A_ROW] : [B_ROW];
      },
      addCamera: async () => ({ id: 'c1', name: 'C', state: 'provisioning', profile_ids: [] }),
      deviceChannels: async () => ({ multichannel: false, sources: 1, channels: [] }),
    };
    renderWizard(<AddDeviceWizard api={apiMix as never} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Subnet scan' }));
    fireEvent.change(screen.getByLabelText('First IP'), { target: { value: '10.69.36.50' } });
    fireEvent.change(screen.getByLabelText('Last IP'), { target: { value: '10.69.36.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));   // scan A
    // o tick 1 do A aplica o done e deixa a FINAL request de results em voo (aHeld e a prova)
    await waitFor(() => expect(aHeld).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scan' })).toBeEnabled(), { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }));   // scan B com a request de A pendente
    await waitFor(() => expect(bStatus).toBe(1), { timeout: 5000 }); // tick 1 do B rodou
    await waitFor(() => expect(screen.getByText('10.0.0.9:554')).toBeInTheDocument(), { timeout: 3000 });
    releaseA([A_ROW]);                                               // a resposta final de A chega DEPOIS de B
    await new Promise((r) => realSetTimeout(r, 50));                 // macrotasks reais: o commit da escrita atrasada, se houver
    await new Promise((r) => realSetTimeout(r, 50));
    expect(screen.queryByText('10.69.36.56:554')).not.toBeInTheDocument(); // A jamais escreve na tabela de B
    expect(screen.getByText('10.0.0.9:554')).toBeInTheDocument();
    vi.useRealTimers();
  }, 15_000);
});
