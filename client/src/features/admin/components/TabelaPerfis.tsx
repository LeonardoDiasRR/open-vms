import { useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import type { ApiClient, AccessProfile, AccessProfilesQuery, Grant } from '@/shared/utils/api';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import type { Notify } from '@/shared/components/Toast';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Input } from '@/shared/ui/input';
import { Label } from '@/shared/ui/label';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';
import DataTable, { Cell, type Column } from './TabelaDados';
import { PAGE_SIZE_OPTIONS, type Query } from '../hooks/useTabelaDados';

// spec 2026-10-18 (4.4): the Access profiles tab in the data table pattern. A system profile is not
// editable (A4): the server answers 409 and the row does not even offer the path. `none` is the ABSENCE
// of a grant, so the draft starts at `none` and only what the operator picked becomes a grant in the PATCH.
// spec 2026-10-20 §5: the list carries `grants_count`, never the grants — the editor loads them on demand.
type Api = Pick<ApiClient, 'accessProfiles' | 'accessProfileGrants' | 'cameras' | 'createAccessProfile'
  | 'patchAccessProfile' | 'deleteAccessProfile'>;
type Level = 'none' | 'view' | 'control';
// missing keys: admin.profiles.level_none / level_view / level_control
const LEVELS: { value: Level; label: string }[] = [
  { value: 'none', label: 'none' }, { value: 'view', label: 'view' }, { value: 'control', label: 'control' },
];
const errMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;
// Grant comparison independent of ORDER: the PATCH only carries `grants` when the list really changes.
const canonical = (gs: Grant[]) => gs.map((g) => `${g.camera_id}:${g.level}`).sort().join(',');

// `notify` is optional (no-op by default) for the same reason as the Users tab: AdminModal only passes
// the real toast when it gets one itself (Task 5.1).
const noNotify: Notify = () => {};

export default function ProfilesTable({ api, dlg, notify = noNotify }:
{ api: Api; dlg: PromptHandle; notify?: Notify }) {
  const { t } = useT();
  const [page, setPage] = useState<{ rows: AccessProfile[]; total: number }>({ rows: [], total: 0 });
  const [cameras, setCameras] = useState<{ id: string; name: string }[]>([]);
  const [editing, setEditing] = useState<AccessProfile | 'new' | null>(null);
  // The query in force: after a create/edit/delete the tab re-reads the SAME page it was on.
  const lastQuery = useRef<AccessProfilesQuery>({ limit: PAGE_SIZE_OPTIONS[0] });

  const load = (q: AccessProfilesQuery) => api.accessProfiles(q)
    .then((p) => setPage({ rows: p.items, total: p.total }))
    .catch((e: unknown) => { notify(errMessage(e, t('admin.profiles.load_failed')), 'error'); });
  const onQuery = (q: Query) => {
    lastQuery.current = { limit: q.limit, offset: q.offset, q: q.text, sort: q.sort, dir: q.dir };
    return load(lastQuery.current);
  };
  const reload = () => load(lastQuery.current);

  // The editor's camera matrix needs the whole camera list; it is not the profile page.
  useEffect(() => {
    api.cameras()
      .then((cs) => setCameras(cs.map((c) => ({ id: c.id, name: c.name }))))
      .catch((e: unknown) => notify(errMessage(e, t('admin.profiles.load_failed')), 'error'));
  }, [api]);

  async function remove(p: AccessProfile) {
    const confirmed = await dlg.confirm(t('shared.confirm_delete'), [t('admin.profiles.delete_question', { name: p.name })], { danger: true, text: t('shared.delete') });
    if (!confirmed) return;
    try { await api.deleteAccessProfile(p.id); notify(t('admin.profiles.deleted', { name: p.name })); await reload(); }
    catch (e) { notify(errMessage(e, t('admin.profiles.delete_failed')), 'error'); }
  }

  // missing keys: admin.profiles.type / kind_system / kind_custom
  const kindLabel = (p: AccessProfile) => (p.kind === 'system' ? 'system' : 'custom');
  // a system profile reaches every camera (spec 4.4); a custom one counts the grants (no list needed)
  const camerasLabel = (p: AccessProfile) => (p.kind === 'system' ? t('admin.profiles.all_cameras') : String(p.grants_count));
  // The keys ARE the server's sort list (`name`, `kind`, `cameras`; anything else is 400)
  const columns: Column[] = [
    { key: 'name', title: t('admin.profiles.profile') },
    { key: 'kind', title: 'Type' },
    { key: 'cameras', title: t('admin.profiles.cameras') },
  ];

  return (
    <>
      <DataTable
        title={t('admin.profiles.title')}
        subtitle={t('admin.profiles.subtitle')}
        action={<Button className="nx-btn" onClick={() => setEditing('new')}>{t('admin.profiles.new_action')}</Button>}
        columns={columns}
        actions={t('admin.actions')}
        rows={page.rows}
        total={page.total}
        onQuery={onQuery}
        initialKey="name"
        rowKey={(p) => p.id}
        empty={t('admin.profiles.empty')}
        row={(p) => (
          <>
            <Cell label={t('admin.profiles.profile')}><span>{p.name}</span></Cell>
            <Cell label="Type">
              <Badge variant={p.kind === 'system' ? 'secondary' : 'outline'}>{kindLabel(p)}</Badge>
            </Cell>
            <Cell label={t('admin.profiles.cameras')}>
              <span>{camerasLabel(p)}</span>
            </Cell>
            {/* spec 2026-10-18 (tabs, item 2.2): the cell ALWAYS exists. On immutable profiles
                (kind system: admin, operator, viewer) the icons show up disabled, with no onClick.
                The "Actions" <th> was already always emitted, so the empty state's colSpan stays right. */}
            <Cell label={t('admin.actions')}>
              {/* flex wrapper: on desktop the td is table-cell and ignores the td's own gap (spec admin-imutavel) */}
              <span className="flex w-full items-center justify-center gap-3">
                <Button variant="ghost" size="icon-sm" className="nx-acao-editar"
                  title={p.kind === 'system' ? t('admin.profiles.immutable') : t('admin.profiles.edit', { name: p.name })}
                  aria-label={t('admin.profiles.edit', { name: p.name })} disabled={p.kind === 'system'}
                  onClick={() => setEditing(p)}><Pencil /></Button>
                {/* missing key: admin.profiles.delete ("{name}") */}
                <Button variant="ghost" size="icon-sm" className="nx-acao-excluir"
                  title={p.kind === 'system' ? t('admin.profiles.immutable') : `${t('shared.delete')} ${p.name}`}
                  aria-label={`${t('shared.delete')} ${p.name}`} disabled={p.kind === 'system'}
                  onClick={() => remove(p)}><Trash2 /></Button>
              </span>
            </Cell>
          </>
        )}
      />
      {editing && (
        <ProfileForm
          api={api}
          cameras={cameras}
          profile={editing === 'new' ? null : editing}
          notify={notify}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
        />
      )}
    </>
  );
}

