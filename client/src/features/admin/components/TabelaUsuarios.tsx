import { useEffect, useRef, useState } from 'react';
import { Ban, Check, KeyRound, Pencil, Trash2 } from 'lucide-react';
import type { ApiClient, User, AccessProfile, UsersQuery } from '@/shared/utils/api';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import type { Notify } from '@/shared/components/Toast';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { InputSenha } from '@/shared/ui/input-senha';
import { Label } from '@/shared/ui/label';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';
import DataTable, { Cell, type Column } from './TabelaDados';
import { PAGE_SIZE_OPTIONS, type Query } from '../hooks/useTabelaDados';

// spec 2026-10-18 (4.3): the Users tab in the data table pattern. The profile is REQUIRED on create
// and the password policy belongs to the SERVER: here only the 400 message is shown (E5). The reset
// returns the temporary password ONCE and it goes to the app toast.
// spec 2026-10-20 §5: the table is server-side — the profile NAME comes from the JOIN (`profile_name`),
// and the whole profile list is fetched once for the form's select.
type Api = Pick<ApiClient, 'users' | 'accessProfiles' | 'createUser' | 'patchUser' | 'renameUser'
  | 'deleteUser' | 'resetPassword'>;
const errMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

// `create` has no record; `edit` carries the original, which is the source of "what changed".
type EditState = { mode: 'create' } | { mode: 'edit'; original: User };

// `notify` is optional (no-op by default): the one that mounts the tabs is AdminModal, which only passes
// the real toast when it gets one itself (Task 5.1). That way the old consumer keeps compiling.
const noNotify: Notify = () => {};

