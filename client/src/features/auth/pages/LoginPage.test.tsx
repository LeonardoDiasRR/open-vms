import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import LoginPage from './LoginPage';

const renderPage = (onLogin: () => void) => render(<LanguageProvider><LoginPage onLogin={onLogin} /></LanguageProvider>);

describe('LoginPage', () => {
  it('shows the form fields and the sign-in button', () => {
    renderPage(() => {});
    expect(screen.getByLabelText('Server')).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false');
  });

  // plan 2026-10-26: the login button is the app CTA (same class as the other primary buttons).
  it('o botão de entrada é o CTA (classe nx-btn)', () => {
    renderPage(() => {});
    expect(screen.getByRole('button', { name: 'Sign in' })).toHaveClass('nx-btn');
  });
});

// F4 (spec §10): the login returns `profile_id` and `must_change_password`; the App needs BOTH (the
// ordinal role is gone). The mock proves what LoginPage PASSES ON — the shape of what it receives.
vi.mock('@/shared/utils/api', () => ({
  ApiClient: class {
    token: string | null = null;
    constructor(_server: string) {}
    login = async () => ({ token: 'tk', expires_at: 1, username: 'ana', profile_id: 'viewer', must_change_password: true });
  },
}));

it('hands the profile and the pending-change flag to the App', async () => {
  const received: unknown[] = [];
  renderPage(((s: unknown) => { received.push(s); }) as never);
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ana' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'senha-temporaria' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(received.length).toBe(1));
  expect(received[0]).toMatchObject({ user: 'ana', profile: 'viewer', mustChangePassword: true });
});
