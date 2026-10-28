import { useCallback, useEffect, useRef, useState } from 'react';

// Server-side DataTable (spec 2026-10-20 §5): the SERVER filters, orders and pages. The hook keeps the
// query state and asks for the page; it never sorts or slices a list itself. The `#` column is not a
// `Column`: it is the position INSIDE the page (offset + index) and it does not sort.
export type Column = { key: string; title: string };
export type SortDirection = 'asc' | 'desc';
export type Query = { limit: number; offset: number; text: string; sort: string; dir: SortDirection };

// The default is 10 and the options come from the prototype (spec 4.2).
export const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];
// The search waits for the typing to stop; sorting and paging ask at once (spec §5).
const DEBOUNCE_MS = 300;

export function useDataTable<T>(data: { rows: T[]; total: number }, initialKey: string, onQuery: (q: Query) => void) {
  const [text, setText] = useState('');
  // The text of the LAST request. Typing only debounces; the keystroke itself does not fetch, so the
  // typed text and the queried text are two states.
  const [sent, setSent] = useState('');
  // `key` and `direction` in a SINGLE state: the sort toggle has to be a PURE updater. With two states,
  // `setDirection` INSIDE the `setKey` updater inverted twice when React re-ran the updater (StrictMode
  // in dev, concurrent render replay) and the second click stopped inverting.
  const [sort, setSort] = useState<{ key: string; direction: SortDirection }>({ key: initialKey, direction: 'asc' });
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_OPTIONS[0]);

  const limit = pageSize;
  const offset = (current - 1) * pageSize;
  // A page past the end still owes the total, so the count comes from the server and never from the rows.
  const pages = Math.max(1, Math.ceil(data.total / limit));

  // The callback goes through a ref: the tabs pass a new arrow function on every render, and the effect
  // below must fire on the QUERY change, not on the parent's render.
  const ask = useRef(onQuery);
  ask.current = onQuery;

  const trimmed = text.trim();
  useEffect(() => {
    if (trimmed === sent) return;
    // a new search always starts over at page 1, and both land in the same commit (one request)
    const id = setTimeout(() => { setSent(trimmed); setCurrent(1); }, DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [trimmed, sent]);

  // Mount fetches the first page; every change of limit/offset/text/sort fetches the new one.
  useEffect(() => {
    ask.current({ limit, offset, text: sent, sort: sort.key, dir: sort.direction });
  }, [limit, offset, sent, sort.key, sort.direction]);

  // The total shrank under the open page (a delete on the last page): step back instead of showing an
  // empty page with a footer that says there are rows.
  useEffect(() => { if (current > pages) setCurrent(pages); }, [current, pages]);

  // The first click on a column sorts ascending and the second inverts; switching columns restarts
  // ascending, and everything goes back to page 1 (spec 4.2).
  const sortBy = useCallback((next: string) => {
    setCurrent(1);
    setSort((o) => (o.key === next
      ? { key: next, direction: o.direction === 'asc' ? 'desc' : 'asc' }
      : { key: next, direction: 'asc' }));
  }, []);
  // no page reset here: pasting/clearing text also goes through `onSearch`, so nothing happens while typing
  const onSearch = useCallback((v: string) => setText(v), []);
  const onPageSize = useCallback((n: number) => { setPageSize(n); setCurrent(1); }, []);
  const onDirection = useCallback((d: SortDirection) => { setSort((o) => ({ ...o, direction: d })); setCurrent(1); }, []);
  const onPage = useCallback((p: number) => setCurrent(Math.min(Math.max(1, p), pages)), [pages]);

  return {
    text, onSearch, sortKey: sort.key, direction: sort.direction, sortBy, onDirection,
    page: current, pageSize, pages, onPage, onPageSize,
    rows: data.rows, start: offset, end: offset + data.rows.length,
    total: data.total,
  };
}
