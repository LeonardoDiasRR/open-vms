import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import OnboardingWizard from './WizardOnboarding';

const cfg = {
  archive_dir_effective: '/srv/grav',
  retention_days: 3, disk_max_percent: 80,
  disk: { path: '/srv/grav', used_percent: 12, total_bytes: 100, free_bytes: 88, limited: false, error: null },
};
type Api = {
  changePassword: ReturnType<typeof vi.fn>; settings: ReturnType<typeof vi.fn>;
  settingsPatch: ReturnType<typeof vi.fn>;
};
const mkApi = (over: Partial<Api> = {}): Api => ({
  changePassword: vi.fn(async () => ({ token: 'tk2', expires_at: 1, username: 'admin', must_change_password: false })),
  settings: vi.fn(async () => cfg),
  settingsPatch: vi.fn(async () => cfg),
  ...over,
});
const step1 = () => {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'senha-nova-longa' } });
  fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'senha-nova-longa' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
};

const renderStep = (over: Partial<Api> = {}) => {
  const api = mkApi(over);
  const onDone = vi.fn();
  const { container } = render(<LanguageProvider>
    <OnboardingWizard api={api as never} loginPassword="Temp-1" onDone={onDone} />
  </LanguageProvider>);
  return { api, onDone, container };
};

describe('OnboardingWizard (spec 2026-10-19)', () => {
  it('step 1: no current-password field, with a step indicator', () => {
    renderStep();
    expect(screen.getByText('Initial setup')).toBeInTheDocument();
    expect(screen.getByText('Step 1 of 2 · Administrator password')).toBeInTheDocument();
    expect(screen.queryByLabelText('Current password')).toBeNull();
    expect(screen.getByLabelText('New password')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument();
  });
  it('Next is inert with mismatched passwords; equal ones enable it', () => {
    renderStep();
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'outra' } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'senha-nova-longa' } });
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
  it('Next changes the password with the login temporary one and opens step 2 with defaults', async () => {
    const { api } = renderStep();
    step1();
    expect(await screen.findByText('Step 2 of 2 · Recordings')).toBeInTheDocument();
    expect(api.changePassword).toHaveBeenCalledWith('Temp-1', 'senha-nova-longa');
    expect((screen.getByLabelText('Recording retention') as HTMLInputElement).value).toBe('3');
    expect((screen.getByRole('slider') as HTMLInputElement).value).toBe('80');
  });
  it('change-password error (server policy >= 6) stays visible on step 1', async () => {
    renderStep({ changePassword: vi.fn(async () => { throw new Error('400: password must have at least 6 characters'); }) });
    step1();
    expect(await screen.findByText(/at least 6 characters/)).toBeInTheDocument();
    expect(screen.queryByText('Step 2 of 2 · Recordings')).toBeNull();
  });
  it('Finish sends retention and limit (NO archive_dir) once and calls onDone with the new token', async () => {
    const { api, onDone } = renderStep();
    step1();
    await screen.findByText('Step 2 of 2 · Recordings');
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    // discriminating case (spec 2026-10-19 §7): the folder is no longer configurable through the API
    await waitFor(() => expect(api.settingsPatch).toHaveBeenCalledWith(
      { retention_days: 3, disk_max_percent: 80 }));
    expect(api.settingsPatch.mock.calls[0][0]).not.toHaveProperty('archive_dir');
    expect(api.settingsPatch).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledWith('tk2');
  });
  it('PATCH error keeps step 2 with nx-err and does not finish', async () => {
    const { onDone } = renderStep({ settingsPatch: vi.fn(async () => { throw new Error('400: folder does not exist'); }) });
    step1();
    await screen.findByText('Step 2 of 2 · Recordings');
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText(/folder does not exist/)).toBeInTheDocument();
    expect(screen.queryByText('Step 2 of 2 · Recordings')).not.toBeNull();
    expect(onDone).not.toHaveBeenCalled();
  });
  it('no exit (D3): no nx-close, no close by aria-label, Esc does not close', () => {
    const { container } = renderStep();
    expect(container.querySelector('.nx-close')).toBeNull();
    for (const b of Array.from(container.querySelectorAll('button'))) {
      expect(/close/i.test(b.getAttribute('aria-label') || '')).toBe(false);
    }
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('Initial setup')).toBeInTheDocument();
  });

  // spec 2026-10-27: every password field carries the eye (one toggle per field).
  it('has one working eye per password field', () => {
    renderStep();
    expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(2);
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0]);
    expect(input.type).toBe('text');
  });
});
