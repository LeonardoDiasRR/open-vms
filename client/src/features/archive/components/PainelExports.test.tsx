import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ExportsPanel from './PainelExports';
import { LanguageProvider } from '@/shared/i18n';
import type { ApiClient, ExportJob } from '@/shared/utils/api';

// spec 2026-10-23 (batch deletion/download, approved prototype): one checkbox per clip, the bar
// Download/Delete only with a selection, no download link per item.
const at = (h: number, m: number) => Math.floor(new Date(2026, 9, 17, h, m).getTime() / 1000);
const JOB_QUEUED: ExportJob = { id: 'j1', camera_name: 'Garagem', from_ts: at(18, 0), to_ts: at(18, 20), state: 'queued' };
const JOB_EXPORTING: ExportJob = { id: 'j2', camera_name: 'Garagem', from_ts: at(18, 26), to_ts: at(19, 6), state: 'exporting', progress: 40 };
const JOB_DONE: ExportJob = { id: 'j3', camera_name: 'Garagem', name: 'Garagem_2026-10-17T1826_2026-10-17T1906.mp4', from_ts: at(18, 26), to_ts: at(19, 6), state: 'ready', bytes: 2048 };
const JOB_DONE2: ExportJob = { id: 'j4', camera_name: 'Entrada', name: 'Entrada_2026-10-17T1900_2026-10-17T1930.mp4', from_ts: at(19, 0), to_ts: at(19, 30), state: 'ready', bytes: 4096 };
const JOB_ERROR: ExportJob = { id: 'j5', camera_name: 'Garagem', from_ts: at(18, 0), to_ts: at(18, 30), state: 'error', error: 'export interrupted by restart' };
const COM_DESC: ExportJob = { ...JOB_DONE, description: 'Fuga pelo portao lateral' };

type FakeApi = Pick<ApiClient, 'base' | 'token' | 'exports' | 'deleteExports' | 'exportsZipUrl'>;
function fake(list: ExportJob[], over: Partial<Record<string, unknown>> = {}): FakeApi {
  return { base: 'http://127.0.0.1:7101', token: 'tk-teste',
    exports: vi.fn(async () => list), deleteExports: vi.fn(async () => ({ deleted: [], missing: [] })),
    exportsZipUrl: vi.fn((ids: string[]) => `http://zip/${ids.join(',')}`), ...over } as unknown as FakeApi;
}
const box = (name: string) => screen.getByRole('checkbox', { name });

