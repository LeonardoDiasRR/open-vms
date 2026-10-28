import { useRef, useState, type FormEvent } from 'react';
import { useT } from '@/shared/i18n';
import type { MessageKey } from '@/shared/i18n/en';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { InputSenha } from '@/shared/ui/input-senha';
// amendment E8 (Gate 3): shared/components — guard F6 forbids features/auth importing features/admin
import FormGravacoes from '@/shared/components/FormGravacoes';
import { parseRetention } from '@/shared/constants/retencao';
import type { ApiClient, Settings } from '@/shared/utils/api';

// spec 2026-10-19 (onboarding): two-step first-use modal. NO ✕ and NO Esc (D3): no way out
// until both steps are done — that is why this file is the NOMINAL exception of
// `shared/modal-invariante.test.ts` (amendment §5.5). The API does not change: step 1 calls
// change-password with the temporary password the login itself provided (D1); step 2 applies
// retention and limit on Finish (D4; spec 2026-10-19 root folder: no archive_dir — read only).
// ApiClient.changePassword already adopts the new token on the instance (api.ts) — the step 2
// PATCH goes out with the live token.
type Api = Pick<ApiClient, 'changePassword' | 'settings' | 'settingsPatch'>;
const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

export default function OnboardingWizard({ api, loginPassword, onDone }: {
  api: Api; loginPassword: string; onDone: (token: string) => void;
}) {
  const { t } = useT();
  const [step, setStep] = useState<1 | 2>(1);
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(''); // step 1 keeps it; the App stores it on success (§5.4)
  const [cfg, setCfg] = useState<Settings | null>(null);
  const [days, setDays] = useState('');
  const [pct, setPct] = useState(80);
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref); // focus yes; Esc NO — this modal does not close (D3)

  async function advance(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) { setError(t('auth.passwords_mismatch')); return; }
    setBusy(true);
    try {
      const out = await api.changePassword(loginPassword, next); // the length policy is the server's
      setToken(out.token);
      const c = await api.settings(); // pre-filled defaults already with the NEW token (D4/§5.4)
      setCfg(c); setDays(String(c.retention_days)); setPct(c.disk_max_percent);
      setStep(2);
    } catch (err) { setError(errorMessage(err, t('auth.change_password_failed'))); } finally { setBusy(false); }
  }

  async function finish() {
    if (!cfg) return;
    setError(null);
    const p = parseRetention(days); // same rule as the server; blocks the invalid submit (D4)
    if (!p.ok) { setError(t(p.errorKey as MessageKey)); return; }
    setBusy(true);
    try {
      await api.settingsPatch({ retention_days: p.value, disk_max_percent: pct });
      onDone(token); // §5.4: the App wipes the in-memory password and mounts the shell
    } catch (err) { setError(errorMessage(err, t('auth.recordings_save_failed'))); setBusy(false); }
  }

  const value = cfg && { s: cfg, days, pct };
  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-menor" role="dialog" aria-modal="true" aria-labelledby="ob-title" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="ob-title">{t('auth.onboarding_title')}</span>
        </div>
        {/* ponytail: step indicator and plain text (spec §5.3, no graphical stepper). `admin.tab.recordings`
            is the only "Recordings" label in the dictionary — `auth.recordings` is missing. */}
        <p className="muted" style={{ margin: '10px 14px 0' }}>
          {t('auth.step', { step, total: 2 })} · {step === 1 ? t('auth.admin_password') : t('admin.tab.recordings')}
        </p>
        {step === 1 ? (
          <form className="nx-body" onSubmit={advance}>
            <p className="muted">{t('auth.temporary_password_notice')}</p>
            <label className="nx-field"><span className="nx-label">{t('auth.new_password')}</span>
              <InputSenha><input className="nx-input" autoFocus value={next} onChange={(e) => setNext(e.target.value)} /></InputSenha></label>
            <label className="nx-field"><span className="nx-label">{t('auth.confirm_new_password')}</span>
              <InputSenha><input className="nx-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></InputSenha></label>
            {error && <p className="nx-err">{error}</p>}
            <div className="nx-actions">
              <button className="nx-btn" type="submit" disabled={busy || !next || next !== confirm}>
                {busy ? t('auth.advancing') : t('auth.next')}
              </button>
            </div>
          </form>
        ) : (
          <div className="nx-body">
            {value && (
              <FormGravacoes value={value} busy={busy}
                onDays={setDays} onPercent={setPct} />
            )}
            {error && <p className="nx-err">{error}</p>}
            <div className="nx-actions">
              <button className="nx-btn" disabled={busy} onClick={finish}>
                {busy ? t('auth.finishing') : t('auth.finish')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
