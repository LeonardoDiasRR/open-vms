import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDataTable, PAGE_SIZE_OPTIONS, type Column } from './useTabelaDados';

// spec 2026-10-20 §5: the hook no longer filters, sorts or slices — it ASKS the server. What is pinned
// here is the query contract (offset/limit/sort/dir/text and the 300 ms debounce), not a local list.
type Row = { name: string };
const ROWS: Row[] = [{ name: 'ana' }, { name: 'bia' }];
const COLUMNS: Column[] = [
  { key: 'name', title: 'Name' },
  { key: 'kind', title: 'Kind' },
  { key: 'count', title: 'Count' },
];
const FIRST = { limit: 10, offset: 0, text: '', sort: 'name', dir: 'asc' as const };

const render = (total = 42) => {
  const onQuery = vi.fn();
  const utils = renderHook(({ total }) => useDataTable({ rows: ROWS, total }, 'name', onQuery),
    { initialProps: { total } });
  return { onQuery, ...utils };
};

describe('useDataTable (server-side, spec 2026-10-20 §5)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('asks for the first page on mount, with the initial column ascending', () => {
    const { onQuery } = render();
    expect(onQuery).toHaveBeenCalledTimes(1);
    expect(onQuery).toHaveBeenCalledWith(FIRST);
  });

  it('the page size is 10 and the options stay [10, 20, 50, 100]', () => {
    expect(PAGE_SIZE_OPTIONS).toEqual([10, 20, 50, 100]);
    const { result } = render();
    expect(result.current.pageSize).toBe(10);
  });

  it('paging turns the page into limit/offset', () => {
    const { result, onQuery } = render();
    expect(result.current.pages).toBe(5); // 42 rows of 10
    act(() => result.current.onPage(3));
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, offset: 20 });
    expect(result.current.page).toBe(3);
    // the footer's numbers come from the offset and the rows of the page
    expect([result.current.start, result.current.end, result.current.total]).toEqual([20, 22, 42]);
    // out of range is clamped to the ends
    act(() => result.current.onPage(99));
    expect(result.current.page).toBe(5);
  });

  it('changing the page size goes back to page 1', () => {
    const { result, onQuery } = render();
    act(() => result.current.onPage(3));
    act(() => result.current.onPageSize(20));
    expect(result.current.page).toBe(1);
    expect(result.current.pageSize).toBe(20);
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, limit: 20 });
    expect(result.current.pages).toBe(3); // 42 / 20
  });

  it('the first click sorts ascending, the second inverts, another column restarts ascending', () => {
    const { result, onQuery } = render();
    act(() => result.current.sortBy('count'));
    expect(result.current.direction).toBe('asc');
    expect(result.current.sortKey).toBe('count');
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, sort: 'count' });
    act(() => result.current.sortBy('count'));
    expect(result.current.direction).toBe('desc');
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, sort: 'count', dir: 'desc' });
    act(() => result.current.sortBy('kind'));
    expect(result.current.direction).toBe('asc');
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, sort: 'kind' });
  });

  it('sorting does not touch the column already in use when only the direction changes', () => {
    const { result, onQuery } = render();
    act(() => result.current.onPage(2));
    act(() => result.current.onDirection('desc'));
    expect(result.current.sortKey).toBe('name');
    expect(result.current.page).toBe(1); // a new order starts over at page 1
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, dir: 'desc' });
  });

  it('the search is debounced by 300 ms and only the last keystroke is requested', () => {
    const { result, onQuery } = render();
    act(() => result.current.onSearch('a'));
    act(() => vi.advanceTimersByTime(200));
    expect(onQuery).toHaveBeenCalledTimes(1); // still the mount call
    act(() => result.current.onSearch('an'));
    act(() => vi.advanceTimersByTime(299));
    expect(onQuery).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1));
    expect(onQuery).toHaveBeenCalledTimes(2);
    expect(onQuery).toHaveBeenLastCalledWith({ ...FIRST, text: 'an' });
    // the same text again does not spend another request
    act(() => result.current.onSearch('an'));
    act(() => vi.advanceTimersByTime(300));
    expect(onQuery).toHaveBeenCalledTimes(2);
    // clearing goes back to the unfiltered first page
    act(() => result.current.onPage(2));
    act(() => result.current.onSearch(''));
    act(() => vi.advanceTimersByTime(300));
    expect(onQuery).toHaveBeenLastCalledWith(FIRST);
  });

  it('the total shrinking under the open page steps back to the last page', () => {
    const { result, rerender } = render();
    act(() => result.current.onPage(5));
    expect(result.current.page).toBe(5);
    rerender({ total: 12 }); // a delete emptied the tail
    expect(result.current.pages).toBe(2);
    expect(result.current.page).toBe(2);
  });

  it('the rows and the total come from the server as they arrived', () => {
    const { result } = render(2);
    expect(result.current.rows).toEqual(ROWS);
    expect(result.current.total).toBe(2);
    expect(result.current.pages).toBe(1);
  });
});
