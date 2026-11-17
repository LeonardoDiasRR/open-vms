import { useRef, useState } from 'react';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';

// the fetch/API error is an Error with .status glued on by hand (see api.ts) — same narrowing as the
// settings modal (CameraSettingsModal.tsx:12).
const statusOf = (e: unknown): number =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : 0;

type Props = {
  cameraName: string;
  // o username atual vem do GET config; a senha NÃO vem de lugar nenhum (cofre selado, spec § 3.3)
  currentUser: string | null;
  onSave(username: string, password: string): Promise<unknown>;
  onClose: () => void;
};

// spec 2026-11-17 (editar credenciais): protótipo aprovado 2026-11-17. Login pré-preenchido, senha
// sempre vazia no abrir. 400 (recusa da sonda) mantém a modal aberta com o erro; sucesso fecha em 1,5 s.
export default function CredentialsModal({ cameraName, currentUser, onSave, onClose }: Props) {
  const { t } = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);
  const [username, setUsername] = useState(currentUser || '');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  useEsc(() => { if (!saving) onClose(); });
  const save = async () => {
    setSaving(true); setError(null);
    try {
      await onSave(username, password);
      setDone(true);
      setTimeout(onClose, 1500);
    } catch (e) {
      setError(statusOf(e) === 400 ? t('cameras.settings.credentials_refused') : t('errors.action_failed'));
      setSaving(false);
    }
  };
  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-credenciais" role="dialog" aria-modal="true" aria-labelledby="cred-title" ref={dialogRef}>
        <div className="nx-titlebar">
          <span className="nx-title" id="cred-title">{t('cameras.settings.credentials_title', { name: cameraName })}</span>
          <button className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>
        <div className="nx-body">
          <p className="nx-aviso">{t('cameras.settings.credentials_note')}</p>
          <label className="nx-cred-rotulo" htmlFor="cred-user">{t('cameras.settings.credentials_user')}</label>
          <input id="cred-user" className="nx-input" value={username} autoComplete="username" disabled={saving || done}
            onChange={(e) => setUsername(e.target.value)} />
          <label className="nx-cred-rotulo" htmlFor="cred-pass">{t('cameras.settings.credentials_pass')}</label>
          <input id="cred-pass" className="nx-input" type="password" value={password} autoComplete="new-password"
            placeholder={t('cameras.settings.credentials_pass_placeholder')} disabled={saving || done}
            onChange={(e) => setPassword(e.target.value)} />
          {error && <p className="nx-err">{error}</p>}
          {done && <p className="nx-cred-ok">{t('cameras.settings.credentials_saved')}</p>}
          <div className="nx-actions">
            <button className="nx-btn" onClick={onClose} disabled={saving}>{t('cameras.settings.credentials_cancel')}</button>
            <button className="nx-btn" disabled={!password || saving || done} onClick={save}>
              {saving ? t('shared.saving') : t('cameras.settings.save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
