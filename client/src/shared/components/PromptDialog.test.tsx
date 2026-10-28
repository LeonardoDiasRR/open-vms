import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import { usePromptDialog, PromptDialog } from './PromptDialog';

function Harness() {
  const d = usePromptDialog();
  const [res, setRes] = useState('');
  return (
    <>
      <button onClick={async () => setRes(String(await d.ask('novo nome', 'Nome', 'Cam 1')))}>ask</button>
      <button onClick={async () => setRes(String(await d.confirm('Confirmar exclusao?', ['1 camera', '1 pasta'], { danger: true, text: 'Excluir' })))}>confirm</button>
      <span data-testid="res">{res || '-'}</span>
      <PromptDialog request={d.request} onClosed={() => d.setRequest(null)} />
    </>
  );
}

// spec 2026-10-19: the labels come from the dictionary — the provider mounts with the default (en).
const renderDialog = () => render(<LanguageProvider><Harness /></LanguageProvider>);

describe('PromptDialog', () => {
  it('ask pre-selects the initial value and Enter resolves with the text', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('ask'));
    const input = await screen.findByLabelText('Nome');
    expect((input as HTMLInputElement).value).toBe('Cam 1');
    fireEvent.change(input, { target: { value: 'Nova' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('Nova'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('Cancel resolves null and OK stays disabled with empty text', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('ask'));
    const input = await screen.findByLabelText('Nome');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('OK')).toBeDisabled();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('null'));
  });
  it('multiline confirmation: danger resolves true; Esc resolves false', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('confirm'));
    expect(await screen.findByText('1 camera')).toBeInTheDocument();
    fireEvent.click(await screen.findByText('Excluir'));
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('true'));
    fireEvent.click(screen.getByText('confirm'));
    await screen.findByText('1 camera');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('false'));
  });
  it('two dialogs in sequence: each with ITS OWN initial (remount per request)', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('ask'));
    fireEvent.click(await screen.findByLabelText('Nome'));
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('null'));
    fireEvent.click(screen.getByText('ask'));
    await waitFor(() => expect((screen.getByLabelText('Nome') as HTMLInputElement).value).toBe('Cam 1'));
  });
  it('the X closes without saving, same action as Cancel', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('confirm'));
    await screen.findByText('1 camera');
    fireEvent.click(screen.getByTitle('Close'));
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('false'));
  });

  it('ESC closes with focus OUTSIDE the modal', async () => {
    renderDialog();
    fireEvent.click(screen.getByText('confirm'));
    await screen.findByText('1 camera');
    screen.getByText('confirm').focus();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('res').textContent).toBe('false'));
  });

  it('traps focus inside the modal and returns it to the trigger on close', async () => {
    renderDialog();
    const trigger = screen.getByText('ask');
    trigger.focus();
    fireEvent.click(trigger);
    await screen.findByLabelText('Nome');
    const dlg = screen.getByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.contains(document.activeElement)).toBe(true);
    const focusables = Array.from(dlg.querySelectorAll<HTMLElement>('button, input'));
    focusables[focusables.length - 1].focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(focusables[0]);
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
