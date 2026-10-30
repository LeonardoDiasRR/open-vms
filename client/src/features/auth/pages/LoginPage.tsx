import { useState, type FormEvent } from 'react';
import { useT, type Language } from '@/shared/i18n';
import { InputSenha } from '@/shared/ui/input-senha';
import { ApiClient } from '@/shared/utils/api';
import { buildBase, readLastConnection, saveLastConnection } from '@/shared/utils/server-fields';
import type { Capability } from '@/shared/domain/capabilities';

const TOKEN_KEY = 'openvms.token';

// spec 2026-10-19 (onboarding D1): the TYPED PASSWORD and first_run go up to the App with the session.
// The password lives only in App memory (§8.3); first_run is the server truth (login §5.1).
type Props = {
  onLogin: (s: { api: ApiClient; user: string; profile: string; capabilities: Capability[]; mustChangePassword: boolean; firstRun: boolean; loginPassword: string }) => void;
};

// The fetch/API error is an Error with .status attached by hand (see api.mjs), no own type
// in the JS module: the status comes out by narrowing, not by cast.
function errorMessage(err: unknown, fallback: string) {
  const status = typeof err === 'object' && err !== null && 'status' in err && typeof err.status === 'number'
    ? err.status : 0;
  const detail = err instanceof Error && err.message ? err.message : fallback;
  return `${status ? `http ${status} · ` : ''}${detail}`;
}

export default function LoginPage({ onLogin }: Props) {
  const { t, lang, setLang } = useT();
  // spec 2026-10-30: Server e Port vem da memoria da ultima conexao (legado: URL inteira decomposta).
  const [last] = useState(readLastConnection);
  const [server, setServer] = useState(last.host);
  const [port, setPort] = useState(last.port);
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = port.trim();
      const api = new ApiClient(buildBase(window.location.protocol, server.trim(), p));
      const session = await api.login(user, password);
      saveLastConnection(server.trim(), p);
      sessionStorage.setItem(TOKEN_KEY, session.token);
      // F4 (spec §10): the profile and the flag go up to the App — the client keeps no role at all.
      onLogin({ api, user: session.username, profile: session.profile_id, capabilities: session.capabilities as Capability[],
        mustChangePassword: session.must_change_password === true,
        firstRun: session.first_run === true, loginPassword: password });
    } catch (err) {
      setError(errorMessage(err, t('auth.connection_failed')));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <div className="login-language">
        <select className="lang-select" aria-label={t('topbar.language')}
          value={lang} onChange={(e) => setLang(e.target.value as Language)}>
          <option value="pt-BR">Português (Brasil)</option>
          <option value="en">English</option>
        </select>
      </div>
      <div className="login-content">
        <div className="login-brand" role="img" aria-label="OpenVMS">
          <svg viewBox="0 0 370 78" aria-hidden="true" focusable="false">
            <circle cx="39" cy="39" r="33" fill="none" stroke="currentColor" strokeWidth="5.5" />
            <path d="M31 24 Q31 22 33 23 L55 37 Q58 39 55 41 L33 55 Q31 56 31 54 Z" fill="currentColor" />
            <text x="82" y="56" fontFamily="Segoe UI, Arial, sans-serif" fontSize="59" fontWeight="400" letterSpacing="-2">
              <tspan className="login-brand-open">Open</tspan><tspan className="login-brand-vms" fontWeight="500">VMS</tspan>
            </text>
          </svg>
        </div>
        <form className="login-card" onSubmit={submit}>
          <div className="login-heading">
            <h1>{t('auth.login_title')}</h1>
            <p>{t('auth.login_description')}</p>
          </div>
          <div className="server-port-row">
            <label>
              {t('auth.server')}
              <input value={server} onChange={(e) => setServer(e.target.value)} spellCheck="false" />
            </label>
            <label className="sp-port">
              {t('auth.port')}
              <input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" />
            </label>
          </div>
          <label>
            {t('auth.username')}
            <input value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
          </label>
          <label>
            {t('auth.password')}
            <InputSenha>
              <input value={password} onChange={(e) => setPassword(e.target.value)}
                aria-label={t('auth.password')} />
            </InputSenha>
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" className="nx-btn" disabled={busy}>{busy ? t('auth.connecting') : t('auth.sign_in')}</button>
        </form>
        <div className="login-footer">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5l-8-3Z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
          {t('auth.secure_access')}
        </div>
      </div>
    </main>
  );
}
