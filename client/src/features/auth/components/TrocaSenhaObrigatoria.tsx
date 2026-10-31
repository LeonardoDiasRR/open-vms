import { useRef, useState, type FormEvent } from 'react';
import { useT } from '@/shared/i18n';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { InputSenha } from '@/shared/ui/input-senha';
import type { ApiClient } from '@/shared/utils/api';

// spec §7.1.4/§12-F4: the MANDATORY modal. While `must_change_password` is pending the App
// does not mount the shell — the only way out is changing the password or leaving. The `nx-close`
// is required by the `shared/modal-invariante.test.ts` guard (substring scan) and does the only
// thing left: logout (E6).
// The length policy belongs to the SERVER (E5): here we only check that both typed passwords match.
type Api = Pick<ApiClient, 'changePassword'>;
const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

export default function ForcedPasswordChange({ api, onChanged, onExit }:
  { api: Api; onChanged: (token: string) => void; onExit: () => void }) {
  const { t } = useT();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  useEsc(onExit);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) { setError(t('auth.passwords_mismatch')); return; }
    setBusy(true);
    try {
      const out = await api.changePassword(current, next);
      onChanged(out.token);
    } catch (err) { setError(errorMessage(err, t('auth.change_password_failed'))); setBusy(false); }
  }

  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-menor" role="dialog" aria-modal="true" aria-labelledby="fpc-title" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="fpc-title">{t('auth.forced_password_title')}</span>
          <button className="nx-close" onClick={onExit} title={t('auth.logout')}>✕</button>
        </div>
        <form className="nx-body" onSubmit={submit}>
          <p className="muted">
            {t('auth.temporary_password_notice')}
          </p>
          <label className="nx-field"><span className="nx-label">{t('auth.current_password')}</span>
            <InputSenha><input className="nx-input" autoFocus value={current} onChange={(e) => setCurrent(e.target.value)} /></InputSenha></label>
          <label className="nx-field"><span className="nx-label">{t('auth.new_password')}</span>
            <InputSenha><input className="nx-input" value={next} onChange={(e) => setNext(e.target.value)} /></InputSenha></label>
          <label className="nx-field"><span className="nx-label">{t('auth.confirm_new_password')}</span>
            <InputSenha><input className="nx-input" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></InputSenha></label>
          {error && <p className="nx-err">{error}</p>}
          <div className="nx-actions">
            <button className="nx-btn" type="submit" disabled={busy || !current || !next || !confirm}>
              {busy ? t('auth.changing_password') : t('auth.change_password')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
