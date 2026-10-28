import * as React from 'react'
import { useState } from 'react'
import { useT } from '@/shared/i18n'

// spec 2026-10-27: the login page already carried the show/hide eye; every other password field
// now wraps its input here so the behavior and the accessible labels stay identical. The child
// keeps its own element and classes (the app has three input styles); only `type` is controlled.
function InputSenha({ children }: { children: React.ReactElement<{ type?: string }> }) {
  const { t } = useT()
  const [show, setShow] = useState(false)
  const label = show ? t('auth.hide_password') : t('auth.show_password')
  return (
    <span className="pw-field">
      {React.cloneElement(children, { type: show ? 'text' : 'password' })}
      <button type="button" className="pw-toggle" onClick={() => setShow((s) => !s)}
        aria-label={label} aria-pressed={show} title={label}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {show
            ? <><path d="M2 12s3.6-7 10-7c1.7 0 3.2.5 4.4 1.2M22 12s-3.6 7-10 7c-1.7 0-3.2-.5-4.4-1.2" /><path d="M3 3l18 18" /></>
            : <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>}
        </svg>
      </button>
    </span>
  )
}

export { InputSenha }