export default function UsersTable({ api, dlg, notify = noNotify }:
{ api: Api; dlg: PromptHandle; notify?: Notify }) {
  const t = useT().t;
  const [page, setPage] = useState<{ rows: User[]; total: number }>({ rows: [], total: 0 });
  const [profiles, setProfiles] = useState<AccessProfile[]>([]);
  const [editing, setEditing] = useState<EditState | null>(null);
  // The query in force: after a create/edit/delete the tab re-reads the SAME page it was on.
  const lastQuery = useRef<UsersQuery>({ limit: PAGE_SIZE_OPTIONS[0] });

  const load = (q: UsersQuery) => api.users(q)
    .then((p) => setPage({ rows: p.items, total: p.total }))
    .catch((e: unknown) => { notify(errMessage(e, t('admin.users.load_failed')), 'error'); });
  const onQuery = (q: Query) => {
    lastQuery.current = { limit: q.limit, offset: q.offset, q: q.text, sort: q.sort, dir: q.dir };
    return load(lastQuery.current);
  };
  const reload = () => load(lastQuery.current);

  // The form's select takes the whole list (`limit: 100` is the ceiling), not a page.
  useEffect(() => {
    api.accessProfiles({ limit: 100 })
      .then((p) => setProfiles(p.items))
      .catch((e: unknown) => notify(errMessage(e, t('admin.users.load_failed')), 'error'));
  }, [api]);

  async function toggleStatus(u: User) {
    const next = u.status === 'active' ? 'disabled' : 'active';
    try {
      await api.patchUser(u.username, { status: next });
      // missing key: admin.users.blocked / admin.users.activated
      notify(next === 'disabled' ? `${u.username} blocked` : `${u.username} activated`);
      await reload();
    } catch (e) { notify(errMessage(e, t('admin.users.status_failed')), 'error'); }
  }
  async function resetPassword(u: User) {
    const confirmed = await dlg.confirm(t('admin.users.reset_password'), [
      t('admin.users.reset_question', { name: u.username }),
    ], { text: t('admin.users.reset_password') });
    if (!confirmed) return;
    try {
      const r = await api.resetPassword(u.username);
      // the temporary password shows up ONCE, in the toast (spec 4.3)
      notify(t('admin.users.temp_password', { name: r.username, password: r.temporary_password }));
      await reload();
    } catch (e) { notify(errMessage(e, t('admin.users.reset_failed')), 'error'); }
  }
  async function remove(u: User) {
    const confirmed = await dlg.confirm(t('shared.confirm_delete'), [t('admin.users.delete_question', { name: u.username })], { danger: true, text: t('shared.delete') });
    if (!confirmed) return;
    try { await api.deleteUser(u.username); notify(t('admin.users.deleted', { name: u.username })); await reload(); }
    catch (e) { notify(errMessage(e, t('admin.users.delete_failed')), 'error'); }
  }

  // The JOIN already brings the name (spec §5): no lookup, no second request.
  const profileName = (u: User) => u.profile_name ?? '—';
  const statusLabel = (u: User) => (u.status === 'active' ? t('admin.users.active') : t('admin.users.disabled'));
  // The keys ARE the server's sort list (`username`, `profile`, `status`; anything else is 400)
  const columns: Column[] = [
    { key: 'username', title: t('admin.users.username') },
    { key: 'profile', title: t('admin.users.profile') },
    { key: 'status', title: t('admin.users.status') },
  ];

  // The action button names come from the same keys as the labels, so the tests keep one source.
  const editLabel = (u: User) => t('admin.users.edit', { name: u.username });
  const blockLabel = (u: User) => (u.status === 'active' ? t('admin.users.block', { name: u.username }) : t('admin.users.activate', { name: u.username }));
  const immutable = t('admin.users.immutable');

  return (
    <>
      <DataTable
        title={t('admin.users.title')}
        subtitle={t('admin.users.subtitle')}
        action={<Button className="nx-btn" onClick={() => setEditing({ mode: 'create' })}>{t('admin.users.new_action')}</Button>}
        columns={columns}
        actions={t('admin.actions')}
        rows={page.rows}
        total={page.total}
        onQuery={onQuery}
        initialKey="username"
        rowKey={(u) => u.username}
        empty={t('admin.users.empty')}
        row={(u) => (
          <>
            <Cell label={t('admin.users.username')}>
              <span>{u.username}</span>
              {u.must_change_password && <Badge variant="outline">{t('admin.users.pending_change')}</Badge>}
            </Cell>
            <Cell label={t('admin.users.profile')}><span>{profileName(u)}</span></Cell>
            <Cell label={t('admin.users.status')}>
              <Badge variant={u.status === 'active' ? 'secondary' : 'outline'}>
                <span className={`size-1.5 rounded-full ${u.status === 'active' ? 'bg-primary' : 'bg-muted-foreground'}`} aria-hidden="true" />
                {statusLabel(u)}
              </Badge>
            </Cell>
            <Cell label={t('admin.actions')}>
              {/* flex wrapper: on desktop the td is table-cell and ignores the td's own gap (spec admin-imutavel) */}
              <span className="flex w-full items-center justify-center gap-3">
                <Button variant="ghost" size="icon-sm" className="nx-acao-editar"
                  title={u.username === 'admin' ? immutable : editLabel(u)} aria-label={editLabel(u)}
                  disabled={u.username === 'admin'}
                  onClick={() => setEditing({ mode: 'edit', original: u })}><Pencil /></Button>
                <Button variant="ghost" size="icon-sm" className={u.status === 'active' ? 'nx-acao-bloquear' : 'nx-acao-ativar'}
                  title={u.username === 'admin' ? immutable : blockLabel(u)}
                  aria-label={blockLabel(u)}
                  disabled={u.username === 'admin'}
                  onClick={() => toggleStatus(u)}>{u.status === 'active' ? <Ban /> : <Check />}</Button>
                <Button variant="ghost" size="icon-sm" className="nx-acao-reset" title={t('admin.users.reset_action', { name: u.username })} aria-label={t('admin.users.reset_action', { name: u.username })}
                  onClick={() => resetPassword(u)}><KeyRound /></Button>
                <Button variant="ghost" size="icon-sm" className="nx-acao-excluir"
                  title={u.username === 'admin' ? immutable : t('admin.users.delete', { name: u.username })} aria-label={t('admin.users.delete', { name: u.username })}
                  disabled={u.username === 'admin'}
                  onClick={() => remove(u)}><Trash2 /></Button>
              </span>
            </Cell>
          </>
        )}
      />
      {editing && (
        <UserForm
          api={api}
          profiles={profiles}
          editing={editing}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
        />
      )}
    </>
  );
}

