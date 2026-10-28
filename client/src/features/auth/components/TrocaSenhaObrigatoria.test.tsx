import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import ForcedPasswordChange from './TrocaSenhaObrigatoria';

const fake = (over: Partial<Record<string, unknown>> = {}) => ({
  changePassword: vi.fn(async () => ({ token: 'novo', expires_at: 1, username: 'ana', must_change_password: false })),
  ...over,
});

const renderModal = (api: unknown, onChanged = vi.fn(), onExit = vi.fn()) =>
  render(<LanguageProvider>
    <ForcedPasswordChange api={api as never} onChanged={onChanged} onExit={onExit} />
  </LanguageProvider>);

describe('ForcedPasswordChange (spec §7.1.4/§12-F4)', () => {
  it('is a modal with no cancel path: the X leaves the system', () => {
    const onExit = vi.fn();
    const { container } = renderModal(fake(), vi.fn(), onExit);
    expect(screen.getByText('Password change required')).toBeInTheDocument();
    expect(container.querySelector('.nx-backdrop')).not.toBeNull();
    expect(container.querySelector('.nx-close')).not.toBeNull();
    fireEvent.click(container.querySelector('.nx-close')!);
    expect(onExit).toHaveBeenCalled();
  });

  it('requires the current password, the new one and an equal confirmation — no length rule on the client', async () => {
    const api = fake();
    const onChanged = vi.fn();
    renderModal(api, onChanged);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'Temp-123' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'outra-coisa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('The passwords do not match')).toBeInTheDocument();
    expect(api.changePassword).not.toHaveBeenCalled();
    // equal: the password GOES as typed (no minimum checked here — the server's is what counts)
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => expect(api.changePassword).toHaveBeenCalledWith('Temp-123', 'senha-nova-longa'));
    expect(onChanged).toHaveBeenCalledWith('novo');
  });

  it('shows the server message when the current password does not match', async () => {
    const api = fake({ changePassword: vi.fn(async () => { throw Object.assign(new Error('403: current password is invalid'), { status: 403 }); }) });
    renderModal(api);
    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'errada' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.change(screen.getByLabelText('Confirm new password'), { target: { value: 'senha-nova-longa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText(/current password is invalid/)).toBeInTheDocument();
  });

  // spec 2026-10-27: every password field carries the eye (one toggle per field).
  it('has one working eye per password field', () => {
    renderModal(fake());
    expect(screen.getAllByRole('button', { name: 'Show password' })).toHaveLength(3);
    const input = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.click(screen.getAllByRole('button', { name: 'Show password' })[0]);
    expect(input.type).toBe('text');
  });
});
