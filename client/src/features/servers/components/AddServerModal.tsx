import { useState, type FormEvent } from 'react';
import { useT } from '@/shared/i18n';
import { InputSenha } from '@/shared/ui/input-senha';
import { MODAL_MEMORY, buildBase, readLastConnection, saveLastConnection } from '@/shared/utils/server-fields';

// Modal "Connect server" (spec 2026-10-30, 5.2): campos IP/porta/usuário/senha, base
// {scheme}://{ip}:{porta} com o scheme da página. O LOGIN é do chamador (App -> useServers.addServer),
// que devolve a mensagem de erro ou null — o componente não conhece o registry (interface mínima).
// Sem portão de capacidade: qualquer logado conecta (D4).
type Props = {
  existingBases: string[];
  onSubmit: (base: string, user: string, password: string) => Promise<string | null>;
  onClose: () => void;
};

export default function AddServerModal({ existingBases, onSubmit, onClose }: Props) {
  const { t } = useT();
  // spec 2026-10-30 (memoria-conexao-independente): prefill pela ultima conexao da MODAL; sem memoria, a pagina.
  const [last] = useState(() => readLastConnection(MODAL_MEMORY));
  const [ip, setIp] = useState(last.host);
  const [port, setPort] = useState(last.port);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const p = port.trim();
    const base = buildBase(window.location.protocol, ip.trim(), p);
    if (existingBases.includes(base)) {
      setError(t('servers.already_connected'));
      setBusy(false);
      return;
    }
    const msg = await onSubmit(base, user, password);
    setBusy(false);
    if (msg) setError(msg); // 'http <status> · <mensagem>' chega pronto do chamador (api.ts httpError)
    else { saveLastConnection(MODAL_MEMORY, ip.trim(), p); onClose(); } // sucesso: so aqui, so no par da modal
  }

  return (
    <div className="nx-backdrop">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <form className="nx-dialog nx-dialog-menor nx-dialog-cartao" role="dialog" aria-modal="true" aria-labelledby="add-server-title" onSubmit={submit}>
        {/* invariante do repo (modal-invariante.test.ts): todo .nx-dialog renderiza .nx-close */}
        <div className="nx-titlebar">
          <span className="nx-title" id="add-server-title">{t('servers.connect_title')}</span>
          <button type="button" className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>
        <div className="nx-cartao">
          <div className="server-port-row">
            <label>{t('auth.server')}
              <input value={ip} onChange={(e) => setIp(e.target.value)} required autoFocus />
            </label>
            <label className="sp-port">{t('servers.port')}
              <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <label>{t('auth.username')}
            <input value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="username" />
          </label>
          <label>{t('auth.password')}
            <InputSenha><input value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></InputSenha>
          </label>
          {error && <p className="banner" role="alert">{error}</p>}
          <div className="nx-actions">
            <button type="button" className="nx-btn" onClick={onClose}>{t('shared.cancel')}</button>
            <button type="submit" className="nx-btn" disabled={busy}>{t('servers.add')}</button>
          </div>
        </div>
      </form>
    </div>
  );
}