// One form for both paths (spec 4.4): the NAME and the camera table with each one's level. The markup was
// unified by the profile-modal spec of 2026-10-19: the table also shows up on create, and the marked
// grants go in the same POST (D3 — no create->PATCH chain).
function ProfileForm({ api, cameras, profile, notify, onClose, onSaved }:
{ api: Api; cameras: { id: string; name: string }[]; profile: AccessProfile | null; notify: Notify; onClose: () => void; onSaved: () => Promise<void> }) {
  const { t, tn } = useT();
  const [name, setName] = useState(profile ? profile.name : '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // spec §5: the list carries only `grants_count`; the editor asks for the grants of THIS profile.
  // `null` means still loading — the matrix is derived from what arrived, and Save stays disabled:
  // showing every camera at `none` for a profile that HAS grants would invite an accidental revoke.
  const [profileGrants, setProfileGrants] = useState<Grant[] | null>(profile ? null : []);
  // Only what the operator CHANGED lives in state: the rest is derived from the grants that arrived,
  // so a late answer cannot overwrite a level that was already picked.
  const [overrides, setOverrides] = useState<Record<string, Level>>({});
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  useEsc(onClose);

  useEffect(() => {
    if (!profile) return;
    let alive = true; // the modal may close before the answer comes
    api.accessProfileGrants(profile.id)
      .then((g) => { if (alive) setProfileGrants(g); })
      .catch((e: unknown) => {
        if (!alive) return;
        // the grants stay null on purpose: without them the draft cannot be built and Save stays
        // disabled, so a failed load can never be turned into a wipe of the profile's permissions
        setError(errMessage(e, t('admin.profiles.load_failed')));
      });
    return () => { alive = false; };
  }, [api, profile]);

  // The draft is DERIVED from the loaded grants: what is not granted starts at `none`.
  const draft = useMemo(() => {
    const r: Record<string, Level> = {};
    for (const c of cameras) {
      const loaded = profileGrants?.find((g) => g.camera_id === c.id)?.level ?? 'none';
      r[c.id] = overrides[c.id] ?? loaded;
    }
    return r;
  }, [cameras, profileGrants, overrides]);

  const canSave = name.trim() !== '' && !saving && profileGrants !== null;
  // count footer (spec 2026-10-19): only the visible draft; orphan grants stay out
  const marked = Object.values(draft).filter((n) => n !== 'none').length;

  async function save() {
    if (!canSave) return;
    setError(null); setSaving(true);
    try {
      const grants: Grant[] = Object.entries(draft)
        .filter(([, level]) => level !== 'none')
        .map(([camera_id, level]) => ({ camera_id, level: level as 'view' | 'control' }));
      if (!profile) {
        // with no grant marked the body is still only the name (previous behavior preserved)
        await api.createAccessProfile(grants.length ? { name: name.trim(), grants } : { name: name.trim() });
        // missing keys: admin.profiles.created / admin.profiles.updated
        notify(`Profile ${name.trim()} created`);
      } else {
        // The draft only covers the cameras of the current list: a grant for an already deleted camera
        // stays valid, so the orphans come back in the body. And the comparison is made over the same
        // set (visible + orphans) and is canonical: without that, a NAME-only edit returned a `grants`
        // without the orphan — a permission change the operator did not ask for.
        const current = profileGrants ?? [];
        const orphans = current.filter((g) => !Object.hasOwn(draft, g.camera_id));
        const body: { name?: string; grants?: Grant[] } = {};
        if (name.trim() !== profile.name) body.name = name.trim();
        if (canonical([...grants, ...orphans]) !== canonical(current)) body.grants = [...grants, ...orphans];
        // No body means no PATCH: the "updated" toast would be a lie.
        if (Object.keys(body).length) {
          await api.patchAccessProfile(profile.id, body);
          notify(`Profile ${name.trim()} updated`);
        }
      }
      await onSaved();
    } catch (e) {
      setError(errMessage(e, t('admin.profiles.save_failed')));
    } finally { setSaving(false); }
  }

  return (
    <div className="nx-backdrop">
      <div className="nx-dialog" role="dialog" aria-modal="true" aria-labelledby="prf-form-titulo" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="prf-form-titulo">{profile ? t('admin.profiles.edit_title', { name: profile.name }) : t('admin.profiles.new_title')}</span>
          <button className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>
        <div className="nx-body">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              {/* missing key: admin.profiles.name */}
              <Label htmlFor="prf-form-name">Name</Label>
              <Input id="prf-form-name" autoFocus maxLength={60} value={name}
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <span className="nx-label">{t('admin.profiles.cameras')}</span>
              {cameras.length === 0 && <p className="muted">{t('admin.profiles.no_cameras')}</p>}
              {cameras.length > 0 && (
                <div className="prf-tabela" role="group" aria-label={t('admin.profiles.camera_permission')}>
                  <div className="prf-linha prf-cabecalho">
                    {/* missing key: admin.profiles.camera */}
                    <span className="prf-celula">Camera</span>
                    {LEVELS.map((n) => <span className="prf-celula prf-nivel" key={n.value}>{n.label}</span>)}
                  </div>
                  {cameras.map((c) => (
                    <div className="prf-linha" key={c.id}>
                      <span className="prf-celula">{c.name}</span>
                      {LEVELS.map((n) => (
                        <label className="prf-celula prf-nivel" key={n.value}>
                          <input type="radio" className="prf-radio" name={`cam-${c.id}`}
                            checked={(draft[c.id] ?? 'none') === n.value}
                            aria-label={`${n.label} — ${c.name}`}
                            onChange={() => setOverrides((r) => ({ ...r, [c.id]: n.value }))} />
                        </label>
                      ))}
                    </div>
                  ))}
                </div>
              )}
              <p className="muted">{marked === 0 ? t('admin.profiles.no_permissions') : tn('admin.profiles.permissions_count', marked)}</p>
            </div>
            {error && <p className="nx-err">{error}</p>}
          </div>
        </div>
        <div className="nx-actions">
          <button className="nx-btn" onClick={onClose}>{t('shared.cancel')}</button>
          <button type="button" className="nx-btn" disabled={!canSave} onClick={save}>{t('shared.save')}</button>
        </div>
      </div>
    </div>
  );
}
