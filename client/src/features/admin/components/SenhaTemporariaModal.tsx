import { useEffect, useRef, useState } from 'react';
import type { Notify } from '@/shared/components/Toast';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';
import { copiarTexto, type TransporteCopiar } from '@/shared/utils/clipboard';

// plan 2026-11-06: a senha temporaria do reset de senha. O padrao visual e o do PromptDialog
// (nx-backdrop > nx-dialog nx-dialog-menor), medido no produto; o que muda e o conteudo: campo
// somente-leitura + botao de copiar e UM unico botao Fechar. Montado como IRMAO do dialog que o
// abriu, com `.nx-backdrop-alta` para ficar na frente dele.
// O fundo NAO fecha: a modal existe para obrigar a leitura do aviso "nao sera exibida novamente".
export default function SenhaTemporariaModal({ username, password, onClose, notify, copiar }: {
  username: string;
  password: string;
  onClose: () => void;
  notify: Notify;
  copiar?: TransporteCopiar;
}) {
  const t = useT().t;
  const ref = useRef<HTMLDivElement>(null);
  const [copiado, setCopiado] = useState(false);
  const timer = useRef<number | null>(null);
  useModalFocus(ref);
  useEsc(onClose);   // montado por ultimo: o ESC fecha esta modal, nao a de baixo
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);

  async function copiarSenha() {
    if (await copiarTexto(password, copiar)) {
      notify(t('admin.users.pwd_copied'), 'ok');
      setCopiado(true);
      timer.current = window.setTimeout(() => setCopiado(false), 1500);
    } else {
      notify(t('admin.users.pwd_copy_failed'), 'error');
    }
  }

  return (
    <div className="nx-backdrop nx-backdrop-alta">
      <div className="nx-dialog nx-dialog-menor" role="dialog" aria-modal="true" aria-labelledby="stm-titulo" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="stm-titulo">{t('admin.users.pwd_title', { name: username })}</span>
          <button className="nx-close" onClick={onClose} title={t('admin.users.pwd_close')}
            aria-label={t('admin.users.pwd_close')}>✕</button>
        </div>
        <div className="nx-body">
          <p>{t('admin.users.pwd_warning')} <strong>{t('admin.users.pwd_warning_strong')}</strong>.</p>
          <p>{t('admin.users.pwd_second_a')} <strong>{username}</strong> {t('admin.users.pwd_second_b')}</p>
          <div className="nx-field">
            <label className="nx-label" htmlFor="stm-campo">{t('admin.users.pwd_label')}</label>
            <div className="nx-campo-senha">
              <input className="nx-input" id="stm-campo" readOnly value={password}
                spellCheck={false} autoComplete="off" autoFocus onFocus={(e) => e.target.select()} />
              <button className="nx-copiar" onClick={copiarSenha} title={t('admin.users.pwd_copy')}
                aria-label={t('admin.users.pwd_copy')}>{copiado ? '\u2713' : '\u29c9'}</button>
            </div>
            <p className="nx-senha-dica">{t('admin.users.pwd_hint')}</p>
          </div>
        </div>
        <div className="nx-actions">
          <button className="nx-btn" onClick={onClose}>{t('shared.close')}</button>
        </div>
      </div>
    </div>
  );
}
