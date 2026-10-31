import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import UsersTable from './TabelaUsuarios';
import { useEsc } from '@/shared/hooks/useEsc';
import type { User, AccessProfile, UsersQuery } from '@/shared/utils/api';

const profiles: AccessProfile[] = [
  { id: 'admin', name: 'admin', kind: 'system', grants_count: 0 },
  { id: 'p1', name: 'Portaria', kind: 'custom', grants_count: 1 },
];
// spec 2026-10-20 §5: the row carries the profile NAME (the JOIN), not just the id
const users: User[] = [
  { username: 'admin', profile_id: 'admin', profile_name: 'admin', status: 'active', must_change_password: false },
  { username: 'ana', profile_id: 'p1', profile_name: 'Portaria', status: 'active', must_change_password: true },
];
const twelve = (): User[] => Array.from({ length: 12 }, (_, i) => ({
  username: `u${String(i + 1).padStart(2, '0')}`, profile_id: 'p1', profile_name: 'Portaria',
  status: 'active', must_change_password: false,
}));

// The page envelope `{ items, total, limit, offset }` of the server (spec §5).
const envelope = <T,>(items: T[], q: { limit?: number; offset?: number } = {}) => ({
  items, total: items.length, limit: q.limit ?? 10, offset: q.offset ?? 0,
});
// A fake SERVER with the same contract as the route: substring search over the visible text and the
// closed sort list, over the filtered set (the table no longer filters anything itself).
function pagedUsers(all: User[], q: UsersQuery = {}) {
  const needle = (q.q ?? '').toLowerCase();
  const hit = all
    .filter((u) => !needle || [u.username, u.status, u.profile_name ?? '']
      .some((v) => v.toLowerCase().includes(needle)))
    .filter((u) => !q.status || u.status === q.status);
  const key = (u: User) => (q.sort === 'profile' ? u.profile_name ?? '' : q.sort === 'status' ? u.status : u.username);
  const sign = q.dir === 'desc' ? -1 : 1;
  const sorted = [...hit].sort((a, b) => sign * key(a).localeCompare(key(b)) || a.username.localeCompare(b.username));
  const offset = q.offset ?? 0;
  const limit = q.limit ?? 10;
  return { items: sorted.slice(offset, offset + limit), total: sorted.length, limit, offset };
}

function fakeApi(over: Partial<Record<string, unknown>> = {}) {
  return {
    users: vi.fn(async (q: UsersQuery = {}) => pagedUsers(users, q)),
    accessProfiles: vi.fn(async () => envelope(profiles)),
    createUser: vi.fn(async (b: { username: string; profile_id: string }) => ({ username: b.username, profile_id: b.profile_id, status: 'active', must_change_password: true })),
    patchUser: vi.fn(async () => users[1]),
    renameUser: vi.fn(async (from: string, to: string) => ({ username: to, profile_id: 'p1', status: 'active', must_change_password: true })),
    deleteUser: vi.fn(async () => ({ deleted: 'ana' })),
    resetPassword: vi.fn(async () => ({ username: 'ana', temporary_password: 'Temp-123456789012345', must_change_password: true })),
    ...over,
  };
}
const dlgOk = { confirm: vi.fn(async () => true), ask: vi.fn(async () => 'x'), request: null, setRequest: vi.fn() };
const notify = vi.fn();

// The fake Administration modal: it only exists to prove the form's Escape does NOT close the one
// under it (the useEsc stack closes only the top).
function AdminSim() {
  const [open, setOpen] = useState(true);
  useEsc(() => setOpen(false));
  return open ? <p>administration modal open</p> : null;
}

// plan amendment 3: the select textContent concatenates the options; the readable text uses the selected value
const statusText = (el: HTMLElement) => [...el.childNodes]
  .map((n) => (n instanceof HTMLSelectElement ? ` ${n.value} ` : n.textContent ?? ''))
  .join('').replace(/\s+/g, ' ').trim();