describe('ExportsPanel (selecao em lote)', () => {
  it('a lista vazia diz "No exports" e nao mostra a barra', async () => {
    render(<ExportsPanel api={fake([])} tick={0} />, { wrapper: LanguageProvider });
    expect(await screen.findByText('No exports')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
  });

  it('os 4 estados continuam com os rotulos do pedido', async () => {
    render(<ExportsPanel api={fake([JOB_QUEUED, JOB_EXPORTING, JOB_DONE, JOB_ERROR])} tick={0} />, { wrapper: LanguageProvider });
    expect(await screen.findByText('Queued…')).toBeInTheDocument();
    expect(screen.getByText(/Exporting… 40%/)).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    // the long error (ffmpeg stderr) stays in the title. The line shows the short label.
    // spec 2026-10-23: the card label is short ('Failed'); the stderr goes in the title.
    const error = screen.getByText('Failed');
    expect(error).toHaveAttribute('title', 'export interrupted by restart');
  });

  it('cada clipe concluido tem checkbox; a barra so aparece com selecao', async () => {
    render(<ExportsPanel api={fake([JOB_DONE, JOB_DONE2])} tick={0} />, { wrapper: LanguageProvider });
    await screen.findByText(/Garagem_2026-10-17T1826/);
    expect(screen.queryByRole('button', { name: 'Download 1' })).toBeNull();
    fireEvent.click(box('Select Garagem_2026-10-17T1826_2026-10-17T1906.mp4'));
    expect(await screen.findByRole('button', { name: 'Download 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 1' })).toBeInTheDocument();
    expect(screen.getByText('1 selected')).toBeInTheDocument();
  });

  it('"All" marca e desmarca tudo, com estado parcial', async () => {
    render(<ExportsPanel api={fake([JOB_DONE, JOB_DONE2])} tick={0} />, { wrapper: LanguageProvider });
    await screen.findByText(/Garagem_2026-10-17T1826/);
    fireEvent.click(box('All'));
    expect(await screen.findByRole('button', { name: 'Download 2' })).toBeInTheDocument();
    fireEvent.click(box('Select Garagem_2026-10-17T1826_2026-10-17T1906.mp4'));
    expect(screen.getByRole('button', { name: 'Download 1' })).toBeInTheDocument();
    expect((box('All') as HTMLInputElement).indeterminate).toBe(true);
    // partial + click on All = check everything (do not clear). With everything checked, the click clears.
    fireEvent.click(box('All'));
    expect(await screen.findByRole('button', { name: 'Download 2' })).toBeInTheDocument();
    fireEvent.click(box('All'));
    expect(screen.queryByRole('button', { name: /^Download/ })).toBeNull();
  });

  it('Excluir confirma com os nomes e chama o servidor', async () => {
    const api = fake([JOB_DONE]);
    render(<ExportsPanel api={api} tick={0} />, { wrapper: LanguageProvider });
    await screen.findByText(/Garagem_2026-10-17T1826/);
    fireEvent.click(box('Select Garagem_2026-10-17T1826_2026-10-17T1906.mp4'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }));
    const dialogo = await screen.findByRole('dialog');
    expect(within(dialogo).getByText('Delete exports')).toBeInTheDocument();
    expect(within(dialogo).getByText(/Garagem_2026-10-17T1826_2026-10-17T1906\.mp4/)).toBeInTheDocument();
    fireEvent.click(within(dialogo).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.deleteExports).toHaveBeenCalledWith(['j3']));
  });

  it('Baixar abre a URL do pacote com os ids', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const api = fake([JOB_DONE]);
    render(<ExportsPanel api={api} tick={0} />, { wrapper: LanguageProvider });
    await screen.findByText(/Garagem_2026-10-17T1826/);
    fireEvent.click(box('Select Garagem_2026-10-17T1826_2026-10-17T1906.mp4'));
    fireEvent.click(await screen.findByRole('button', { name: 'Download 1' }));
    expect(api.exportsZipUrl).toHaveBeenCalledWith(['j3']);
    expect(open).toHaveBeenCalledWith('http://zip/j3', '_blank');
    open.mockRestore();
  });

  it('409 do servidor mantem a selecao e avisa', async () => {
    const api = fake([JOB_DONE], {
      deleteExports: vi.fn(async () => { throw Object.assign(new Error('export_active'), { status: 409 }); }) });
    render(<ExportsPanel api={api} tick={0} />, { wrapper: LanguageProvider });
    await screen.findByText(/Garagem_2026-10-17T1826/);
    fireEvent.click(box('Select Garagem_2026-10-17T1826_2026-10-17T1906.mp4'));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete 1' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/still being generated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete 1' })).toBeInTheDocument();
  });

  // plan 2026-10-23: card in three lines — description, camera, period + size.
  it('o card mostra descricao, camera e periodo+tamanho em linhas distintas', async () => {
    render(<ExportsPanel api={fake([COM_DESC])} tick={0} />, { wrapper: LanguageProvider });
    const desc = await screen.findByText('Fuga pelo portao lateral');
    const cam = screen.getByText('Garagem');
    const per = screen.getByText(/17\/10 18:26–19:06 · 2 KB/);
    // jsdom does no layout (every rect is 0x0): the order of the three lines is proven by the DOM.
    const anterior = (a: HTMLElement, b: HTMLElement) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(anterior(desc, cam)).toBe(true);
    expect(anterior(cam, per)).toBe(true);
  });

  it('a descricao leva o texto completo em data-dica (fonte do tooltip)', async () => {
    const { container } = render(<ExportsPanel api={fake([COM_DESC])} tick={0} />, { wrapper: LanguageProvider });
    const span = await waitFor(() => {
      const el = container.querySelector('.painel-exports-nome-texto') as HTMLElement | null;
      if (!el) throw new Error('a descricao ainda nao montou');
      return el;
    });
    expect(span.getAttribute('data-dica')).toBe(COM_DESC.description);
    // the chip stays on the SAME line as the description (child of .painel-exports-nome)
    expect(span.parentElement?.querySelector('.badge')).not.toBeNull();
  });

  it('sem descricao, a primeira linha mostra o nome tecnico', async () => {
    render(<ExportsPanel api={fake([JOB_DONE])} tick={0} />, { wrapper: LanguageProvider });
    expect(await screen.findByText('Garagem_2026-10-17T1826_2026-10-17T1906.mp4')).toBeInTheDocument();
  });

  it('o tamanho sai humanizado', async () => {
    const GRANDE: ExportJob = { ...JOB_DONE, description: 'Chegada', bytes: 4102000 };
    render(<ExportsPanel api={fake([GRANDE])} tick={0} />, { wrapper: LanguageProvider });
    expect(await screen.findByText(/3,91 MB/)).toBeInTheDocument();
  });

  // defect 2026-10-25: without a reload, a new export did not appear in the panel. The App signals
  // by incrementing the tick, which is a dependency of the fetch effect.
  it('busca de novo quando o tick muda (o App avisa a criacao de exportacao assim)', async () => {
    const api = fake([JOB_DONE]);
    const { rerender } = render(<ExportsPanel api={api} tick={0} />, { wrapper: LanguageProvider });
    await waitFor(() => expect(api.exports).toHaveBeenCalledTimes(1));
    rerender(<ExportsPanel api={api} tick={1} />);
    await waitFor(() => expect(api.exports).toHaveBeenCalledTimes(2));
  });
});
