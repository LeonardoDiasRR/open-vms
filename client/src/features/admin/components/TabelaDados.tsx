import type { ReactNode } from 'react';
import SearchField from '@/shared/ui/SearchField';
import { Button } from '@/shared/ui/button';
import { useT } from '@/shared/i18n';
import { useDataTable, PAGE_SIZE_OPTIONS, type Column, type Query } from '../hooks/useTabelaDados';

// The data table of both Administration tabs (spec 2026-10-18 4.2; server-side since 2026-10-20 §5). It
// knows neither user nor profile: it takes the CURRENT page, the total and the sortable columns, and it
// asks for another page through `onQuery`. Search, sorting and paging happen in the database.
//
// On a phone the SAME markup becomes a card: `block md:table` on the table, `md:table-row` on the tr
// and `md:table-cell` on the td, with the column title inside the cell (`.md:hidden`). One markup, not
// two lists — duplicated text in the DOM would break whoever looks for `ana` or `system` by text.
export type { Column };

type Props<T> = {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  // Label of the actions column: when present, the table emits a final NON-sortable `<th>`. Without it
  // the header had one column less than the row (which always has the actions `<td>`) and the `colSpan`
  // of the empty state came up short.
  actions?: string;
  columns: Column[];
  // the page the server sent and the total of the FILTERED set (spec §5)
  rows: T[];
  total: number;
  onQuery: (q: Query) => void;
  initialKey: string;
  // ponytail: `rowKey`, not `key` — React owns the `key` prop name
  rowKey: (item: T) => string;
  row: (item: T) => ReactNode;
  empty: string;
};

// The cell is the `<td>` of both tabs: on a phone it stacks the label and the content; from `md` it
// goes back to being a table cell.
export function Cell({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <td className={`flex items-center gap-2 border-b border-border px-1 py-1 align-top md:table-cell md:border-0 md:px-1.5 md:py-0 ${className ?? ''}`}>
      {/* The label disappears from `md` on; `mr-auto` pushes the content to the right in the card. It does
          NOT wrap the content in its own element: a wrapper with the same text would break exact-text
          searches (`ana`, `system`). */}
      <span className="mr-auto text-xs text-muted-foreground md:hidden">{label}</span>
      {children}
    </td>
  );
}

export default function DataTable<T>({ title, subtitle, action, actions, columns, rows, total, onQuery, initialKey, rowKey, row, empty }: Props<T>) {
  const t = useT().t;
  const table = useDataTable({ rows, total }, initialKey, onQuery);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h3 className="text-sm font-semibold">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        {action}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {/* spec 2026-10-18 (tabs): search at 1/3 of the row, field on the left. The wrapper div uses a
            utility because div has no conflicting global rule (the cascade trap is only button/
            input/.nx-input). The "N record(s)" left the search footer by the operator's decision. */}
        <div className="w-full md:w-1/3">
          <SearchField value={table.text} onChange={table.onSearch} label={t('admin.search_all')} />
        </div>
        {/* On a phone there is no title row: sorting comes from these two selects */}
        <select className="nx-input nx-largura-auto md:hidden" aria-label={t('admin.sort_by')} value={table.sortKey} onChange={(e) => table.sortBy(e.target.value)}>
          {columns.map((c) => <option key={c.key} value={c.key}>{c.title}</option>)}
        </select>
        <select className="nx-input nx-largura-auto md:hidden" aria-label={t('admin.direction')} value={table.direction} onChange={(e) => table.onDirection(e.target.value === 'desc' ? 'desc' : 'asc')}>
          <option value="asc">{t('admin.ascending')}</option>
          <option value="desc">{t('admin.descending')}</option>
        </select>
      </div>

      <table className="nx-table block w-full md:table">
        <thead className="hidden md:table-header-group">
          <tr>
            <th className="w-8 text-right">#</th>
            {columns.map((c) => (
              <th key={c.key}
                aria-sort={table.sortKey === c.key ? (table.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                <button type="button" className="uppercase"
                  onClick={() => table.sortBy(c.key)}>
                  {c.title}{table.sortKey === c.key ? (table.direction === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
            ))}
            {/* The actions column does not sort: no button and no `aria-sort`. */}
            {/* spec coluna-acoes-centrada 2026-10-18: fixed width (11rem) so the column does not
                swallow the automatic layout's leftovers; centered title and no wrap. */}
            {actions && <th className="w-44 text-center whitespace-nowrap">{actions}</th>}
          </tr>
        </thead>
        <tbody className="block md:table-row-group">
          {table.rows.length === 0 && (
            <tr className="block md:table-row">
              <td className="block px-1 py-2 text-muted-foreground md:table-cell" colSpan={columns.length + 1 + (actions ? 1 : 0)}>{empty}</td>
            </tr>
          )}
          {table.rows.map((item, i) => (
            <tr key={rowKey(item)} className="mb-2 block rounded-md border border-border p-2 md:mb-0 md:table-row md:rounded-none md:border-0 md:p-0">
              <td className="hidden text-right text-muted-foreground md:table-cell">{table.start + i + 1}</td>
              {row(item)}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {/* spec 2026-10-18 (tabs): "Show [N] of X" on the left, without the A-B range (operator's
            decision), X = total after the filter (table.total). The select lives INSIDE role="status":
            its textContent is the oracle "Show 10 of 12" (plan amendment 2). nx-largura-auto is the
            two-class rule — the w-auto utility does NOT beat the global .nx-input. */}
        <span role="status" className="mr-auto flex items-center gap-2">
          {t('admin.show')}
          <select className="nx-input nx-largura-auto" aria-label={t('admin.rows_per_page')} value={table.pageSize}
            onChange={(e) => table.onPageSize(Number(e.target.value))}>
            {PAGE_SIZE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          {t('admin.of_total', { total: table.total })}
        </span>
        <Button variant="ghost" size="icon-xs" aria-label={t('admin.first_page')} disabled={table.page === 1} onClick={() => table.onPage(1)}>«</Button>
        <Button variant="ghost" size="icon-xs" aria-label={t('admin.previous_page')} disabled={table.page === 1} onClick={() => table.onPage(table.page - 1)}>‹</Button>
        <span>{t('admin.page_of', { page: table.page, pages: table.pages })}</span>
        <Button variant="ghost" size="icon-xs" aria-label={t('admin.next_page')} disabled={table.page === table.pages} onClick={() => table.onPage(table.page + 1)}>›</Button>
        <Button variant="ghost" size="icon-xs" aria-label={t('admin.last_page')} disabled={table.page === table.pages} onClick={() => table.onPage(table.pages)}>»</Button>
      </div>
    </div>
  );
}
