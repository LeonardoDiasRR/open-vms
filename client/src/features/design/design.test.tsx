import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import DesignCatalog from './CatalogoDesign';
import { LanguageProvider } from '@/shared/i18n';

// The catalog is asserted section by section (spec M4). The title list is LITERAL on purpose: it repeats
// the component names so that removing a section fails here — importing the list from the component
// would make the assertion pass with the section deleted.
const SECOES = ['Button', 'Input', 'Badge', 'Switch', 'Dialog', 'PromptDialog', 'CameraStatus',
  'Spinner', 'Empty state', 'PTZ', 'Toast', 'Async states', 'Selects'];

const renderCatalog = () => render(<LanguageProvider><DesignCatalog /></LanguageProvider>);

describe('design system catalog (/design)', () => {
  it.each(SECOES)('section "%s" is in the catalog', (title) => {
    renderCatalog();
    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
  });

  it('the six Button variants, the disabled one and the loading one', () => {
    const { container } = renderCatalog();
    for (const v of ['default', 'destructive', 'outline', 'secondary', 'ghost', 'link']) {
      expect(container.querySelector(`[data-slot="button"][data-variant="${v}"]`)).not.toBeNull();
    }
    // the disabled one and the "loading" one (the spinner inside the button) — no `loading` of its own in
    // the primitive
    expect(screen.getByRole('button', { name: 'disabled' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Loading/ })).toBeDisabled();
  });

  it('the four CameraStatus states, and the recording one', () => {
    renderCatalog();
    // getAllByLabelText: the same state repeats in the "Async states" section (offline) and the catalog
    // badge lives alongside it — the assertion is "every spoken state appears at least once".
    for (const spoken of ['online', 'offline', 'error', 'provisioning', 'online, recording']) {
      expect(screen.getAllByLabelText(spoken).length).toBeGreaterThanOrEqual(1);
    }
  });

  it('the Radix Dialog opens by button', () => {
    renderCatalog();
    expect(screen.queryByText('Design system dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    expect(screen.getByText('Design system dialog')).toBeInTheDocument();
  });

  // A SEPARATE test from the Dialog on purpose: with the modal dialog open Radix marks the rest of the
  // page aria-hidden and the prompt button stops being reachable by role — the two cases in the same test
  // would only pass because of execution order.
  it('the PromptDialog opens by button, with the current name in the field', () => {
    renderCatalog();
    fireEvent.click(screen.getByRole('button', { name: 'Open prompt' }));
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Gate 1');
  });

  it('the stopped spinner and the empty state with an action', () => {
    const { container } = renderCatalog();
    const spinners = [...container.querySelectorAll<HTMLElement>('.cell-spinner')];
    expect(spinners.length).toBeGreaterThanOrEqual(3);        // 2 in the catalog + 1 in the loading button
    expect(spinners.filter((s) => s.style.animation === 'none').length).toBe(1);
    expect(screen.getByText('No cameras found')).toBeInTheDocument();
    expect(screen.getByText('No recording in this period')).toBeInTheDocument();
  });

  it('the eight async states are named', () => {
    renderCatalog();
    // getAllByText: the state name and its own sample can spell the same word (the "unavailable" badge) —
    // the assertion is "every state is named at least once", as in the CameraStatus case above.
    for (const name of ['idle', 'connecting', 'loading', 'success', 'empty', 'offline', 'unavailable', 'retry']) {
      expect(screen.getAllByText(name).length).toBeGreaterThanOrEqual(1);
    }
  });
});
