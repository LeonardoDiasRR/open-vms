import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import CameraSettingsModal from './CameraSettingsModal';

// spec 2026-10-19: the labels come from the dictionary — the provider mounts with the default (en).
const withProvider = (ui: React.ReactElement) => <LanguageProvider>{ui}</LanguageProvider>;
const renderModal = (ui: React.ReactElement) => render(withProvider(ui));

// spec 2026-10-26 (save button): the modal NEVER calls the API on change. The mocks below record every
// call; tests assert WHICH call happens WHEN (only Save writes).
const cfgBase = { id: 'c1', name: 'Camera 1', recording: false, manual: null, rtsp: {} };
const mkApi = (over: Record<string, unknown> = {}) => {
  const calls: Array<[string, unknown]> = [];
  const base = {
    cameraConfig: () => Promise.resolve({ ...cfgBase }),
    cameraOnvifRefresh: (_id: string, body?: unknown) => { calls.push(['refresh', body]); return Promise.resolve({ ...cfgBase }); },
    setCameraOptions: (_id: string, body: unknown) => { calls.push(['patch', body]); return Promise.resolve({ ...cfgBase, ...(body as object) }); },
    setCameraManufacturer: (_id: string, name: string) => { calls.push(['manual', name]); return Promise.resolve({ ...cfgBase }); },
    cameraBrands: () => Promise.resolve([]),
  };
  return { calls, api: { ...base, ...over } };
};

// spec 2026-10-27: closing dirty goes through the App's confirm dialog. Tests inject a fake PromptHandle;
// `result` is what the operator answers (true = Discard, false = Cancel).
const mkDlg = (result = false) => ({ request: null, setRequest: () => {}, confirm: vi.fn().mockResolvedValue(result) }) as unknown as PromptHandle;

describe('CameraSettingsModal: a single General tab (spec 2026-10-19)', () => {
  it('opens with only the general read: no Recording tab, no retention field', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    expect(screen.getByText('Camera settings — Camera 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recording' })).toBeNull();
    expect(screen.queryByLabelText('Retention time')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Set manufacturer' })).toBeInTheDocument();
  });

  // spec 2026-10-27 (modal-header-ativa v4): line 1 = recording switch + Set manufacturer on the
  // right (the active switch lives in .nx-titlebar now); line 2 (nx-linha-opcoes) comes after the
  // button. Document order is the pin. The recording switch is the ONLY .nx-switch in the line → [0].
  it('linha 1: gravação e Set manufacturer; a linha 2 vem depois do botão', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    fireEvent.click(container.querySelectorAll('.nx-linha-ativa .nx-switch')[0] as Element); // recording ON: makes line 2 exist
    const line1 = container.querySelector('.nx-cta-linha.nx-linha-ativa') as HTMLElement;
    const interactive = Array.from(line1.querySelectorAll('input, button'));
    expect(interactive).toHaveLength(2);
    expect(interactive[0].classList.contains('nx-switch')).toBe(true);   // recording
    expect(interactive[1].classList.contains('nx-btn')).toBe(true);      // Set manufacturer
    expect(interactive[1].classList.contains('spacer-left')).toBe(true);
    const line2 = container.querySelector('.nx-cta-linha.nx-linha-opcoes') as HTMLElement;
    expect(line2).not.toBeNull();
    expect(line1.compareDocumentPosition(line2) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('.nx-linha-switch')).toBeNull();      // a linha antiga morreu
  });
});

// spec 2026-10-27 (modal-header-ativa v4): the active switch lives in .nx-titlebar (before .nx-close),
// so the recording switch is the ONLY .nx-switch inside .nx-linha-ativa → index [0].
const flipSwitch = (container: HTMLElement) => fireEvent.click(container.querySelectorAll('.nx-linha-ativa .nx-switch')[0] as Element);
const flipAtiva = (container: HTMLElement) => fireEvent.click(container.querySelector('.nx-titlebar .nx-switch') as Element);

