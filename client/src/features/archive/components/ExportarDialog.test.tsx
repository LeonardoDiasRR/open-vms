import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ExportDialog from './ExportarDialog';
import { LanguageProvider } from '@/shared/i18n';
import type { ExportJob } from '@/shared/utils/api';

// spec 2026-10-19 (video-export, section 5): the dialog uses the house Radix — opened via the `open` prop.
const DAY = Math.floor(new Date(2026, 9, 15, 0, 0, 0, 0).getTime() / 1000);
const cameras = [{ profileId: 'p1', name: 'Garagem' }, { profileId: 'p2', name: 'Pátio' }];
const apiFake = () => ({
  base: 'http://127.0.0.1:7101', token: 'tk',
  exportRange: vi.fn(), exports: vi.fn(async (): Promise<ExportJob[]> => []),
});
const openDialog = (api = apiFake(), extra: Record<string, unknown> = {}) =>
  render(<ExportDialog open onOpenChange={vi.fn()} api={api as never} cameras={cameras} day={DAY} {...extra} />,
    { wrapper: LanguageProvider });

const epoch = (h: number, mi: number) => Math.floor(new Date(2026, 9, 15, h, mi, 0, 0).getTime() / 1000);

function setPeriod(date: string, start: string, end: string) {
  fireEvent.change(screen.getByLabelText('Start date'), { target: { value: date } });
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: start } });
  fireEvent.change(screen.getByLabelText('End time'), { target: { value: end } });
}

