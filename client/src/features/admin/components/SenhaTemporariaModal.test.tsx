import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import { useEsc } from '@/shared/hooks/useEsc';
import SenhaTemporariaModal from './SenhaTemporariaModal';

// O clipboard da pagina e sempre falso: o teste afirma no que o modal FAZ com o resultado da copia
// (toast de sucesso ou de erro), nao na API do browser.
const renderModal = (over: Partial<React.ComponentProps<typeof SenhaTemporariaModal>> = {}, copiar = vi.fn(async () => {})) => {
  const onClose = vi.fn();
  const notify = vi.fn();
  render(<LanguageProvider><SenhaTemporariaModal username="ana" password="Temp-123456789012345"
    onClose={onClose} notify={notify} copiar={copiar} {...over} /></LanguageProvider>);
  return { onClose, notify, copiar };
};
const valorCampo = () => (screen.getByRole('textbox') as HTMLInputElement).value;

describe('SenhaTemporariaModal', () => {
  it('mostra a senha num campo somente-leitura com o botao de copiar ao lado', () => {
    renderModal();
    const campo = screen.getByRole('textbox') as HTMLInputElement;
    expect(campo.value).toBe('Temp-123456789012345');
    expect(campo.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy password' })).toBeTruthy();
  });

  it('avisa que a senha nao sera exibida de novo e so tem o botao Fechar', () => {
    renderModal();
    expect(screen.getByText('will not be shown again')).toBeTruthy();
    // en (pinned pelo vitest.setup): rodape = shared.close 'Close'; o X do canto tem textContent '✕'
    expect(screen.getAllByRole('button').map((b) => b.textContent?.trim()).sort())
      .toEqual(['Close', '⎘', '✕'].sort());
  });

  it('copia a senha e notifica', async () => {
    const { notify, copiar } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(copiar).toHaveBeenCalledWith('Temp-123456789012345'));
    expect(notify).toHaveBeenCalledWith('Password copied', 'ok');
    expect((screen.getByRole('button', { name: 'Copy password' }).textContent ?? '').trim()).toBe('\u2713');
  });

  it('copia recusada nao esconde a senha: notifica o erro', async () => {
    const { notify } = renderModal({}, vi.fn(async () => { throw new Error('negado'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy password' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Could not copy. Select the text.', 'error'));
    expect(valorCampo()).toBe('Temp-123456789012345');
  });

  it('Fechar e o X fecham', async () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));   // o botao do rodape (shared.close em en)
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }));   // o X do canto
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('o ESC fecha so o modal de cima (pilha do useEsc)', async () => {
    // mesma tecnica do AdminSim de TabelaUsuarios.test.tsx: o handler empilhado por ultimo e o unico chamado
    let baixoFechou = 0;
    const cimaFechou = vi.fn();
    function Casca() {
      // duas correcoes contra o bloco pinado do plano (mesmas chaves, mesma pila):
      // 1) o modal monta DEPOIS do useEsc da casca (no produto ele e irmao montado depois do dialog
      //    de administracao; no mesmo commit, o efeito do filho empilha antes e o ESC pegaria a casca);
      // 2) fechar o de cima o TIRA da pila de verdade — com onClose=vi.fn() puro ele fica no topo
      //    e o segundo ESC jamais chegaria na casca.
      const [aberto, setAberto] = useState(false);
      useEffect(() => { setAberto(true); }, []);
      const fecharCima = () => { cimaFechou(); setAberto(false); };
      useEsc(() => { baixoFechou += 1; });
      return <div><p>administration modal open</p>
        {aberto && <SenhaTemporariaModal username="ana" password="Temp-123456789012345"
          onClose={fecharCima} notify={vi.fn()} copiar={vi.fn(async () => {})} />}</div>;
    }
    render(<LanguageProvider><Casca /></LanguageProvider>);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(cimaFechou).toHaveBeenCalledTimes(1));
    expect(baixoFechou).toBe(0);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(baixoFechou).toBe(1));   // so quando o de cima nao esta mais na pilha
  });
});
