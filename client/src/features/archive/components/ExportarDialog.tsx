import { useEffect, useRef, useState } from 'react';
import type { ApiClient, ExportJob } from '@/shared/utils/api';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { useT } from '@/shared/i18n';

// spec 2026-10-19 (video-export, section 5): the export modal (prototype). House Dialog (Radix).
// After the POST the modal itself becomes the job CARD: "Exporting… N%" with a bar, "Finished!"
// with a link, or the error. 2 s polling of GET /exports while the job of this modal is not
// terminal — it stops on completion, on error and on close (no orphan loop). Closing does NOT cancel
// the job (it belongs to the server and stays alive in the sidebar — section 7).

const LIMIT_S = 1800;
const MAX_DESC = 50;   // plan 2026-10-23: the description becomes the file name. The server cuts at 50
const errMessage = (e: unknown) => `${e instanceof Error ? e.message : String(e)}`.trim();

export type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: ApiClient;
  cameras: { profileId: string; name: string }[];   // only the ones with a recording profile
  defaultProfile?: string | null;                   // profile of the camera selected on the stage
  day: number;                                      // epoch of the local 00:00 (the sheet picker)
  onCreated?: () => void;   // defect 2026-10-25: the right panel did not know about the new export
};

// LOCAL date in YYYY-MM-DD and time HH:MM. Never toISOString (same rule as BottomSheet).
const formatDate = (ep: number) => {
  const d = new Date(ep * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const formatTime = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const localEpoch = (date: string, time: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date), h = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !h) return null;
  return Math.floor(new Date(+m[1], +m[2] - 1, +m[3], +h[1], +h[2], 0, 0).getTime() / 1000);
};
// Prototype default: 30 min ending at the current instant (clamped at 00:00 — the UI is local).
const endTimeNow = () => formatTime(new Date());
const startTimeNow = () => {
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const d = new Date(now.getTime() - LIMIT_S * 1000);
  return formatTime(d > midnight ? d : midnight);   // clamp: never before 00:00 of the day
};

const terminal = (j?: ExportJob | null) => !!j && j.state !== 'queued' && j.state !== 'exporting';