const renderTable = (api = fakeApi(), dlg = dlgOk) =>
  render(<LanguageProvider><UsersTable api={api as never} dlg={dlg as never} notify={notify} /></LanguageProvider>);

describe('UsersTable (spec 2026-10-18 4.3; server-side since 2026-10-20 §5)', () => {
  it('lists the profile NAME from the JOIN, the status badge and the pending change mark', async () => {
    renderTable();
    const anaRow = (await screen.findByText('ana')).closest('tr')!;
    expect(anaRow.textContent).toContain('Portaria');
    expect(anaRow.textContent).toContain('active');
    expect(anaRow.textContent).toContain('change pending');
    expect(anaRow.textContent).not.toContain('p1');
  });

  it('mount asks the server for the first page with the initial column', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    expect(api.users).toHaveBeenCalledWith({ limit: 10, offset: 0, q: '', sort: 'username', dir: 'asc' });
  });

  it('clicking the title sorts on the server and aria-sort follows', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    const header = screen.getByRole('columnheader', { name: /Username/ });
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getAllByRole('row')[1].textContent).toContain('admin');
    fireEvent.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    await waitFor(() => expect(screen.getAllByRole('row')[1].textContent).toContain('ana'));
    // the order travels as sort+dir, never as a local comparison
    expect(api.users).toHaveBeenLastCalledWith({ limit: 10, offset: 0, q: '', sort: 'username', dir: 'desc' });
    const other = screen.getByRole('columnheader', { name: /Profile/ });
    fireEvent.click(within(other).getByRole('button'));
    expect(other.getAttribute('aria-sort')).toBe('ascending');
    expect(header.getAttribute('aria-sort')).toBe('none');
    expect(api.users).toHaveBeenLastCalledWith({ limit: 10, offset: 0, q: '', sort: 'profile', dir: 'asc' });
  });

  it('the header has one column for each cell of the row (the actions one does not sort)', async () => {
    renderTable();
    await screen.findByText('ana');
    const header = screen.getAllByRole('row')[0];
    // the sorted column label carries the arrow; the Actions one does not — it does not sort
    expect([...header.querySelectorAll('th')].map((th) => th.textContent))
      .toEqual(['#', 'Username ↑', 'Profile', 'Status', 'Actions']);
    expect(screen.getByText('ana').closest('tr')!.querySelectorAll('td').length).toBe(5);
    // the actions column does not sort: no button, no `aria-sort`
    const actions = screen.getByRole('columnheader', { name: 'Actions' });
    expect(actions.querySelector('button')).toBeNull();
    expect(actions.getAttribute('aria-sort')).toBeNull();
  });

  it('the empty state fills every column (the colSpan counts the actions one)', async () => {
    renderTable(fakeApi({ users: vi.fn(async (q: UsersQuery = {}) => pagedUsers([], q)) }));
    const empty = await screen.findByText('No users found.');
    expect(empty.getAttribute('colspan')).toBe('5');
  });

  it('the search asks the server (debounced) and the field X clears it', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    // 3 rows = the header + admin + ana; the filter leaves the header + ana
    expect(screen.getAllByRole('row').length).toBe(3);
    const search = screen.getByLabelText('Search all columns');
    fireEvent.change(search, { target: { value: 'portaria' } });
    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(2));
    expect(screen.getByText('ana')).toBeInTheDocument();
    expect(api.users).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'portaria', offset: 0 }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(screen.getAllByRole('row').length).toBe(3));
    expect(api.users).toHaveBeenLastCalledWith(expect.objectContaining({ q: '' }));
  });

  it('the footer shows the count and the 4 buttons disable at the ends', async () => {
    renderTable(fakeApi({ users: vi.fn(async (q: UsersQuery = {}) => pagedUsers(twelve(), q)) }));
    await screen.findByText('u01');
    expect(statusText(screen.getByRole('status'))).toBe('Show 10 of 12');
    expect(screen.getByRole('button', { name: 'First page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    // "Show 10 of 12" is the SAME on both pages and does not discriminate: the turn is stated by the number
    await waitFor(() => expect(screen.getByText('Page 2 of 2')).toBeInTheDocument());
    expect(statusText(screen.getByRole('status'))).toBe('Show 10 of 12');
    expect(screen.getByText('u11')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Last page' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'First page' })).not.toBeDisabled();
  });

  it('the "+ New user" button opens the form', async () => {
    renderTable();
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    expect(screen.getByRole('dialog', { name: 'New user' })).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('the form select takes the whole profile list (limit 100), not the table page', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    expect(api.accessProfiles).toHaveBeenCalledWith({ limit: 100 });
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Portaria' })).toBeInTheDocument());
  });

  it('saving the new one calls createUser with username, password and profile_id (never with a role)', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bia' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'good-strong-password' } });
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createUser)
      .toHaveBeenCalledWith({ username: 'bia', password: 'good-strong-password', profile_id: 'p1' }));
    expect(screen.queryByRole('dialog', { name: 'New user' })).toBeNull();
  });

  it('saving re-reads the page it was on (offset is preserved)', async () => {
    const api = fakeApi({ users: vi.fn(async (q: UsersQuery = {}) => pagedUsers(twelve(), q)) });
    renderTable(api);
    await screen.findByText('u01');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await screen.findByText('u11');
    api.users.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Block u11' }));
    await waitFor(() => expect(api.users).toHaveBeenCalledWith(expect.objectContaining({ offset: 10 })));
  });

  it('editing with the name changed calls renameUser with the old and the new name', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Edit ana' }));
    const field = screen.getByLabelText('Username');
    fireEvent.change(field, { target: { value: 'ana-silva' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renameUser).toHaveBeenCalledWith('ana', 'ana-silva'));
    expect(api.patchUser).not.toHaveBeenCalled();
  });

  it('editing only the profile calls patchUser and does NOT call renameUser', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Edit ana' }));
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchUser).toHaveBeenCalledWith('ana', { profile_id: 'admin' }));
    expect(api.renameUser).not.toHaveBeenCalled();
  });

  it('saving the edit with no change calls no server and does not claim it updated', async () => {
    notify.mockClear();
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Edit ana' }));
    // open, touch nothing and save: no rename, no PATCH and no "updated" notice
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit ana' })).toBeNull());
    expect(api.renameUser).not.toHaveBeenCalled();
    expect(api.patchUser).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('if the PATCH fails after the rename, the retry insists on the PATCH only — never on the old rename', async () => {
    const patchUser = vi.fn()
      .mockRejectedValueOnce(new Error('500: could not save the user'))
      .mockResolvedValueOnce({ username: 'ana-silva' });
    const api = fakeApi({ patchUser });
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Edit ana' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'ana-silva' } });
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/500: could not save/)).toBeInTheDocument();
    // the rename was ALREADY applied: the form now has the new name as baseline
    expect(screen.getByRole('dialog', { name: 'Edit ana-silva' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patchUser).toHaveBeenCalledTimes(2));
    // the retry talks to the NEW name; `renameUser('ana', ...)` again would be a 400 and would lock the edit
    expect(api.renameUser).toHaveBeenCalledTimes(1);
    expect(api.renameUser).toHaveBeenCalledWith('ana', 'ana-silva');
    expect(patchUser).toHaveBeenLastCalledWith('ana-silva', { profile_id: 'admin' });
  });

  it('blocking sends status disabled', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Block ana' }));
    await waitFor(() => expect(api.patchUser).toHaveBeenCalledWith('ana', { status: 'disabled' }));
  });

  it('delete goes through dlg and does not delete when the answer is no', async () => {
    const api = fakeApi();
    const dlg = { ...dlgOk, confirm: vi.fn(async () => false) };
    renderTable(api, dlg);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Delete ana' }));
    await waitFor(() => expect(dlg.confirm).toHaveBeenCalled());
    expect(api.deleteUser).not.toHaveBeenCalled();
  });

  it('the reset shows the temporary password once, in the toast', async () => {
    notify.mockClear();
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: 'Reset password for ana' }));
    await waitFor(() => expect(api.resetPassword).toHaveBeenCalledWith('ana'));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('Temp-123456789012345')));
    // the screen body does NOT keep the temporary one: it lives in the toast, which is what goes away by itself
    expect(screen.queryByText(/Temp-123456789012345/)).toBeNull();
  });

  it('the server 400 shows up, without the client reimplementing the policy', async () => {
    const api = fakeApi({
      createUser: vi.fn(async () => { throw Object.assign(new Error('400: password must have at least 6 characters'), { status: 400 }); }),
    });
    renderTable(api);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'bia' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'short' } });
    fireEvent.change(screen.getByLabelText('Profile'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/password must have at least 6/)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'New user' })).toBeInTheDocument();
  });

  it('Escape closes the form and does not close the Administration modal', async () => {
    render(<LanguageProvider><AdminSim /><UsersTable api={fakeApi() as never} dlg={dlgOk as never} notify={notify} /></LanguageProvider>);
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    expect(screen.getByRole('dialog', { name: 'New user' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New user' })).toBeNull());
    expect(screen.getByText('administration modal open')).toBeInTheDocument();
  });

  it('the green CTA and the per-type hover classes on the actions (spec 2026-10-18 tabs)', async () => {
    renderTable();
    await screen.findByText('ana');
    expect(screen.getByRole('button', { name: '+ New user' })).toHaveClass('nx-btn');
    const row = screen.getByText('ana').closest('tr')!;
    expect(screen.getByRole('button', { name: 'Edit ana' })).toHaveClass('nx-acao-editar');
    expect(screen.getByRole('button', { name: 'Block ana' })).toHaveClass('nx-acao-bloquear');
    expect(screen.getByRole('button', { name: 'Reset password for ana' })).toHaveClass('nx-acao-reset');
    expect(screen.getByRole('button', { name: 'Delete ana' })).toHaveClass('nx-acao-excluir');
    expect(row.querySelector('.justify-center.gap-3')?.className).toContain('gap-3');
  });

  // spec 2026-10-18 (admin-imutavel): the root admin row offers no editing, blocking or deletion.
  it('the root admin row: Edit/Block/Delete disabled; reset active', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('ana');
    // the action button names are unique per user; finding the row by the text 'admin' would also match
    // the Profile column (the system profile is named 'admin')
    for (const name of ['Edit admin', 'Block admin', 'Delete admin']) {
      const b = screen.getByRole('button', { name });
      expect(b).toBeDisabled();
      fireEvent.click(b);
    }
    expect(api.patchUser).not.toHaveBeenCalled();
    expect(api.deleteUser).not.toHaveBeenCalled();
    const reset = screen.getByRole('button', { name: 'Reset password for admin' });
    expect(reset).not.toBeDisabled();
    fireEvent.click(reset);
    await waitFor(() => expect(api.resetPassword).toHaveBeenCalledWith('admin'));
  });

  // the desktop gap does not come from the td (table-cell ignores gap): the buttons live in a flex wrapper
  it('the action buttons live in a flex w-full gap-3 wrapper inside the cell', async () => {
    renderTable();
    await screen.findByText('ana');
    const cell = screen.getByText('ana').closest('tr')!.querySelectorAll('td')[4]!;
    const wrapper = cell.querySelector(':scope > span.flex.w-full.items-center.justify-center.gap-3');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelectorAll('button').length).toBe(4);
  });

  // spec 2026-10-27: the create-user modal password carries the eye (the modal only shows the
  // password field on create - edit has no password field today).
  it('create-user modal: eye toggles the password field', async () => {
    renderTable();
    await screen.findByText('ana');
    fireEvent.click(screen.getByRole('button', { name: '+ New user' }));
    const eye = screen.getByRole('button', { name: 'Show password' });
    const input = document.getElementById('adm-form-password') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(eye);
    expect(input.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
  });
});