// --- spec 2026-10-26 (save button): the switch edits the DRAFT; only Save writes (inverts the old
// "moving the switch saves at once" test) ---
describe('CameraSettingsModal: draft and Save (spec save-button)', () => {
  it('2.1-T1 switch: toggle calls NO api; Save issues one PATCH with the three fields; refetch confirms', async () => {
    let recorded = false;
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      cameraConfig: () => Promise.resolve({ ...cfgBase, recording: recorded }),
      setCameraOptions: (_id: string, body: unknown) => { calls.push(['patch', body]); recorded = true; return Promise.resolve({ ...cfgBase, recording: true }); },
    });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    flipSwitch(container);
    expect(await screen.findByText('Recording on')).toBeInTheDocument();
    expect(calls).toEqual([]); // nothing went out on change
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(calls).toEqual([['patch', { recording: true, recording_mode: 'continuous', motion_sensitivity: 5, ativa: true }]]));
    await waitFor(() => expect(save).toBeDisabled());
    expect(screen.getByText('Recording on')).toBeInTheDocument();
  });

  // inverts the old "409 reverts the switch": the gate now lands on Save, the draft keeps the value
  it('2.1-T2 409 from the disk gate lands on Save: the switch KEEPS the operator value', async () => {
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      setCameraOptions: (_id: string, body: unknown) => {
        calls.push(['patch', body]);
        return Promise.reject(Object.assign(new Error('recordings reached the disk usage limit'), { status: 409 }));
      },
    });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    flipSwitch(container);
    const save = screen.getByRole('button', { name: 'Save' });
    fireEvent.click(save);
    expect(await screen.findByText('recordings reached the disk usage limit')).toBeInTheDocument();
    expect(screen.getByText('Recording on')).toBeInTheDocument(); // draft kept (plan E3)
    expect(save).toBeEnabled();
    expect(calls.length).toBe(1);
  });

  // inverts the old "envia modo e sensibilidade no PATCH" on-change test
  it('2.1-T3 type and sensitivity edit the draft; the Save PATCH carries the three fields', async () => {
    let rec: Record<string, unknown> = { ...cfgBase, recording: true, recording_mode: 'continuous', motion_sensitivity: 5 };
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      cameraConfig: () => Promise.resolve({ ...rec }),
      setCameraOptions: (_id: string, body: unknown) => { calls.push(['patch', body]); rec = { ...rec, ...(body as object) }; return Promise.resolve({ ...rec }); },
    });
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    const select = await screen.findByLabelText('Recording type');
    expect((select as HTMLSelectElement).value).toBe('continuous');
    fireEvent.change(select, { target: { value: 'motion' } });
    expect(calls).toEqual([]);
    const slider = await screen.findByLabelText('Sensitivity');
    expect((slider as HTMLInputElement).value).toBe('5'); // draft sensitivity comes from the read, not from a server echo
    fireEvent.change(slider, { target: { value: '9' } });
    expect(screen.getByText('Records 60 s before and 60 s after motion')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls).toEqual([['patch', { recording: true, recording_mode: 'motion', motion_sensitivity: 9, ativa: true }]]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
  });

  it('2.1-T4 dirty per control: probe and manual pick each enable Save (last action wins)', async () => {
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      cameraOnvifRefresh: (_id: string, body?: unknown) => { calls.push(['refresh', body]); return Promise.resolve({ ...cfgBase, manufacturer: 'AXIS' }); },
      cameraBrands: () => Promise.resolve([{ name: 'Uniview' }]),
    });
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Set manufacturer' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    expect(calls).toEqual([['refresh', { probe: true }]]); // the CTA probes READ-ONLY
    expect(await screen.findByText(/not saved/)).toBeInTheDocument(); // pending badge (plan E5)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls[1]).toEqual(['refresh', undefined])); // Save re-runs WITHOUT probe
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled());
    expect(screen.queryByText(/not saved/)).toBeNull();
  });

  it('2.1-T5 manual pick stays pending until Save, then POSTs the manufacturer', async () => {
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      cameraOnvifRefresh: () => Promise.resolve({ ...cfgBase, onvif_error: 'no answer' }),
      cameraBrands: () => Promise.resolve([{ name: 'Uniview' }]),
    });
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set manufacturer' }));
    const title = await screen.findByText(/Camera manufacturer/);
    const inner = within(title.closest('.nx-dialog') as HTMLElement);
    fireEvent.change(inner.getByLabelText('Manufacturer') as HTMLElement, { target: { value: 'Uniview' } });
    // the brand list arrives async: the inner Save only enables once it lands
    await waitFor(() => expect(inner.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(inner.getByRole('button', { name: 'Save' })); // inner Save: emits, does NOT write
    expect(calls.filter((c) => c[0] === 'manual')).toEqual([]);
    const save = screen.getByRole('button', { name: 'Save' }); // parent Save (inner modal closed)
    expect(await within(document as unknown as HTMLElement).findByText(/not saved/)).toBeInTheDocument();
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(calls).toContainEqual(['manual', 'Uniview']));
    await waitFor(() => expect(save).toBeDisabled());
    expect(screen.queryByText(/not saved/)).toBeNull();
  });

  it('2.1-T6 partial save: PATCH ok + manufacturer fail keeps the fields saved and the manufacturer pending', async () => {
    let recorded = false;
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      cameraConfig: () => Promise.resolve({ ...cfgBase, recording: recorded }),
      cameraOnvifRefresh: () => Promise.resolve({ ...cfgBase, onvif_error: 'no answer' }),
      cameraBrands: () => Promise.resolve([{ name: 'Uniview' }]),
      setCameraOptions: (_id: string, body: unknown) => { calls.push(['patch', body]); recorded = true; return Promise.resolve({ ...cfgBase, recording: true }); },
      setCameraManufacturer: (_id: string, name: string) => { calls.push(['manual', name]); return Promise.reject(new Error('brand gone')); },
    });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    flipSwitch(container);
    fireEvent.click(screen.getByRole('button', { name: 'Set manufacturer' }));
    const title = await screen.findByText(/Camera manufacturer/);
    const inner = within(title.closest('.nx-dialog') as HTMLElement);
    fireEvent.change(inner.getByLabelText('Manufacturer') as HTMLElement, { target: { value: 'Uniview' } });
    // the brand list arrives async: the inner Save only enables once it lands
    await waitFor(() => expect(inner.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(inner.getByRole('button', { name: 'Save' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Could not save the changes')).toBeInTheDocument();
    expect(calls).toEqual([['patch', { recording: true, recording_mode: 'continuous', motion_sensitivity: 5, ativa: true }], ['manual', 'Uniview']]);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled(); // manufacturer still pending (plan E3)
    expect(await screen.findByText(/not saved/)).toBeInTheDocument();
    expect(screen.getByText('Recording on')).toBeInTheDocument(); // confirmed field value came back from the refetch
  });

  it('2.1-T7 without canEdit Save never enables, even with a probe pending', async () => {
    const dlg = mkDlg();
    const { api } = mkApi({ cameraOnvifRefresh: () => Promise.resolve({ ...cfgBase, manufacturer: 'AXIS' }) });
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} />);
    await screen.findByText('Recording off');
    fireEvent.click(screen.getByRole('button', { name: 'Set manufacturer' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

describe('CameraSettingsModal: close guard (spec 2026-10-27: confirm dialog)', () => {
  it('closing clean calls onClose right away and never asks the confirm dialog', async () => {
    const onClose = vi.fn();
    const dlg = mkDlg();
    const { api } = mkApi();
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={onClose} canEdit />);
    await screen.findByText('Recording off');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dlg.confirm).not.toHaveBeenCalled();
  });

  it('closing dirty asks the system confirm; Discard (true) closes', async () => {
    const onClose = vi.fn();
    const dlg = mkDlg(true);
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={onClose} canEdit />);
    await screen.findByText('Recording off');
    flipSwitch(container);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(dlg.confirm).toHaveBeenCalledTimes(1);
    expect(dlg.confirm).toHaveBeenCalledWith('Discard changes?', ['There are unsaved changes'], { danger: true, text: 'Discard' });
  });

  it('Cancel (confirm resolves false) keeps the modal, the draft and the fixed footer', async () => {
    const onClose = vi.fn();
    const dlg = mkDlg(false);
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={onClose} canEdit />);
    await screen.findByText('Recording off');
    flipSwitch(container);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(dlg.confirm).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Recording on')).toBeInTheDocument(); // draft kept
    // fixed footer: only Close and Save, no inline discard text/button anywhere
    const actions = document.querySelector('.nx-dialog .nx-actions') as HTMLElement;
    expect(Array.from(actions.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Close', 'Save']);
    expect(screen.queryByText('Keep editing')).toBeNull();
    expect(screen.queryByText('There are unsaved changes')).toBeNull();
  });

  it('ESC with a draft routes through the confirm dialog too', async () => {
    const onClose = vi.fn();
    const dlg = mkDlg(true);
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={onClose} canEdit />);
    await screen.findByText('Recording off');
    flipSwitch(container);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(dlg.confirm).toHaveBeenCalledTimes(1);
  });
});

// carried over from the pre-save modal (non-regression oracles named by the spec section 6.1)
describe('CameraSettingsModal: carried oracles', () => {
  it('recording_blocked from the server disables the switch with a warning', async () => {
    const dlg = mkDlg();
    const { api } = mkApi({ cameraConfig: () => Promise.resolve({ ...cfgBase, recording_blocked: true }) });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    const sw = await waitFor(() => {
      const el = container.querySelectorAll('.nx-linha-ativa .nx-switch')[0] as HTMLInputElement; // recording: the only switch in the line (v4)
      expect(el).toBeDisabled();
      return el;
    });
    expect(sw).toBeDisabled();
    expect(await screen.findByText('Recordings reached the disk usage limit and were stopped.')).toBeInTheDocument();
  });

  it('the App re-read does not re-seed the switch and does not touch dirty', async () => {
    const camera = { id: 'c1', name: 'Camera 1' };
    const dlg = mkDlg();
    let reads = 0;
    const base = mkApi();
    const api = { ...base.api, cameraConfig: () => { reads += 1; return Promise.resolve({ ...cfgBase, recording: reads >= 2 }); } };
    const { container, rerender } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={camera} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    rerender(withProvider(<CameraSettingsModal dlg={dlg} api={{ ...api }} camera={camera} onClose={() => {}} canEdit />));
    await waitFor(() => expect(reads).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect((container.querySelectorAll('.nx-linha-ativa .nx-switch')[0] as HTMLInputElement).checked).toBe(false); // recording: the only switch in the line (v4)
    // the re-read lands as the NEW baseline (pinned component): the untouched draft now DIFFERS from
    // it, so dirty flips on — the oracle of this test is the switch above, NOT being re-seeded.
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('without canEdit the switch is disabled (the POLICY decides on the server)', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} />);
    const sw = await waitFor(() => {
      const el = container.querySelector('.nx-switch') as HTMLInputElement;
      expect(el).toBeDisabled();
      return el;
    });
    expect(sw).toBeDisabled();
  });

  it('the modal does not render the FOV block', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByRole('button', { name: 'Set manufacturer' });
    expect(screen.queryByLabelText('Degrees at minimum zoom')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save FOV' })).toBeNull();
  });

  it('closes on ESC when clean', () => {
    const onClose = vi.fn();
    const dlg = mkDlg();
    const { api } = mkApi();
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={onClose} canEdit />);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('with the ManufacturerModal on top, ESC closes ONLY it (stack)', async () => {
    const dlg = mkDlg();
    const { api } = mkApi({ cameraOnvifRefresh: () => Promise.resolve({ ...cfgBase, onvif_error: 'no answer' }) });
    const onClose = vi.fn();
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={onClose} canEdit />);
    fireEvent.click(await screen.findByRole('button', { name: 'Set manufacturer' }));
    await screen.findByText(/Camera manufacturer/);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText(/Camera manufacturer/)).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens with the focus inside and gives it back to the trigger on close', async () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const dlg = mkDlg();
    const { api } = mkApi();
    const { unmount } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    const dlgEl = document.querySelector('.nx-dialog') as HTMLElement;
    expect(dlgEl.getAttribute('aria-modal')).toBe('true');
    expect(dlgEl.contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('com a gravação desligada não mostra o tipo de gravação nem o aviso de pré/pós', async () => {
    const dlg = mkDlg();
    const { api } = mkApi({ cameraConfig: () => Promise.resolve({ ...cfgBase, recording: false, recording_mode: 'motion' }) });
    renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    expect(screen.queryByLabelText('Recording type')).toBeNull();
    expect(screen.queryByLabelText('Sensitivity')).toBeNull();
    expect(screen.queryByText('Records 60 s before and 60 s after motion')).toBeNull();
  });

  // spec 2026-10-27 (modal-header-ativa v4), case c: the recording switch (.nx-linha-ativa index [0],
  // the only one in the line) shows .nx-linha-opcoes ON and hides it OFF, on the draft alone.
  it('o switch de gravação mostra/esconde as opções na hora — sem chamada de api', async () => {
    const dlg = mkDlg();
    const { calls, api } = mkApi({ cameraConfig: () => Promise.resolve({ ...cfgBase, recording: true, recording_mode: 'continuous' }) });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByLabelText('Recording type');
    expect(container.querySelector('.nx-linha-opcoes')).not.toBeNull();
    flipSwitch(container); // OFF: flips the recording switch at index [0]
    await screen.findByText('Recording off');
    expect(screen.queryByLabelText('Recording type')).toBeNull();
    expect(container.querySelector('.nx-linha-opcoes')).toBeNull();
    flipSwitch(container); // ON again: the options line comes back
    await screen.findByLabelText('Recording type');
    expect(container.querySelector('.nx-linha-opcoes')).not.toBeNull();
    expect(calls).toEqual([]); // inverts the old immediate PATCH: show/hide happens on the draft alone
  });
});

// --- spec 2026-10-27 (modal-header-ativa v4): the Ativa switch lives in .nx-titlebar, before .nx-close.
// Absent `ativa` on the camera = active (only `ativa === false` means inactive, same tolerant read as the server). ---
describe('CameraSettingsModal: ativa switch (plan 2026-10-27 camera ativa)', () => {
  it('ativa switch renders CHECKED with the on label when camera.ativa is absent or true', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Active');
    const sw = container.querySelector('.nx-titlebar .nx-switch') as HTMLInputElement;
    expect(sw.checked).toBe(true);
    // a re-open with ativa:true shows the same state
    const { container: c2 } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c2', name: 'Camera 2', ativa: true }} onClose={() => {}} canEdit />);
    await screen.findAllByText('Active');
    expect((c2.querySelector('.nx-titlebar .nx-switch') as HTMLInputElement).checked).toBe(true);
  });

  it('ativa switch renders UNCHECKED with the off label when camera.ativa === false', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1', ativa: false }} onClose={() => {}} canEdit />);
    await screen.findByText('Inactive');
    expect((container.querySelector('.nx-titlebar .nx-switch') as HTMLInputElement).checked).toBe(false);
  });

  it('flipping Ativa swaps the on/off label and nothing calls the api until Save', async () => {
    const dlg = mkDlg();
    const { calls, api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Active');
    flipAtiva(container);
    expect(await screen.findByText('Inactive')).toBeInTheDocument();
    expect(screen.queryByText('Active')).toBeNull();
    expect(calls).toEqual([]);
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled(); // ativa alone makes the draft dirty
  });

  it('Save sends ativa:false in setCameraOptions; after a confirmed save Save disables again', async () => {
    const dlg = mkDlg();
    const { calls, api } = mkApi({
      setCameraOptions: (_id: string, body: unknown) => { calls.push(['patch', body]); return Promise.resolve({ ...cfgBase, ...(body as object) }); },
    });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Active');
    flipAtiva(container);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(calls).toEqual([['patch', { recording: false, recording_mode: 'continuous', motion_sensitivity: 5, ativa: false }]]));
    await waitFor(() => expect(save).toBeDisabled()); // the saved value becomes the new ativa baseline
  });

  it('with ativa:false the recording row, the mode select and the sensitivity slider are disabled', async () => {
    const dlg = mkDlg();
    const { api } = mkApi({ cameraConfig: () => Promise.resolve({ ...cfgBase, recording: true, recording_mode: 'motion', motion_sensitivity: 5 }) });
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1', ativa: false }} onClose={() => {}} canEdit />);
    const rec = await waitFor(() => {
      const el = container.querySelectorAll('.nx-linha-ativa .nx-switch')[0] as HTMLInputElement; // recording: the only switch in the line (v4)
      expect(el).toBeDisabled();
      return el;
    });
    expect(rec).toBeDisabled();
    expect(await screen.findByLabelText('Recording type')).toBeDisabled();
    expect(await screen.findByLabelText('Sensitivity')).toBeDisabled();
  });
});

// --- spec 2026-10-27 (modal-header-ativa v4): the active switch moved from the body to the titlebar,
// BEFORE the close button, with the visible "Active"/"Inactive" text (i18n en camera_active_on/off). ---
describe('CameraSettingsModal: active switch in the titlebar (spec 2026-10-27 v4)', () => {
  it('a: the active input lives inside .nx-titlebar BEFORE .nx-close; its sibling span reads "Active"', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Active'); // absent ativa = active
    const sw = container.querySelector('.nx-titlebar input.nx-switch') as HTMLInputElement;
    expect(sw).not.toBeNull(); // inside the titlebar, not in .nx-linha-ativa
    const close = container.querySelector('.nx-titlebar .nx-close') as HTMLElement;
    // document order: the switch comes first, the close button FOLLOWS it
    expect(sw.compareDocumentPosition(close) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(sw.closest('.nx-check') as HTMLElement).getByText('Active')).toBeInTheDocument();
    // ativa:true on the camera reads the same
    const { container: c2 } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c2', name: 'Camera 2', ativa: true }} onClose={() => {}} canEdit />);
    await screen.findAllByText('Active');
    const sw2 = c2.querySelector('.nx-titlebar input.nx-switch') as HTMLInputElement;
    expect(within(sw2.closest('.nx-check') as HTMLElement).getByText('Active')).toBeInTheDocument();
  });

  it('b: .nx-linha-ativa holds exactly ONE switch (recording) plus the Set manufacturer button', async () => {
    const dlg = mkDlg();
    const { api } = mkApi();
    const { container } = renderModal(<CameraSettingsModal dlg={dlg} api={api} camera={{ id: 'c1', name: 'Camera 1' }} onClose={() => {}} canEdit />);
    await screen.findByText('Recording off');
    const line1 = container.querySelector('.nx-cta-linha.nx-linha-ativa') as HTMLElement;
    expect(line1.querySelectorAll('input.nx-switch')).toHaveLength(1);
    expect(within(line1).getByRole('button', { name: 'Set manufacturer' })).toBeInTheDocument();
  });
});
