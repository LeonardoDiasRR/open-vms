import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import ProfilesTable from './TabelaPerfis';
import type { AccessProfile, AccessProfilesQuery, Grant } from '@/shared/utils/api';

// spec 2026-10-20 §5: the list carries `grants_count`; the grants themselves come from
// GET /profiles/access/:id/grants when the editor opens.
const profiles: AccessProfile[] = [
  { id: 'admin', name: 'admin', kind: 'system', grants_count: 0 },
  { id: 'p1', name: 'Portaria', kind: 'custom', grants_count: 1 },
];
const grants: Record<string, Grant[]> = { p1: [{ camera_id: 'c1', level: 'view' }], admin: [] };
const cam = (id: string, name: string) => ({ id, name, state: 'online', profile_ids: [] });
// the page envelope of the route
const envelope = <T,>(items: T[], q: { limit?: number; offset?: number } = {}) => ({
  items, total: items.length, limit: q.limit ?? 10, offset: q.offset ?? 0,
});

function fakeApi(over: Partial<Record<string, unknown>> = {}) {
  return {
    accessProfiles: vi.fn(async (q: AccessProfilesQuery = {}) => envelope(profiles, q)),
    accessProfileGrants: vi.fn(async (id: string) => grants[id] ?? []),
    cameras: vi.fn(async () => [cam('c1', 'Portaria 1'), cam('c2', 'Fundos')]),
    createAccessProfile: vi.fn(async () => ({ id: 'p2', name: 'New', kind: 'custom' as const, grants_count: 0, grants: [] })),
    patchAccessProfile: vi.fn(async () => ({ ...profiles[1], grants: grants.p1 })),
    deleteAccessProfile: vi.fn(async () => ({ deleted: 'p1' })),
    ...over,
  };
}
const dlgOk = { confirm: vi.fn(async () => true), ask: vi.fn(async () => 'x'), request: null, setRequest: vi.fn() };
const notify = vi.fn();
const renderTable = (api = fakeApi(), dlg = dlgOk) =>
  render(<LanguageProvider><ProfilesTable api={api as never} dlg={dlg as never} notify={notify} /></LanguageProvider>);

// The form's Save is disabled while the grants are on their way: waiting for it is waiting for the load.
const readyToSave = async () => waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled());

