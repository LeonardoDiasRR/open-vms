import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { LanguageProvider, useT } from '@/shared/i18n';
import AddServerModal from './AddServerModal';

// labels().t(...) em vez de texto fixo: a tradução exata é pinada em dictionaries.test.ts e as
// tarefas da Fase 1 são paralelas — o teste vale com a chave já commitada ou pelo fallback da chave.
const wrapper = ({ children }: { children: ReactNode }) => createElement(LanguageProvider, null, children);
const labels = () => renderHook(() => useT(), { wrapper }).result.current;
const mount = (ui: React.ReactElement) => render(ui, { wrapper });

const fill = (ip: string, port: string) => {
  const L = labels();
  fireEvent.change(screen.getByLabelText(L.t('servers.ip')), { target: { value: ip } });
  fireEvent.change(screen.getByLabelText(L.t('servers.port')), { target: { value: port } });
  fireEvent.change(screen.getByLabelText(L.t('auth.username')), { target: { value: 'admin' } });
  fireEvent.change(screen.getByLabelText(L.t('auth.password')), { target: { value: 'senha' } });
};

const submit = () => fireEvent.click(screen.getByRole('button', { name: labels().t('servers.add') }));

describe('AddServerModal (plan 2026-10-30)', () => {
  it('mounts the base {scheme}://{ip}:{port} from the page and closes on success', async () => {
    const onSubmit = vi.fn(async () => null as string | null);
    const onClose = vi.fn();
    mount(<AddServerModal existingBases={[]} onSubmit={onSubmit} onClose={onClose} />);
    fill('10.0.0.9', '7102');
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(`${window.location.protocol}//10.0.0.9:7102`, 'admin', 'senha'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('the port is pre-filled with the page port', () => {
    mount(<AddServerModal existingBases={[]} onSubmit={async () => null} onClose={() => {}} />);
    expect((screen.getByLabelText(labels().t('servers.port')) as HTMLInputElement).value).toBe(window.location.port);
  });

  it('an empty port builds the base without the :port', async () => {
    const onSubmit = vi.fn(async () => null as string | null);
    mount(<AddServerModal existingBases={[]} onSubmit={onSubmit} onClose={() => {}} />);
    fill('10.0.0.9', '');
    submit();
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(`${window.location.protocol}//10.0.0.9`, 'admin', 'senha'));
  });

  it('a base already connected shows the inline error and calls nothing', async () => {
    const onSubmit = vi.fn(async () => null as string | null);
    const existing = `${window.location.protocol}//10.0.0.9:7102`;
    mount(<AddServerModal existingBases={[existing]} onSubmit={onSubmit} onClose={() => {}} />);
    fill('10.0.0.9', '7102');
    submit();
    expect(await screen.findByText(labels().t('servers.already_connected'))).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('the login error returned by onSubmit is shown inline and the modal stays open', async () => {
    const onClose = vi.fn();
    mount(<AddServerModal existingBases={[]} onSubmit={async () => 'http 401 · Invalid credentials'} onClose={onClose} />);
    fill('10.0.0.9', '7102');
    submit();
    expect(await screen.findByText('http 401 · Invalid credentials')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
