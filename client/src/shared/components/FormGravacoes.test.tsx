import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import FormGravacoes from './FormGravacoes';

const s = (over = {}) => ({
  archive_dir_effective: '/srv/grav',
  retention_days: 3, disk_max_percent: 80,
  disk: { path: '/srv/grav', used_percent: 12, total_bytes: 100, free_bytes: 88, limited: false, error: null },
  ...over,
});

const renderForm = (sOver = {}, value = { days: '5', pct: 70 }) => render(
  <LanguageProvider>
    <FormGravacoes value={{ s: s(sOver), ...value }} busy={false}
      onDays={() => {}} onPercent={() => {}} />
  </LanguageProvider>);

describe('FormGravacoes (spec 2026-10-19 read-only root folder + slider with chip)', () => {
  it('read-only folder: code.nx-readonly with the effective path, no folder button/input', () => {
    const { container } = renderForm();
    const code = container.querySelector('code.nx-readonly');
    expect(code).not.toBeNull();
    expect(code).toHaveTextContent('/srv/grav');
    expect(container.querySelector('button')).toBeNull();
    // the only possible inputs: retention (number) and the slider (range)
    for (const input of Array.from(container.querySelectorAll('input'))) {
      expect(['number', 'range']).toContain(input.type);
    }
    expect(screen.getByText(/Recordings root folder/)).toBeInTheDocument();
  });

  it('"?" help says the folder comes from config.yaml and needs a restart (no env var)', () => {
    const { container } = renderForm();
    const help = container.querySelector('span.nx-help');
    expect(help).not.toBeNull();
    const title = help!.getAttribute('title')!;
    // spec 2026-10-20 §7: the root lives in config.yaml, on the recordings.archive_dir key
    expect(title).toContain('config.yaml');
    expect(title).toContain('recordings.archive_dir');
    expect(title).toContain('restart');
    expect(title).toContain('\n');
    // the environment variable is gone from the UI, wording included
    expect(title).not.toContain('OPENVMS_ARCHIVE_DIR');
    expect(container.textContent).not.toContain('OPENVMS_ARCHIVE_DIR');
    expect(help).toHaveAttribute('aria-label', 'How to change the directory');
  });

  it('slider with its own label, chip with the current pct and without the old "do uso" text', () => {
    const { container } = renderForm();
    expect(screen.getByText('Disk usage limit')).toBeInTheDocument();
    expect(container.querySelector('span.nx-slider-chip')).toHaveTextContent('70%');
    expect(container.querySelector('div.nx-slider-wrap')).not.toBeNull();
    expect(container.textContent).not.toContain('do uso');
    expect(container.textContent).not.toContain('Ao trocar a pasta');
    expect(screen.getByText('Stops recording when the disk reaches the usage limit.')).toBeInTheDocument();
  });

  it('renders the received values: days and slider', () => {
    const { container } = renderForm();
    expect((screen.getByLabelText('Recording retention') as HTMLInputElement).value).toBe('5');
    expect((container.querySelector('input[type="range"]') as HTMLInputElement).value).toBe('70');
  });

  it('propagates days and pct without keeping state', () => {
    const onDays = vi.fn(); const onPercent = vi.fn();
    const { container } = render(
      <LanguageProvider>
        <FormGravacoes value={{ s: s(), days: '3', pct: 80 }} busy={false}
          onDays={onDays} onPercent={onPercent} />
      </LanguageProvider>);
    fireEvent.change(screen.getByLabelText('Recording retention'), { target: { value: '9' } });
    fireEvent.change(container.querySelector('input[type="range"]')!, { target: { value: '90' } });
    expect(onDays).toHaveBeenCalledWith('9');
    expect(onPercent).toHaveBeenCalledWith(90);
  });

  it('limit banner when disk.limited', () => {
    renderForm({ disk: { path: '/srv/grav', used_percent: 91, total_bytes: 100, free_bytes: 9, limited: true, error: null } });
    expect(screen.getByText(/reached the disk usage limit/)).toBeInTheDocument();
    expect(screen.getByText(/91%/)).toBeInTheDocument();
  });
});