// The form is a modal INSIDE the Administration modal body, in the house markup
// (`nx-dialog nx-dialog-menor` + `nx-close`), not the Radix Dialog: that way Escape enters the `useEsc`
// stack and closes ONLY the form (spec 4.3).
function UserForm({ api, profiles, editing, notify, onClose, onSaved }:
{ api: Api; profiles: AccessProfile[]; editing: EditState; notify: Notify; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useT().t;
  const original = editing.mode === 'edit' ? editing.original : null;
  const [username, setUsername] = useState(original ? original.username : '');
  const [password, setPassword] = useState('');
  const [profileId, setProfileId] = useState(original ? original.profile_id : '');
  const [status, setStatus] = useState<'active' | 'disabled'>(original && original.status === 'disabled' ? 'disabled' : 'active');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The name the SERVER has right now: after a successful rename the baseline becomes the new name.
  // Without that, a retry (the following `patchUser` failed) called `renameUser` again with the old
  // name — which no longer exists — and the profile/status edit got stuck on the 400.
  const [currentName, setCurrentName] = useState(original ? original.username : '');
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  useEsc(onClose);

  const name = username.trim();
  // The Save button only enables with the required fields filled (spec 4.3). The password is required
  // only on create: on edit, changing the password is the reset, which has its own path.
  const canSave = name.length >= 2 && name.length <= 60 && profileId !== '' && (original !== null || password !== '') && !saving;

  async function save() {
    if (!canSave) return;
    setError(null); setSaving(true);
    try {
      if (!original) {
        await api.createUser({ username: name, password, profile_id: profileId });
        notify(t('admin.users.created', { name }));
      } else {
        const change: { profile_id?: string; status?: 'active' | 'disabled' } = {};
        if (profileId !== original.profile_id) change.profile_id = profileId;
        if (status !== original.status) change.status = status;
        // With no rename and no body there was no call to the server at all: the "updated" toast would
        // be a lie. The guard is the SAME as the Profiles tab (only notify when the PATCH goes out).
        const changed = name !== currentName || Object.keys(change).length > 0;
        // The rename comes FIRST: the following PATCH already talks to the new name (spec 4.3)
        if (name !== currentName) { await api.renameUser(currentName, name); setCurrentName(name); }
        if (Object.keys(change).length) await api.patchUser(name, change);
        if (changed) notify(t('admin.users.updated', { name }));
      }
      await onSaved();
    } catch (e) {
      // field error (server 400) stays INLINE in the form; the toast is for the action notice
      setError(errMessage(e, t('admin.users.save_failed')));
    } finally { setSaving(false); }
  }

  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-menor" role="dialog" aria-modal="true" aria-labelledby="adm-form-titulo" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="adm-form-titulo">{original ? t('admin.users.edit_title', { name: currentName }) : t('admin.users.new_title')}</span>
          <button className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>
        <form className="nx-body" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="adm-form-username">{t('admin.users.username')}</Label>
              <Input id="adm-form-username" autoFocus maxLength={60} value={username}
                onChange={(e) => setUsername(e.target.value)} />
            </div>
            {!original && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="adm-form-password">{t('admin.users.password')}</Label>
                <InputSenha><Input id="adm-form-password" value={password}
                    onChange={(e) => setPassword(e.target.value)} /></InputSenha>
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Label htmlFor="adm-form-profile">{t('admin.users.profile')}</Label>
              <select id="adm-form-profile" className="nx-input" value={profileId}
                onChange={(e) => setProfileId(e.target.value)}>
                <option value="">—</option>
                {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            {original && (
              <div className="flex flex-col gap-1">
                <Label htmlFor="adm-form-situacao">{t('admin.users.status')}</Label>
                <select id="adm-form-situacao" className="nx-input" value={status}
                  onChange={(e) => setStatus(e.target.value === 'disabled' ? 'disabled' : 'active')}>
                  <option value="active">{t('admin.users.active')}</option>
                  <option value="disabled">{t('admin.users.disabled')}</option>
                </select>
              </div>
            )}
            {error && <p className="nx-err">{error}</p>}
          </div>
        </form>
        <div className="nx-actions">
          <button className="nx-btn" onClick={onClose}>{t('shared.cancel')}</button>
          <button type="button" className="nx-btn" disabled={!canSave} onClick={save}>{t('shared.save')}</button>
        </div>
      </div>
    </div>
  );
}