describe('ProfilesTable (spec 2026-10-18 4.4; grants on demand since 2026-10-20 §5)', () => {
  it('lists the type and the camera count of each profile', async () => {
    const api = fakeApi();
    renderTable(api);
    const adminRow = (await screen.findByText('admin')).closest('tr')!;
    expect(adminRow.textContent).toContain('system');
    expect(adminRow.textContent).toContain('all');
    const customRow = screen.getByText('Portaria').closest('tr')!;
    expect(customRow.textContent).toContain('custom');
    // the number is the `grants_count` of the list row, not a grants array
    expect(customRow.textContent).toContain('1');
    expect(api.accessProfiles).toHaveBeenCalledWith({ limit: 10, offset: 0, q: '', sort: 'name', dir: 'asc' });
  });

  it('a system profile shows both icons DISABLED; the custom one, active (spec 2026-10-18 tabs)', async () => {
    const api = fakeApi();
    renderTable(api);
    const adminRow = (await screen.findByText('admin')).closest('tr')!;
    expect(screen.getByRole('button', { name: 'Edit admin' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete admin' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit admin' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete admin' }));
    expect(api.patchAccessProfile).not.toHaveBeenCalled();
    expect(api.deleteAccessProfile).not.toHaveBeenCalled();
    // td[4] = Actions cell: td[0] is the "#" column (hidden on the phone), [1] Profile, [2] Type, [3] Cameras
    const cell = adminRow.querySelectorAll('td')[4]!;
    // spec 2026-10-18 (admin-imutavel): the spacing came from the td (table-cell ignores gap) to a
    // flex wrapper inside the cell
    const wrapper = cell.querySelector(':scope > span.flex.w-full.items-center.justify-center.gap-3');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelectorAll('button').length).toBe(2);
    expect(screen.getByRole('button', { name: '+ New profile' })).toHaveClass('nx-btn');
    const customRow = screen.getByText('Portaria').closest('tr')!;
    expect([...customRow.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')))
      .toEqual(['Edit Portaria', 'Delete Portaria']);
    expect(screen.getByRole('button', { name: 'Delete Portaria' })).not.toBeDisabled();
  });

  it('creating a profile shows the table all at none and saves the marked grants in the POST', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: '+ New profile' }));
    expect(screen.getByRole('dialog', { name: 'New profile' })).toBeInTheDocument();
    // spec 2026-10-19 (profile-modal): the table shows up on create, default 'none'
    expect(screen.getByRole('radio', { name: 'none — Portaria 1' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'view — Portaria 1' })).not.toBeChecked();
    expect(screen.getByText('No permissions selected')).toBeInTheDocument();
    // create asks for no grants at all: there is no profile yet
    expect(api.accessProfileGrants).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('radio', { name: 'view — Portaria 1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'control — Fundos' }));
    expect(screen.getByText('2 cameras with permission')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createAccessProfile).toHaveBeenCalledWith({
      name: 'New',
      grants: [{ camera_id: 'c1', level: 'view' }, { camera_id: 'c2', level: 'control' }],
    }));
    expect(api.patchAccessProfile).not.toHaveBeenCalled();
  });

  it('creating without marking any camera sends only the name (no grants key)', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: '+ New profile' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createAccessProfile).toHaveBeenCalledWith({ name: 'New' }));
  });

  it('the editor loads the grants on demand and paints the levels that came', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    expect(api.accessProfileGrants).toHaveBeenCalledWith('p1');
    // the draft only exists after the answer: no camera flashes at `none`
    await waitFor(() => expect(screen.getByRole('radio', { name: 'view — Portaria 1' })).toBeChecked());
    expect(screen.getByRole('radio', { name: 'none — Fundos' })).toBeChecked();
  });

  it('the edit form saves the name and the grants in the SAME PATCH', async () => {
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    await readyToSave();
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Portaria');
    // spec 2026-10-19: levels are radios per camera; the loaded state shows up in checked
    expect(screen.getByRole('radio', { name: 'view — Portaria 1' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'none — Fundos' })).toBeChecked();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Portaria 2' } });
    fireEvent.click(screen.getByRole('radio', { name: 'control — Portaria 1' }));
    fireEvent.click(screen.getByRole('radio', { name: 'view — Fundos' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchAccessProfile).toHaveBeenCalledWith('p1', {
      name: 'Portaria 2',
      grants: [{ camera_id: 'c1', level: 'control' }, { camera_id: 'c2', level: 'view' }],
    }));
  });

  it('the header covers the whole row and the actions column exists on every row', async () => {
    renderTable();
    await screen.findByText('Portaria');
    const header = screen.getAllByRole('row')[0];
    // the sorted column label carries the arrow; the Actions one does not — it does not sort
    expect([...header.querySelectorAll('th')].map((th) => th.textContent))
      .toEqual(['#', 'Profile ↑', 'Type', 'Cameras', 'Actions']);
    expect(screen.getByText('Portaria').closest('tr')!.querySelectorAll('td').length).toBe(5);
    // the actions column does not sort: no button, no `aria-sort`
    const actions = screen.getByRole('columnheader', { name: 'Actions' });
    expect(actions.querySelector('button')).toBeNull();
    expect(actions.getAttribute('aria-sort')).toBeNull();
    // spec 2026-10-18 (tabs, 2.2): the actions cell also exists on the system profile — with both
    // icons disabled, so the phone card does not come up without the column.
    const adminRow = screen.getByText('admin').closest('tr')!;
    expect(adminRow.querySelectorAll('td').length).toBe(5);
    const adminActions = adminRow.querySelectorAll('td')[4]!;
    expect(adminActions.textContent).toContain('Actions');
    expect([...adminActions.querySelectorAll('button')].every((b) => b.hasAttribute('disabled'))).toBe(true);
  });

  it('the empty state fills every column (the colSpan counts the actions one)', async () => {
    renderTable(fakeApi({ accessProfiles: vi.fn(async (q: AccessProfilesQuery = {}) => envelope([], q)) }));
    const empty = await screen.findByText('No profiles found.');
    expect(empty.getAttribute('colspan')).toBe('5');
  });

  it('saving with no change calls no PATCH and does not claim it updated', async () => {
    notify.mockClear();
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    await readyToSave();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit Portaria' })).toBeNull());
    expect(api.patchAccessProfile).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('only the name changed: the body carries only `name` — the ORDER of the cameras is not a change', async () => {
    // the camera list comes as c1,c2 and the profile grants as c2,c1: without the canonical comparison
    // the body would carry `grants` again, a permission change the operator did not ask for
    const api = fakeApi({
      accessProfiles: vi.fn(async () => envelope([{ id: 'p1', name: 'Portaria', kind: 'custom' as const, grants_count: 2 }])),
      accessProfileGrants: vi.fn(async () => [{ camera_id: 'c2', level: 'view' }, { camera_id: 'c1', level: 'view' }]),
    });
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    await readyToSave();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Portaria 2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchAccessProfile).toHaveBeenCalledWith('p1', { name: 'Portaria 2' }));
  });

  it('a grant for a camera that left the list is not erased by a name-only edit', async () => {
    const api = fakeApi({
      accessProfiles: vi.fn(async () => envelope([{ id: 'p1', name: 'Portaria', kind: 'custom' as const, grants_count: 2 }])),
      accessProfileGrants: vi.fn(async () => [{ camera_id: 'c1', level: 'view' }, { camera_id: 'c9', level: 'control' }]),
    });
    renderTable(api);
    await screen.findByText('Portaria');
    // c9 is not in the camera list (deleted camera): the access stays valid, so the set did not
    // change and the body does not carry `grants`
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    await readyToSave();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchAccessProfile).toHaveBeenCalledWith('p1', { name: 'New' }));
  });

  it('the orphan grant comes back in the body when the operator touches the levels', async () => {
    const api = fakeApi({
      accessProfiles: vi.fn(async () => envelope([{ id: 'p1', name: 'Portaria', kind: 'custom' as const, grants_count: 2 }])),
      accessProfileGrants: vi.fn(async () => [{ camera_id: 'c1', level: 'view' }, { camera_id: 'c9', level: 'control' }]),
    });
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    await readyToSave();
    fireEvent.click(screen.getByRole('radio', { name: 'control — Portaria 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.patchAccessProfile).toHaveBeenCalledWith('p1', {
      grants: [{ camera_id: 'c1', level: 'control' }, { camera_id: 'c9', level: 'control' }],
    }));
  });

  it('a failed grants load keeps Save disabled and shows the error (no accidental wipe)', async () => {
    const api = fakeApi({ accessProfileGrants: vi.fn(async () => { throw new Error('500: grants unavailable'); }) });
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Portaria' }));
    expect(await screen.findByText(/grants unavailable/)).toBeInTheDocument();
    // without the grants the draft is not built, so there is nothing to save
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('delete goes through dlg and only deletes with confirmation', async () => {
    const api = fakeApi();
    const dlg = { ...dlgOk, confirm: vi.fn(async () => false) };
    renderTable(api, dlg);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Portaria' }));
    await waitFor(() => expect(dlg.confirm).toHaveBeenCalled());
    expect(api.deleteAccessProfile).not.toHaveBeenCalled();
  });

  it('a confirmed delete calls deleteAccessProfile, notifies and re-reads the page', async () => {
    notify.mockClear();
    const api = fakeApi();
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Portaria' }));
    await waitFor(() => expect(api.deleteAccessProfile).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Profile Portaria deleted'));
    await waitFor(() => expect(api.accessProfiles).toHaveBeenCalledTimes(2));
  });

  it('the 409 of a profile in use shows up as an error, in the toast', async () => {
    notify.mockClear();
    const api = fakeApi({
      deleteAccessProfile: vi.fn(async () => { throw Object.assign(new Error('409: profile in use by ana'), { status: 409 }); }),
    });
    renderTable(api);
    await screen.findByText('Portaria');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Portaria' }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining('profile in use by ana'), 'error'));
  });
});
