import { describe, it, expect } from 'vitest'
// ponytail: @testing-library/user-event is not a dependency of this client; fireEvent.click is
// the convention used by every existing test here (App.test.tsx et al.). Same behavior, no new dep.
import { render, screen, fireEvent } from '@testing-library/react'
import { LanguageProvider } from '@/shared/i18n'
import { InputSenha } from './input-senha'

describe('InputSenha', () => {
  it('renders the child hidden behind the eye and toggles type, label and aria-pressed', () => {
    render(<LanguageProvider><InputSenha><input data-testid="pw" defaultValue="segredo" /></InputSenha></LanguageProvider>)
    const input = screen.getByTestId('pw')
    expect(input).toHaveAttribute('type', 'password')
    const eye = screen.getByRole('button', { name: 'Show password' })
    expect(eye).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(eye)
    expect(input).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('passes the child element through untouched (same node, same classes)', () => {
    render(<LanguageProvider><InputSenha><input className="nx-input" data-testid="pw" /></InputSenha></LanguageProvider>)
    expect(screen.getByTestId('pw')).toHaveClass('nx-input')
  })
})
