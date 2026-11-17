import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import CredentialsModal from './CredentialsModal';

const renderModal = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);
const apiErr = (status: number) => Object.assign(new Error('http'), { status });

describe('CredentialsModal (spec editar-credenciais)', () => {
  it('senha abre SEMPRE vazia; login pré-preenchido; Salvar exige senha', () => {
    renderModal(<CredentialsModal cameraName="Cam 1" currentUser="admin" onSave={async () => ({ ok: true })} onClose={() => {}} />);
    expect((screen.getByLabelText('Login') as HTMLInputElement).value).toBe('admin');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect((screen.getByRole('button', { name: 'Save' })).hasAttribute('disabled')).toBe(true);
  });

  it('Salvar chama onSave uma vez com login e senha; sucesso mostra a linha verde e fecha em 1,5 s', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, restarted: true });
    const onClose = vi.fn();
    renderModal(<CredentialsModal cameraName="Cam 1" currentUser="admin" onSave={onSave} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'segredo-novo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith('admin', 'segredo-novo');
    expect(await screen.findByText(/Credential saved/)).toBeInTheDocument();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), { timeout: 2500 }); // 1,5 s reais (E3)
  });

  it('400 do servidor: texto de recusa, modal fica aberta', async () => {
    const onClose = vi.fn();
    renderModal(<CredentialsModal cameraName="Cam 1" currentUser="admin" onSave={() => Promise.reject(apiErr(400))} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/refused these credentials/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
