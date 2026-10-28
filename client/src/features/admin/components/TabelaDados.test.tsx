import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import DataTable, { type Column } from './TabelaDados';

type Row = { name: string };
const columns: Column[] = [{ key: 'name', title: 'Name' }];
const rows: Row[] = Array.from({ length: 12 }, (_, i) => ({ name: `u${String(i + 1).padStart(2, '0')}` }));

// The table no longer owns the list: it shows the page it was given and asks for the next one.
const renderTable = (actions?: string, onQuery = vi.fn()) => ({
  onQuery,
  ...render(
    <LanguageProvider>
      <DataTable title="T" columns={columns} rows={rows} total={12} onQuery={onQuery}
        initialKey="name" rowKey={(r) => r.name}
        empty="empty" row={(r) => <td>{r.name}</td>} actions={actions} />
    </LanguageProvider>,
  ),
});

// The select textContent concatenates ALL options; the readable text is the direct nodes + the
// selected value (plan amendment 3).
const statusText = (el: HTMLElement) => [...el.childNodes]
  .map((n) => (n instanceof HTMLSelectElement ? ` ${n.value} ` : n.textContent ?? ''))
  .join('').replace(/\s+/g, ' ').trim();

describe('DataTable (server-side page: 2026-10-20 §5 keeps the 2026-10-18 markup)', () => {
  it('the search lives in a one-third wrapper aligned to the left', async () => {
    renderTable();
    const field = await screen.findByLabelText('Search all columns');
    // closest('div') is .busca itself; the wrapper is .busca's PARENT
    expect(field.closest('.busca')?.parentElement?.className).toContain('md:w-1/3');
  });

  it('the "N record(s)" text is gone from the search row', async () => {
    renderTable();
    await screen.findByLabelText('Search all columns');
    expect(screen.queryByText(/\d+ records?/)).toBeNull();
  });

  it('footer: Show [N] of X on the left, pagination on the right, no A-B range', async () => {
    renderTable();
    const status = await screen.findByRole('status');
    expect(statusText(status)).toBe('Show 10 of 12');
    expect(screen.queryByText(/1–10/)).toBeNull();
    expect(status.querySelector('select')?.getAttribute('aria-label')).toBe('Rows per page');
    const sel = status.querySelector('select')!;
    expect([...sel.options].map((o) => o.value)).toEqual(['10', '20', '50', '100']);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  // spec 2026-10-19 (padrao-select): nx-largura-auto is a house contract — the w-auto utility
  // loses to the element's global rule (select becomes width: 100% when closed).
  it('the two phone sorting selects use nx-largura-auto', async () => {
    renderTable();
    for (const name of ['Sort by', 'Direction']) {
      const sel = await screen.findByLabelText(name) as HTMLSelectElement;
      expect(sel.className).toContain('nx-largura-auto');
    }
  });

  it('changing N in the footer asks the server for a new page without losing the total', async () => {
    const { onQuery } = renderTable();
    const sel = (await screen.findByRole('status')).querySelector('select')!;
    fireEvent.change(sel, { target: { value: '20' } });
    expect(onQuery).toHaveBeenLastCalledWith({ limit: 20, offset: 0, text: '', sort: 'name', dir: 'asc' });
    // the total is the server's, so it does not depend on the page size
    expect(statusText(screen.getByRole('status'))).toBe('Show 20 of 12');
  });

  it('the title of a column orders through the server; the actions column does not sort', async () => {
    const { onQuery } = renderTable('Actions');
    const header = screen.getByRole('columnheader', { name: /Name/ });
    fireEvent.click(within(header).getByRole('button'));
    expect(onQuery).toHaveBeenLastCalledWith({ limit: 10, offset: 0, text: '', sort: 'name', dir: 'desc' });
    expect(header.getAttribute('aria-sort')).toBe('descending');
    const actions = screen.getByRole('columnheader', { name: 'Actions' });
    expect(actions.querySelector('button')).toBeNull();
  });

  // spec 2026-10-18 (coluna-acoes-centrada): the actions th declares a fixed width (w-44 = 176 px,
  // above the 164 px of content from the 4 buttons measured in the probe) and a centered title.
  it('the actions th has w-44 and a centered title', async () => {
    renderTable('Actions');
    const th = screen.getByRole('columnheader', { name: 'Actions' });
    expect(th.textContent).toBe('Actions');
    expect(th).toHaveClass('w-44', 'text-center');
  });
});