describe('ExportDialog', () => {
  it('opens with the default camera of the stage and the submit enabled (default: 30 min ending now)', () => {
    openDialog(apiFake(), { defaultProfile: 'p2' });
    expect(screen.getByLabelText('Camera')).toHaveValue('p2');
    // plan 2026-10-23: the description is required. The default period alone does not enable it
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(screen.getByText(/Maximum range: 30 minutes/)).toBeInTheDocument();
  });

  it('cameras arrive after the mount: the profile syncs and the submit enables (defect 2026-10-19)', () => {
    // ArchiveView always mounts the dialog; on the 1st render exportCameras is empty and profile is born ''.
    const { rerender } = render(
      <ExportDialog open onOpenChange={vi.fn()} api={apiFake() as never} cameras={[]} day={DAY} />,
      { wrapper: LanguageProvider },
    );
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    rerender(
      <ExportDialog open onOpenChange={vi.fn()} api={apiFake() as never} cameras={cameras} defaultProfile="p2" day={DAY} />,
    );
    expect(screen.getByLabelText('Camera')).toHaveValue('p2');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('without a camera with a recording profile: the message points at the camera, not the time', () => {
    render(<ExportDialog open onOpenChange={vi.fn()} api={apiFake() as never} cameras={[]} day={DAY} />,
      { wrapper: LanguageProvider });
    expect(screen.getByRole('alert')).toHaveTextContent('Select a camera.');
  });

  it('end before the start: inline message and submit blocked', () => {
    openDialog();
    setPeriod('2026-10-15', '12:00', '11:00');
    expect(screen.getByRole('alert')).toHaveTextContent('The end must be after the start.');
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('31 minute period: the limit message blocks before the POST', () => {
    openDialog();
    setPeriod('2026-10-15', '10:00', '10:31');
    expect(screen.getByRole('alert')).toHaveTextContent('The maximum range is 30 minutes.');
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
  });

  it('submit sends {stream_profile_id, from, to, description} in LOCAL epoch and the card takes over the job', async () => {
    const api = apiFake();
    api.exportRange.mockResolvedValue({ id: 'j1', state: 'exporting', progress: 40, from_ts: epoch(10, 0), to_ts: epoch(10, 25) });
    openDialog(api);
    fireEvent.change(screen.getByLabelText('Camera'), { target: { value: 'p1' } });
    setPeriod('2026-10-15', '10:00', '10:25');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(api.exportRange).toHaveBeenCalledWith({ stream_profile_id: 'p1', from: epoch(10, 0), to: epoch(10, 25), description: 'Fuga' }));
    expect(await screen.findByText(/Exporting… 40%/)).toBeInTheDocument();
    expect(document.querySelector('.exp-fill')?.getAttribute('style')).toContain('width: 40%');
  });

  // NO fake timers here: the Dialog (Radix) keeps its own chain of timers/rAF and
  // `advanceTimersByTimeAsync` never finishes with the modal open (measured in the probe). The case
  // then waits the real 2 s of polling with wide timeouts — the most expensive of the file, ~5 s.
  it('card becomes "Finished!" with the named download link when the job finishes (2 s polling stops on terminal)', async () => {
    const doneJob = { id: 'j1', state: 'ready', name: 'Garagem_2026-10-15T1000_2026-10-15T1025.mp4', from_ts: epoch(10, 0), to_ts: epoch(10, 25) };
    const api = apiFake();
    api.exportRange.mockResolvedValue({ id: 'j1', state: 'queued', from_ts: epoch(10, 0), to_ts: epoch(10, 25) });
    api.exports.mockResolvedValue([doneJob]);
    openDialog(api);
    setPeriod('2026-10-15', '10:00', '10:25');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Finished!/, {}, { timeout: 6000 })).toBeInTheDocument();
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('download', 'Garagem_2026-10-15T1000_2026-10-15T1025.mp4');
    expect(link).toHaveAttribute('href', 'http://127.0.0.1:7101/api/v1/exports/j1/file?token=tk');
    // terminal: more than one 2 s cycle with no active job does not trigger a new fetch
    const calls = api.exports.mock.calls.length;
    await new Promise((r) => setTimeout(r, 2600));
    // polling stops on the terminal state
    expect(api.exports.mock.calls.length).toBe(calls);
  }, 20000);

  it('507 error from the POST shows the server message and the form becomes editable again', async () => {
    const api = apiFake();
    api.exportRange.mockRejectedValue(new Error('507: espaco em disco insuficiente para exportar'));
    openDialog(api);
    setPeriod('2026-10-15', '10:00', '10:25');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/espaco em disco insuficiente/)).toBeInTheDocument();
    expect(screen.getByLabelText('Camera')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('"Export another" resets the card back to the form', async () => {
    const api = apiFake();
    api.exportRange.mockResolvedValue({ id: 'j1', state: 'ready', name: 'x.mp4', from_ts: 1, to_ts: 2 });
    openDialog(api);
    setPeriod('2026-10-15', '10:00', '10:25');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByText(/Finished!/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export another' }));
    expect(screen.getByLabelText('Camera')).toBeInTheDocument();
    // plan 2026-10-23: the reset clears the description (otherwise the next export inherits the previous text)
    expect(screen.getByLabelText('Description')).toHaveValue('');
  });

  // spec 2026-10-23: the Date field left the two-column row. The alignment comes from the STRUCTURE:
  // the row holds exactly Start and End, so they are the two columns and share the top. jsdom does not
  // compute layout. The geometry is measured in the spec (§4.3, probe at 520 and 420 px) and in the manual acceptance.
  it('the date has its own label above the row, and the row holds exactly Start and End', () => {
    openDialog();
    const date = screen.getByLabelText('Start date');
    const dateLabel = date.closest('label');
    expect(dateLabel).not.toBeNull();
    expect(dateLabel!.textContent).toContain('Date');
    const row = document.querySelector('.exp-dialog .sheet-linha');
    expect(row).not.toBeNull();
    // the date is NOT a child of the row any more. Both are siblings inside the form
    expect(row!.contains(date)).toBe(false);
    expect(dateLabel!.parentElement).toBe(row!.parentElement);
    expect(dateLabel!.nextElementSibling).toBe(row);
    expect(row!.querySelectorAll('label')).toHaveLength(2);
    expect(row!.contains(screen.getByLabelText('Start time'))).toBe(true);
    expect(row!.contains(screen.getByLabelText('End time'))).toBe(true);
  });

  it('no label holds two inputs: the date and the time have separate labels', () => {
    openDialog();
    const labels = [...document.querySelectorAll('.exp-dialog label')];
    expect(labels.length).toBe(5);   // camera + date + start + end + description
    for (const l of labels) expect(l.querySelectorAll('input').length).toBeLessThanOrEqual(1);
  });

  // plan 2026-10-23 (description in the export): required field, up to 50, with a counter.
  it('sem descricao o botao fica desabilitado e o aviso aparece', () => {
    openDialog();
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(screen.getByText('Enter the export description')).toBeInTheDocument();
  });

  it('o campo corta em 50 caracteres e mostra o contador', () => {
    openDialog();
    const campo = screen.getByLabelText('Description');
    fireEvent.change(campo, { target: { value: 'a'.repeat(60) } });
    expect((campo as HTMLInputElement).value.length).toBe(50);
    expect(screen.getByText('50/50')).toBeInTheDocument();
  });

  it('envia a descricao limpa no corpo do POST', async () => {
    const api = apiFake();
    api.exportRange.mockResolvedValue({ id: 'e1', state: 'queued', from_ts: 0, to_ts: 60 });
    openDialog(api, { defaultProfile: 'p1' });
    setPeriod('2026-10-15', '10:00', '10:30');
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: '  Fuga  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(api.exportRange).toHaveBeenCalled());
    expect(api.exportRange.mock.calls[0][0].description).toBe('Fuga');
  });

  // plan 2026-10-25 (`exportacao-painel-sem-recarregar`, task 1.1): the dialog notifies the parent when the
  // export is created. That notice is what makes the right panel fetch again, with no F5.
  it('avisa o pai UMA vez quando o POST da exportacao volta', async () => {
    const api = apiFake();
    api.exportRange.mockResolvedValue({ id: 'j1', state: 'queued', from_ts: epoch(10, 0), to_ts: epoch(10, 25) });
    const onCreated = vi.fn();
    openDialog(api, { onCreated });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
  });

  it('NAO avisa o pai quando o POST falha', async () => {
    const api = apiFake();
    api.exportRange.mockRejectedValue(new Error('507: espaco em disco insuficiente para exportar'));
    const onCreated = vi.fn();
    openDialog(api, { onCreated });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Fuga' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(screen.getByText(/507/)).toBeInTheDocument());
    expect(onCreated).not.toHaveBeenCalled();
  });
});
