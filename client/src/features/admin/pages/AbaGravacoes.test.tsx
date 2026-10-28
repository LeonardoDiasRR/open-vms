import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import RecordingsTab from './AbaGravacoes';

// Spec 2026-10-19 (read-only folder): the root is no longer configurable through the API — the Settings
// mock no longer has archive_dir/default_archive_dir and the api mock no longer has settingsDirs.
const cfg = (over = {}) => ({
  archive_dir_effective: '/srv/rec',
  retention_days: 3, disk_max_percent: 80,
  disk: { path: '/srv/rec', used_percent: 12, total_bytes: 100, free_bytes: 88, limited: false, error: null },
  ...over,
});
const api = (over = {}) => ({
  settings: () => Promise.resolve(cfg()),
  settingsPatch: vi.fn(async () => cfg()),
  ...over,
});
const renderTab = (a = api()) => render(<LanguageProvider><RecordingsTab api={a} /></LanguageProvider>);

describe('RecordingsTab (spec 2026-10-19)', () => {
  it('shows the effective values: root, days and slider at the server percentage', async () => {
    renderTab();
    expect(await screen.findByText('Recordings root folder')).toBeInTheDocument();
    expect((screen.getByLabelText('Recording retention') as HTMLInputElement).value).toBe('3');
    // spec 2026-10-19: the slider's old label goes away; the range input stays at the server's pct
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('80');
  });
  it('limit banner when disk.limited, with usage and limit', async () => {
    const a = api({ settings: () => Promise.resolve(cfg({ disk: { path: '/srv/rec', used_percent: 91, total_bytes: 100, free_bytes: 9, limited: true, error: null }, disk_max_percent: 80 })) });
    renderTab(a);
    expect(await screen.findByText(/reached the disk usage limit/)).toBeInTheDocument();
    expect(screen.getByText(/91%/)).toBeInTheDocument();
  });
  it('Save only enables with a change and sends the validated pair; invalid input does not go out', async () => {
    const patch = vi.fn(async () => cfg({ retention_days: 7 }));
    renderTab(api({ settingsPatch: patch }));
    const btn = await screen.findByRole('button', { name: 'Save' });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Recording retention'), { target: { value: '0' } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText('Retention must be at least 1 day')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Recording retention'), { target: { value: '7' } });
    fireEvent.click(btn);
    await waitFor(() => expect(patch).toHaveBeenCalledWith({ retention_days: 7, disk_max_percent: 80 }));
  });
  it('folder shown as text: the effective path appears with no editing control', async () => {
    renderTab();
    expect(await screen.findByText('/srv/rec')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('No folder picker button: nothing clickable points at the root', async () => {
    renderTab();
    await screen.findByText('Recordings root folder');
    expect(screen.queryByRole('button', { name: /\/srv\/rec/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Selecionar esta pasta' })).not.toBeInTheDocument();
  });
});