export default function ExportDialog({ open, onOpenChange, api, cameras, defaultProfile = null, day, onCreated }: Props) {
  const { t } = useT();
  const [profile, setProfile] = useState(defaultProfile || cameras[0]?.profileId || '');
  const [date, setDate] = useState(() => formatDate(day));
  const [startTime, setStartTime] = useState(startTimeNow);
  const [endTime, setEndTime] = useState(endTimeNow);
  const [descricao, setDescricao] = useState('');
  const descLimpa = descricao.replace(/\s+/g, ' ').trim();
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJob | null>(null);
  const alive = useRef(false);

  // closing returns the modal to the form (section 7: progress stays visible in the SIDEBAR)
  const close = (open: boolean) => {
    if (!open) { alive.current = false; setJob(null); setError(null); }
    onOpenChange(open);
  };

  // ArchiveView always mounts this dialog; on the 1st render the camera list is still empty and
  // profile is born ''. Without syncing here, the select shows the camera but the state stays ''
  // forever and the button never enables (defect 2026-10-19).
  useEffect(() => {
    if (profile && cameras.some((c) => c.profileId === profile)) return;
    setProfile(defaultProfile && cameras.some((c) => c.profileId === defaultProfile)
      ? defaultProfile
      : cameras[0]?.profileId || '');
  }, [cameras, defaultProfile, profile]);

  // polling of THIS modal job: every 2 s while not terminal; dies on unmount and on terminal
  useEffect(() => {
    const id = job?.id;
    if (!open || !id || terminal(job)) return;
    alive.current = true;
    const timer = setInterval(async () => {
      try {
        const list = await api.exports();
        if (!alive.current) return;
        const j = list.find((x) => x.id === id);
        if (j) setJob(j);
      } catch { /* the next tick tries again */ }
    }, 2000);
    return () => { alive.current = false; clearInterval(timer); };
  }, [open, job, api]);

  const start = localEpoch(date, startTime), end = localEpoch(date, endTime);
  const valid = !!profile && start !== null && end !== null && end > start && end - start <= LIMIT_S
    && descLimpa.length > 0;
  const reason = !profile ? t('archive.select_camera')
    : start === null || end === null ? t('archive.enter_datetime')
    : end <= start ? t('archive.end_after_start')
    : end - start > LIMIT_S ? t('archive.max_period')
    : !descLimpa ? t('archive.description_required') : null;

  async function submit() {
    if (!valid || start === null || end === null) return;
    setError(null);
    try {
      setJob(await api.exportRange({ stream_profile_id: profile, from: start, to: end, description: descLimpa }));
      onCreated?.();   // after the POST resolves — never in the catch (plan 2026-10-25)
    } catch (e) {
      setError(errMessage(e));   // 400/404/507 from the server: form becomes editable again (its answer wins)
    }
  }

  const reset = () => { setJob(null); setError(null); setEndTime(endTimeNow()); setStartTime(startTimeNow()); setDescricao(''); };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="exp-dialog">
        <DialogHeader><DialogTitle>{t('archive.export_video')}</DialogTitle></DialogHeader>
        {!job && (
          <div className="exp-form">
            <label>{t('archive.camera')}
              <select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label={t('archive.camera')}>
                {cameras.map((c) => <option key={c.profileId} value={c.profileId}>{c.name}</option>)}
              </select>
            </label>
            <label>{t('archive.date')}
              <input type="date" className="nx-input" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t('archive.start_date')} />
            </label>
            <div className="sheet-linha">
              <label>{t('archive.start')}
                <input type="time" className="nx-input" value={startTime} onChange={(e) => setStartTime(e.target.value)} aria-label={t('archive.start_time')} />
              </label>
              <label>{t('archive.end')}
                <input type="time" className="nx-input" value={endTime} onChange={(e) => setEndTime(e.target.value)} aria-label={t('archive.end_time')} />
              </label>
            </div>
            <div>
              <div className="exp-desc-rotulo">
                <label htmlFor="exp-desc">{t('archive.description')}<span className="obrig">*</span></label>
                <span className={`exp-desc-conta${descricao.length >= MAX_DESC ? ' limite' : ''}`}>{descricao.length}/{MAX_DESC}</span>
              </div>
              <input id="exp-desc" className="nx-input" maxLength={MAX_DESC} value={descricao}
                placeholder={t('archive.description_placeholder')}
                aria-label={t('archive.description')}
                onChange={(e) => setDescricao(e.target.value.slice(0, MAX_DESC))} />
              <p className="muted exp-desc-dica">{t('archive.description_hint')}</p>
            </div>
            {reason && <p className="exp-msg" role="alert">{reason}</p>}
            {error && <p className="exp-msg" role="alert">{error}</p>}
            <button type="button" className="nx-btn" disabled={!valid} onClick={submit}>{t('archive.export')}</button>
            <p className="muted">{t('archive.export_hint')}</p>
          </div>
        )}
        {job && (
          <div className="exp-cartao">
            {job.state === 'queued' && <p>{t('archive.queued')}</p>}
            {job.state === 'exporting' && (
              <p>{t('archive.exporting', { n: job.progress ?? 0 })}
                <span className="exp-barra"><span className="exp-fill" style={{ width: `${job.progress ?? 0}%` }} /></span>
              </p>
            )}
            {(job.state === 'ready' || job.state === 'done') && (
              <p>{t('archive.done')}{' '}
                <a href={`${api.base}/api/v1/exports/${job.id}/file?token=${api.token}`} download={job.name || 'export.mp4'}>
                  {job.name || t('archive.download')}
                </a>
              </p>
            )}
            {job.state === 'error' && <p className="exp-msg" role="alert">{t('archive.error_prefix', { message: job.error || t('archive.export_failed') })}</p>}
            {(terminal(job) || job.state === 'error') && <button type="button" onClick={reset}>{t('archive.export_another')}</button>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
