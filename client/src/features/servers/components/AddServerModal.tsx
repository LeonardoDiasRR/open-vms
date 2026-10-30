import { useState, type FormEvent } from 'react';
import { useT } from '@/shared/i18n';

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
  const [ip, setIp] = useState('');
  const [port, setPort] = useState(window.location.port); // pré-preenchida com a porta da página
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const p = port.trim();
    const base = `${window.location.protocol}//${ip.trim()}${p ? `:${p}` : ''}`;
    if (existingBases.includes(base)) {
      setError(t('servers.already_connected'));
      setBusy(false);
      return;
    }
    const msg = await onSubmit(base, user, password);
    setBusy(false);
    if (msg) setError(msg); // 'http <status> · <mensagem>' chega pronto do chamador (api.ts httpError)
    else onClose();        // sucesso: o chamador salva token/base e o poll começa; o modal fecha
  }

  return (
    <div className="nx-backdrop">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <form className="nx-dialog nx-dialog-menor" role="dialog" aria-modal="true" aria-labelledby="add-server-title" onSubmit={submit}>
        <h2 id="add-server-title">{t('servers.connect_title')}</h2>
        <label>{t('servers.ip')}
          <input value={ip} onChange={(e) => setIp(e.target.value)} required autoFocus />
        </label>
        <label>{t('servers.port')}
          <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
        </label>
        <label>{t('auth.username')}
          <input value={user} onChange={(e) => setUser(e.target.value)} required autoComplete="username" />
        </label>
        <label>{t('auth.password')}
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        </label>
        {error && <p className="banner" role="alert">{error}</p>}
        <div className="nx-actions">
          <button type="button" className="nx-btn" onClick={onClose}>{t('shared.cancel')}</button>
          <button type="submit" className="nx-btn" disabled={busy}>{t('servers.add')}</button>
        </div>
      </form>
    </div>
  );
}
