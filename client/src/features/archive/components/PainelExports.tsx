import { useEffect, useState } from 'react';
import type { ApiClient, ExportJob } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';

// spec 2026-10-19 (video-export, section 6): the panel is the STATUS of the jobs. 2 s poll
// while a job is active, in a single timer. spec 2026-10-23: beyond the status, the panel selects
// clips and acts in batch: checkbox per item, Download/Delete bar at the foot, no link per row.
type Props = { api: Pick<ApiClient, 'base' | 'token' | 'exports' | 'deleteExports' | 'exportsZipUrl'>; tick: number };
type Confirmation = { ids: string[]; names: string[] } | null;
const ACTIVE = new Set(['queued', 'exporting']);
const p2 = (n: number) => String(n).padStart(2, '0');
const period = (x: ExportJob) => {
  const a = new Date(x.from_ts * 1000), b = new Date(x.to_ts * 1000);
  return `${p2(a.getDate())}/${p2(a.getMonth() + 1)} ${p2(a.getHours())}:${p2(a.getMinutes())}–${p2(b.getHours())}:${p2(b.getMinutes())}`;
};
const isDone = (x: ExportJob) => x.state === 'ready' || x.state === 'done';
const label = (x: ExportJob) => x.description || x.name || x.camera_name || x.stream_profile_id || 'export';
// plan 2026-10-23: readable size. Fixed decimal comma (the app i18n is manual).
const formatSize = (n?: number) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2).replace('.', ',')} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2).replace('.', ',')} GB`;
};

export default function ExportsPanel({ api, tick }: Props) {
  const { t } = useT();
  const [exports, setExports] = useState<ExportJob[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [notice, setNotice] = useState('');
  const [baixando, setBaixando] = useState(false);

  const [recarregar, setRecarregar] = useState(0);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchJobs = () => api.exports().then((x) => {
      if (stop) return;
      setExports(x);
      // the poll does not lose the selection. ids that left the list leave the selection
      setSel((prev) => new Set([...prev].filter((id) => x.some((j) => j.id === id && isDone(j)))));
      if (x.some((j) => ACTIVE.has(j.state))) timer = setTimeout(fetchJobs, 2000);
    }).catch(() => {});
    fetchJobs();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [api, tick, recarregar]);

  const prontos = exports.filter(isDone);
  const selected = prontos.filter((x) => sel.has(x.id));
  const ids = selected.map((x) => x.id);
  const toggle = (id: string) => setSel((prev) => {
    const n = new Set(prev);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });
  const toggleAll = () => {
    setSel((prev) => (prev.size === prontos.length ? new Set() : new Set(prontos.map((x) => x.id))));
  };
  const parcial = sel.size > 0 && sel.size < prontos.length;
  const todos = prontos.length > 0 && sel.size === prontos.length;

  const baixar = () => {
    if (!ids.length) return;
    setNotice('');
    setBaixando(true);
    setNotice(t('archive.zip_started', { n: ids.length }));
    window.open(api.exportsZipUrl(ids), '_blank');
    setTimeout(() => setBaixando(false), 800);
  };

  const remove = async () => {
    if (!confirmation) return;
    try {
      const r = await api.deleteExports(confirmation.ids);
      setConfirmation(null);
      setNotice(t('archive.deleted', { n: r.deleted.length }));
      setSel(new Set());
      setRecarregar((n) => n + 1);
    } catch (e) {
      const codigo = String((e as Error)?.message || '');
      setConfirmation(null);
      setNotice(codigo === 'export_active' ? t('archive.delete_active') : t('archive.delete_failed'));
    }
  };

  return (
    <div className="painel-exports">
      <h2>{t('archive.recent_exports')}</h2>
      {exports.length === 0 && <p className="muted">{t('archive.no_exports')}</p>}
      {prontos.length > 0 && (
        <label className="painel-exports-todos">
          <input type="checkbox" checked={todos} ref={(el) => { if (el) el.indeterminate = parcial; }}
            onChange={toggleAll} aria-label={t('archive.select_all')} />
          <span>{t('archive.select_all')}</span>
          <span className="muted">{sel.size === 0 ? t('archive.none_selected') : t('archive.n_selected', { n: sel.size })}</span>
        </label>
      )}
      {notice && <p className="exp-msg" role="status">{notice}</p>}
      <ul>
        {exports.map((x) => (
          <li key={x.id} className={sel.has(x.id) ? 'marcado' : ''}>
            {isDone(x) && (
              <input type="checkbox" checked={sel.has(x.id)} onChange={() => toggle(x.id)}
                aria-label={t('archive.select_item', { name: label(x) })} />
            )}
            <div className="painel-exports-card">
              <div className="painel-exports-nome">
                <span className="painel-exports-nome-texto" data-dica={label(x)}>{label(x)}</span>
                <span className={`badge ${isDone(x) ? 'online' : x.state === 'error' ? 'error' : 'provisioning'}`}
                  title={x.state === 'error' ? (x.error || '') : undefined}>
                  {isDone(x) ? t('archive.badge_done')
                    : x.state === 'exporting' ? t('archive.exporting', { n: x.progress ?? 0 })
                    : x.state === 'error' ? t('archive.badge_failed')
                    : t('archive.queued')}
                </span>
              </div>
              <div className="painel-exports-camera">{x.camera_name || x.stream_profile_id || 'export'}</div>
              <div className="painel-exports-item">{period(x)}{isDone(x) && formatSize(x.bytes) ? ` · ${formatSize(x.bytes)}` : ''}</div>
            </div>
          </li>
        ))}
      </ul>
      {ids.length > 0 && (
        <div className="painel-exports-acoes">
          <button className="nx-btn" onClick={baixar} disabled={baixando}>
            {baixando ? t('archive.download_preparing') : t('archive.download_n', { n: ids.length })}
          </button>
          <button className="nx-btn nx-btn-perigo" onClick={() => setConfirmation({ ids, names: selected.map(label) })}>
            {t('archive.delete_n', { n: ids.length })}
          </button>
        </div>
      )}
      {confirmation && (
        <div className="nx-backdrop" onClick={(e) => { if (e.target === e.currentTarget) setConfirmation(null); }}>
          <div className="nx-dialog" role="dialog" aria-label={t('archive.delete_title')}>
            <div className="nx-titlebar">
              <span className="nx-title">{t('archive.delete_title')}</span>
              <button className="nx-close" onClick={() => setConfirmation(null)} title={t('shared.close')}>✕</button>
            </div>
            <p>{t('archive.delete_confirm')}</p>
            <ul className="painel-exports-confirma">
              {confirmation.names.map((name) => <li key={name}>{name}</li>)}
            </ul>
            <p className="muted">{t('archive.delete_total', { n: confirmation.ids.length })}</p>
            <div className="nx-actions">
              <button className="nx-btn" onClick={() => setConfirmation(null)}>{t('shared.cancel')}</button>
              <button className="nx-btn nx-btn-perigo" onClick={remove}>{t('shared.delete')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
