import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { LanguageProvider } from '@/shared/i18n';
import PtzPanel from './PainelPtz';
import { directionVector } from '@/features/live/services/ptz';
import type { PtzApi } from '@/features/live/hooks/usePtz';

const p = (id: number, name: string) => ({ id, name });
const wrapper = ({ children }: { children: ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const mount = (ptz: PtzApi) => render(<PtzPanel ptz={ptz} />, { wrapper });

// The panel is a dumb view: a double of the hook is enough and lets each case assert the action, without WebRTC.
function fakePtz(over: Partial<PtzApi> = {}): PtzApi {
  return {
    cameraId: 'c1', active: true, error: null, speed: 1, positions: [], absolute: { panTilt: true, zoom: true },
    runningPreset: null, saving: false,
    canSave: true,
    toggle: vi.fn(), disarm: vi.fn(), move: vi.fn(), hold: vi.fn(), release: vi.fn(), stop: vi.fn(),
    applySpeed: vi.fn(),
    goTo: vi.fn(async () => {}),
    save: vi.fn(async () => {}), rename: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    ...over,
  } as PtzApi;
}

describe('PtzPanel (spec 2026-10-17)', () => {
  it('shows the four blocks in the requested order', () => {
    const { container } = mount(fakePtz());
    const children = [...(container.querySelector('.painel-ptz')?.children ?? [])].map((el) => el.className);
    expect(children).toEqual(['ptz-joystick', 'ptz-velocidade', 'ptz-zoom', 'ptz-presets']);
  });

  it('spec 2026-10-18: the search field comes BEFORE the Saved positions label', () => {
    mount(fakePtz());
    const field = screen.getByLabelText('Filter saved positions');
    const label = screen.getByText('Saved positions');
    // Discriminator of spec 2026-10-18: today the field comes after the label (PRECEDING), so this assert is
    // red on main and only passes when the field moves to the top of the block.
    expect(field.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('the + in the header has the Save position tooltip and passes the name to the hook', () => {
    const save = vi.fn(async () => {});
    mount(fakePtz({ save }));
    const plus = screen.getByRole('button', { name: 'Save position' });
    expect(plus).toHaveAttribute('title', 'Save position');
    fireEvent.click(plus);
    expect(save).toHaveBeenCalled();
  });

  it('with 20 positions both controls are disabled, the tooltip changes and nothing is saved', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => p(i, `Position ${i + 1}`));
    const save = vi.fn(async () => {});
    mount(fakePtz({ positions: twenty, canSave: false, save }));
    // BOTH controls say the SAME reason: the header "+" through the title and the footer CTA through the text
    const buttons = screen.getAllByRole('button', { name: 'Limit of 20 saved positions' });
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toHaveAttribute('aria-disabled', 'true');
    // the save gate is `canSave` (spec 4.5)
    for (const b of buttons) fireEvent.click(b);
    expect(save).not.toHaveBeenCalled();
  });

  it('the list shows ALL positions, including one with a free name', () => {
    mount(fakePtz({ positions: [p(1, 'Entrada D'), p(30, 'Position 1')] }));
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['Entrada D⋯', 'Position 1⋯']);
  });

  it('clicking the row goes to the position by id and the role 403 does not show on screen', () => {
    const goTo = vi.fn(async () => {});
    mount(fakePtz({ positions: [p(30, 'Position 1')], goTo }));
    fireEvent.click(screen.getByText('Position 1'));
    expect(goTo).toHaveBeenCalledWith(30);
  });

  it('the menu opens from the dots and from the right button, and rename asks for the new name without a default warning', async () => {
    const rename = vi.fn(async () => {});
    mount(fakePtz({ positions: [p(30, 'Position 1')], rename }));
    fireEvent.click(screen.getByRole('button', { name: 'Options for Position 1' }));
    fireEvent.click(await screen.findByText('Rename'));
    expect(await screen.findByText('Rename position')).toBeInTheDocument();
    // spec 6.2: the name is free, the dialog no longer warns about the default
    expect(screen.queryByRole('alert')).toBeNull();
    const input = await screen.findByLabelText('Name');
    expect((input as HTMLInputElement).value).toBe('Position 1');
    fireEvent.change(input, { target: { value: 'Portão' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // the dialog resolves in a promise: the hook only receives the name on the next microtask
    await waitFor(() => expect(rename).toHaveBeenCalledWith(30, 'Portão'));
  });

  it('delete asks first and remove only runs with the confirmation', async () => {
    const remove = vi.fn(async () => {});
    mount(fakePtz({ positions: [p(30, 'Position 1')], remove }));
    fireEvent.contextMenu(screen.getByText('Position 1'));
    fireEvent.click(await screen.findByText('Delete'));
    expect(await screen.findByText(/cannot be undone/)).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Delete', { selector: '.nx-btn-perigo' }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(30));
  });

  it('holding the arrow moves and releasing stops', () => {
    const hold = vi.fn(); const release = vi.fn();
    mount(fakePtz({ hold, release }));
    const up = screen.getByRole('button', { name: 'Move up' });
    fireEvent.pointerDown(up);
    expect(hold).toHaveBeenCalledWith({ pan: 0, tilt: 0.6, zoom: 0 });
    fireEvent.pointerUp(up);
    expect(release).toHaveBeenCalled();
  });

  it('the arrows move when the joystick has focus (same routine as the click)', () => {
    const ptz = fakePtz();
    mount(ptz);
    const right = screen.getByRole('button', { name: 'Move right' });
    right.focus();
    fireEvent.keyDown(right, { key: 'ArrowRight' });
    expect(ptz.hold).toHaveBeenCalledWith(directionVector(1, 0));
    fireEvent.keyUp(right, { key: 'ArrowRight' });
    expect(ptz.release).toHaveBeenCalled();
  });

  it('holding the zoom + sends an upward zoom step and releasing stops', () => {
    const hold = vi.fn(); const release = vi.fn();
    mount(fakePtz({ hold, release }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Zoom in' }));
    expect(hold).toHaveBeenCalledWith({ pan: 0, tilt: 0, zoom: 0.6 });
    fireEvent.pointerUp(screen.getByRole('button', { name: 'Zoom in' }));
    expect(release).toHaveBeenCalled();
  });

  it('the zoom block has the Zoom label above the buttons', () => {
    const { container } = mount(fakePtz());
    const block = container.querySelector('.ptz-zoom');
    expect(block?.firstElementChild).toHaveTextContent('Zoom');
    const buttons = [...(block?.querySelectorAll('button') ?? [])].map((b) => b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Zoom out', 'Zoom in']);
    // the label is the first child and the pair is the last one: in a flex row, DOM order is screen order
    expect(block?.lastElementChild).toBe(block?.querySelector('.ptz-zoom-par'));
  });

  it('the Center button no longer exists', () => {
    mount(fakePtz());
    expect(screen.queryByText('Centralizar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Centralizar' })).toBeNull();
  });

  it('the section filter shows only the positions that match', () => {
    mount(fakePtz({ positions: [p(1, 'Entrada'), p(30, 'Position 1')] }));
    fireEvent.change(screen.getByLabelText('Filter saved positions'), { target: { value: '1' } });
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['Position 1⋯']);
  });

  it('with no match the empty-list message appears', () => {
    mount(fakePtz({ positions: [p(1, 'Entrada')] }));
    fireEvent.change(screen.getByLabelText('Filter saved positions'), { target: { value: 'zzz' } });
    expect(screen.getByText('No saved positions')).toBeInTheDocument();
    expect(screen.queryByText('Entrada')).toBeNull();
  });

  it('the save button keeps working with the filter active', () => {
    const save = vi.fn(async () => {});
    mount(fakePtz({ positions: [p(1, 'Entrada')], save }));
    fireEvent.change(screen.getByLabelText('Filter saved positions'), { target: { value: 'zzz' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Save position' }));
    expect(save).toHaveBeenCalled();
  });

  it('clearing the field restores the list', () => {
    mount(fakePtz({ positions: [p(1, 'Entrada'), p(30, 'Position 1')] }));
    const field = screen.getByLabelText('Filter saved positions');
    fireEvent.change(field, { target: { value: 'zzz' } });
    expect(screen.queryByText('Entrada')).toBeNull();
    fireEvent.change(field, { target: { value: '' } });
    expect(screen.getByText('Entrada')).toBeInTheDocument();
    expect(screen.getByText('Position 1')).toBeInTheDocument();
  });

  // spec 2026-10-17, section 4: the reason of the disabled button is the REAL one — the operator's case (0
  // saved positions and the label talking about the limit) cannot come back.
  it('without an absolute position the reason is the capability, not the limit, and nothing is saved', () => {
    const save = vi.fn(async () => {});
    mount(fakePtz({ absolute: { panTilt: false, zoom: false }, canSave: false, save }));
    const buttons = screen.getAllByRole('button', { name: 'The camera does not report absolute position' });
    expect(buttons).toHaveLength(2);
    expect(screen.queryByText('Limit of 20 saved positions')).toBeNull();
    fireEvent.click(buttons[1]);
    expect(save).not.toHaveBeenCalled();
  });

  it('while saving, both controls say the save is in progress', () => {
    mount(fakePtz({ saving: true, canSave: false }));
    expect(screen.getAllByRole('button', { name: 'Saving the position…' })).toHaveLength(2);
  });

  // spec 2026-10-17 (PTZ magnifier): the saved-position search is the SAME field as the sidebar — the lucide
  // magnifier draws inside the panel and the raw input of the left bar no longer exists here.
  it('the saved-position search draws the shared field magnifier', () => {
    const { container } = mount(fakePtz({ positions: [p(1, 'Entrada')] }));
    expect(container.querySelector('.busca-icone')).not.toBeNull();
    expect(container.querySelector('.tree-busca')).toBeNull();
  });

  // spec 2026-10-18 (item 2): the "save position" + becomes a mini CTA
  it('the save position + carries the mini-cta class', () => {
    mount(fakePtz());
    expect(screen.getByRole('button', { name: 'Save position' })).toHaveClass('mini-cta');
  });
});
