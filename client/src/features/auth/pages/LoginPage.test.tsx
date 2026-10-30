import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import LoginPage from './LoginPage';

const renderPage = (onLogin: () => void) => render(<LanguageProvider><LoginPage onLogin={onLogin} /></LanguageProvider>);

beforeEach(() => {
  // E3 do plano anterior: o setup global semeia openvms.lang='en'; clear() mataria o idioma —
  // so as chaves da conexao, agora os DOIS pares (spec memoria-conexao-independente).
  localStorage.removeItem('openvms.server');
  localStorage.removeItem('openvms.port');
  localStorage.removeItem('openvms.serverModal');
  localStorage.removeItem('openvms.portModal');
  h.instances.length = 0;
  h.fail = false;
});

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

  it('sem memoria pre-preenche host e porta da pagina (spec 2026-10-30)', () => {
    renderPage(() => {});
    expect((screen.getByLabelText('Server') as HTMLInputElement).value).toBe(window.location.hostname);
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe(window.location.port);
  });

  it('valor legado URL inteira decompoe entre os dois campos', () => {
    localStorage.setItem('openvms.server', 'http://10.95.7.25');
    localStorage.setItem('openvms.port', '7102');
    renderPage(() => {});
    expect((screen.getByLabelText('Server') as HTMLInputElement).value).toBe('10.95.7.25');
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe('7102');
  });

  it('memoria da modal NAO aparece no login (spec 2026-10-30)', () => {
    localStorage.setItem('openvms.serverModal', '10.9.9.9');
    localStorage.setItem('openvms.portModal', '8443');
    renderPage(() => {});
    expect((screen.getByLabelText('Server') as HTMLInputElement).value).toBe(window.location.hostname);
    expect((screen.getByLabelText('Port') as HTMLInputElement).value).toBe(window.location.port);
  });

  it('Server e Port ficam na mesma linha (.server-port-row)', () => {
    const { container } = renderPage(() => {});
    const row = container.querySelector('.server-port-row');
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByLabelText('Server')).toBeInTheDocument();
    expect(within(row as HTMLElement).getByLabelText('Port')).toBeInTheDocument();
  });

  it('login bem-sucedido salva a memoria e monta a base {scheme}//{host}:{porta}', async () => {
    renderPage(() => {});
    fireEvent.change(screen.getByLabelText('Server'), { target: { value: '10.0.0.5' } });
    fireEvent.change(screen.getByLabelText('Port'), { target: { value: '7102' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ana' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 's3nha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(h.instances.length).toBe(1));
    expect(h.instances[0]).toBe(`${window.location.protocol}//10.0.0.5:7102`);
    expect(localStorage.getItem('openvms.server')).toBe('10.0.0.5');
    expect(localStorage.getItem('openvms.port')).toBe('7102');
    expect(localStorage.getItem('openvms.serverModal')).toBeNull();
    expect(localStorage.getItem('openvms.portModal')).toBeNull();
  });

  it('login que falha NAO salva a memoria', async () => {
    h.fail = true;
    renderPage(() => {});
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ana' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'errada' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(localStorage.getItem('openvms.server')).toBeNull();
    expect(localStorage.getItem('openvms.port')).toBeNull();
  });
});

// F4 (spec §10): the login returns `profile_id` and `must_change_password`; the App needs BOTH (the
// ordinal role is gone). The mock proves what LoginPage PASSES ON — the shape of what it receives.
const { h } = vi.hoisted(() => ({ h: { instances: [] as string[], fail: false } }));
// E2 do plano: os testes novos precisam da base montada (instances) e de um login que falha (fail).
vi.mock('@/shared/utils/api', () => ({
  ApiClient: class {
    token: string | null = null;
    constructor(base: string) { h.instances.push(base); }
    login = async () => {
      if (h.fail) throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      return { token: 'tk', expires_at: 1, username: 'ana', profile_id: 'viewer', must_change_password: true };
    };
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
