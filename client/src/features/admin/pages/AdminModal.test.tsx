import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import AdminModal from './AdminModal';
import type { Settings, User, AccessProfile } from '@/shared/utils/api';

const globalSettings: Settings = {
  archive_dir_effective: '/var/lib/openvms/recordings',
  retention_days: 30, disk_max_percent: 90,
  disk: { path: '/var/lib/openvms/recordings', used_percent: 12.5, total_bytes: 1000, free_bytes: 875, limited: false, error: null },
};
const api = {
  // spec 2026-10-20 §5: the tabs read the paged envelope
  users: vi.fn(async (): Promise<{ items: User[]; total: number; limit: number; offset: number }> => ({
    items: [{ username: 'ana', profile_id: 'admin', profile_name: 'admin', status: 'active', must_change_password: false }],
    total: 1, limit: 10, offset: 0,
  })),
  accessProfiles: vi.fn(async (): Promise<{ items: AccessProfile[]; total: number; limit: number; offset: number }> => ({
    items: [{ id: 'admin', name: 'admin', kind: 'system', grants_count: 0 }], total: 1, limit: 10, offset: 0,
  })),
  accessProfileGrants: vi.fn(async () => []),
  cameras: vi.fn(async () => []),
  createUser: vi.fn(), patchUser: vi.fn(), deleteUser: vi.fn(), resetPassword: vi.fn(),
  createAccessProfile: vi.fn(), patchAccessProfile: vi.fn(), deleteAccessProfile: vi.fn(),
  settings: vi.fn(async (): Promise<Settings> => globalSettings),
  settingsPatch: vi.fn(async (): Promise<Settings> => globalSettings),
};
const dlg = { confirm: vi.fn(async () => true), ask: vi.fn(async () => 'x'), request: null, setRequest: vi.fn() };

const renderModal = (onClose = vi.fn()) =>
  render(<LanguageProvider><AdminModal api={api as never} dlg={dlg as never} onClose={onClose} /></LanguageProvider>);

describe('AdminModal (spec §12-F4)', () => {
  it('opens on the users tab, switches to profiles and closes through the X', async () => {
    const onClose = vi.fn();
    const { container } = renderModal(onClose);
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(await screen.findByText('ana')).toBeInTheDocument();
    // the modal declares the guard: `nx-dialog` always comes with `nx-close`
    expect(container.querySelector('.nx-dialog')).not.toBeNull();
    expect(container.querySelector('.nx-close')).not.toBeNull();
    expect([...container.querySelectorAll('.nx-tab')].map((b) => b.textContent)).toEqual(['Users', 'Access profiles', 'Recordings']);

    fireEvent.click(screen.getByRole('button', { name: 'Access profiles' }));
    expect(await screen.findByText('system')).toBeInTheDocument();     // the Type column of the profiles table
    expect(screen.queryByText('ana')).toBeNull();

    fireEvent.click(container.querySelector('.nx-close')!);
    expect(onClose).toHaveBeenCalled();
  });

  it('the Recordings tab shows the global controls', async () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Recordings' }));
    expect(await screen.findByText('Recordings root folder')).toBeInTheDocument();
  });
});
