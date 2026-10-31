import { useEffect, useRef, useState } from 'react';
// amendment E8 (Gate 3): FormGravacoes lives in shared/components — two features consume it
// (admin and auth) and guard F6 (test/arquitetura_frontend.test.js) forbids cross imports.
import FormGravacoes from '@/shared/components/FormGravacoes';
import { parseRetention } from '@/shared/constants/retencao';
import type { MessageKey } from '@/shared/i18n/en';
import { useT } from '@/shared/i18n';
import type { ApiClient, Settings } from '@/shared/utils/api';

type Api = Pick<ApiClient, 'settings' | 'settingsPatch'>;

// Recordings tab (spec 2026-10-19): the root folder became read-only (it comes from the server env);
// GLOBAL retention and the disk cap stay on the Save button with a dirty baseline, like every other
// form of this modal.
export default function RecordingsTab({ api }: { api: Api }) {
  const t = useT().t;
  const [settings, setSettings] = useState<Settings | null>(null);
  const [days, setDays] = useState('');
  const [pct, setPct] = useState(80);
  const baseline = useRef<{ days: string; pct: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = (c: Settings) => {
    setSettings(c);
    baseline.current = { days: String(c.retention_days), pct: c.disk_max_percent };
    setDays(String(c.retention_days)); setPct(c.disk_max_percent);
  };
  useEffect(() => {
    let alive = true;
    api.settings().then((c) => alive && load(c)).catch((e: unknown) => alive && setError((e as Error).message));
    return () => { alive = false; };
  }, [api]);
  const dirty = baseline.current !== null && (baseline.current.days !== days || baseline.current.pct !== pct);
  const save = async () => {
    const parsed = parseRetention(days);
    // same rule as the server; the client does not let it leave from here.
    // ponytail: the parser hands back a plain key; the cast is the seam with the typed dictionary.
    // missing keys: admin.recordings.retention_not_integer, admin.recordings.retention_min.
    if (!parsed.ok) { setError(t(parsed.errorKey as MessageKey)); return; }
    setError(null); setSaving(true);
    try {
      load(await api.settingsPatch({ retention_days: parsed.value, disk_max_percent: pct }));
      setSaved(true); setTimeout(() => setSaved(false), 1500);
    } catch (e) { setError((e as Error).message || t('admin.recordings.save_failed')); } finally { setSaving(false); }
  };
  if (!settings) return error ? <p className="nx-err">{error}</p> : <p className="nx-label">{t('admin.recordings.loading')}</p>;
  return (
    <>
      <FormGravacoes value={{ s: settings, days, pct }} busy={saving} onDays={setDays} onPercent={setPct} />
      {error && <p className="nx-err">{error}</p>}
      <div className="nx-actions">
        <button className="nx-btn" disabled={saving || !dirty} onClick={save}>
          {saving ? t('admin.recordings.saving') : saved ? t('admin.recordings.saved') : t('admin.recordings.save')}
        </button>
      </div>
    </>
  );
}
