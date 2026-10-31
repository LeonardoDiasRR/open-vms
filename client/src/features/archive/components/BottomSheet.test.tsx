import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import BottomSheet from './BottomSheet';
import { LanguageProvider } from '@/shared/i18n';
import type { GlobalClock } from '../hooks/useRelogioGlobal';

const clock = (over?: Partial<GlobalClock>): GlobalClock => ({
  instant: 1000, playing: false, speed: 1, skipGaps: true,
  seek: vi.fn(), toggle: vi.fn(), setSpeed: vi.fn(), now: vi.fn(),
  setSkipGaps: vi.fn(), covered: () => true, atEdge: false, hole: null, ...over,
});

const Cameras = [{ id: 'c1', name: 'Câmera 1' }];
// 15/Oct/2026 00:00 local — fixed day so the date picker is deterministic
const DAY = Math.floor(new Date(2026, 9, 15, 0, 0, 0, 0).getTime() / 1000);

const props = (c: GlobalClock, over: Partial<ComponentProps<typeof BottomSheet>> = {}) => ({
  clock: c, open: false, onToggleOpen: vi.fn(), day: DAY, onDay: vi.fn(),
  cameras: Cameras, coverage: { c1: [{ start_ts: DAY + 3600, end_ts: DAY + 7200 }] }, ...over,
});

describe('BottomSheet', () => {
  it('collapsed: row with open options, play/pause, the 3 speed buttons, clock HH:MM:SS and the date picker with the current day', () => {
    const { container } = render(<BottomSheet {...props(clock())} />, { wrapper: LanguageProvider });
    expect(screen.getByRole('button', { name: 'More options' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    for (const v of [1, 2, 4]) {
      expect(screen.getByRole('button', { name: `${v}×` })).toBeInTheDocument();
    }
    // default speed of the mock = 1: only 1x is born pressed (D2)
    expect(screen.getByRole('button', { name: '1×' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '4×' })).toHaveAttribute('aria-pressed', 'false');
    const clockText = new Date(1000 * 1000).toTimeString().slice(0, 8);
    expect(container.querySelector('.sheet-relogio')?.textContent).toBe(clockText);
    expect(container.querySelector('.sheet-calendario')).toBeNull();
    expect(container.querySelector('.timeline-global')).toBeNull();
    // value comes from the `day` prop formatted LOCAL (no snapshot, ArchiveView hands today)
    expect((container.querySelector('.sheet-linha input[type=date]') as HTMLInputElement).value).toBe('2026-10-15');
  });

  // spec 2026-10-19 (video-export, section 4): the button is born AFTER the date picker and the
  // sheet only notifies the owner — it opens no modal and knows nothing about export.
  it('the Export button comes after the date picker and calls onExport', () => {
    const onExport = vi.fn();
    const { container } = render(<BottomSheet {...props(clock(), { onExport })} />, { wrapper: LanguageProvider });
    const row = container.querySelector('.sheet-linha')!;
    const btn = screen.getByRole('button', { name: 'Export' });
    const input = row.querySelector('input[type=date]')!;
    expect([...row.children].indexOf(btn)).toBeGreaterThan([...row.children].indexOf(input));
    fireEvent.click(btn);
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('play commands the clock; the 3 buttons go straight to the speed and the exclusivity derives from the state', () => {
    const c = clock({ playing: true });
    const { rerender } = render(<BottomSheet {...props(c)} />, { wrapper: LanguageProvider });
    expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(c.toggle).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '4×' }));
    expect(c.setSpeed).toHaveBeenLastCalledWith(4);
    // rerender with speed 4 (new mock): EXACTLY one pressed, the 4x — structural exclusivity
    const c4 = clock({ speed: 4 });
    rerender(<BottomSheet {...props(c4)} />);
    const pressed = screen.getAllByRole('button', { name: /\d×/ })
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent);
    expect(pressed).toEqual(['4×']);
    fireEvent.click(screen.getByRole('button', { name: '2×' }));
    expect(c4.setSpeed).toHaveBeenLastCalledWith(2);
  });

  it('expanded: only the 24h timeline — the monthly calendar is dead', () => {
    const { container } = render(<BottomSheet {...props(clock(), { open: true })} />, { wrapper: LanguageProvider });
    expect(container.querySelector('.sheet-aberto')).toBeInTheDocument();
    expect(container.querySelector('.sheet-calendario')).toBeNull();
    expect(container.querySelector('.timeline-global')).toBeInTheDocument();
  });

  it('changing the date calls onDay with the local 00:00 of the chosen day', () => {
    const p = props(clock());
    const { container } = render(<BottomSheet {...p} />, { wrapper: LanguageProvider });
    fireEvent.change(container.querySelector('input[type=date]') as HTMLInputElement, { target: { value: '2026-10-08' } });
    expect(p.onDay).toHaveBeenCalledWith(Math.floor(new Date(2026, 9, 8, 0, 0, 0, 0).getTime() / 1000));
  });

  it('an empty or off-format YYYY-MM-DD value is ignored and keeps the current day', () => {
    const p = props(clock());
    const { container } = render(<BottomSheet {...p} />, { wrapper: LanguageProvider });
    const input = container.querySelector('input[type=date]') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.change(input, { target: { value: '15/10/2026' } });
    expect(p.onDay).not.toHaveBeenCalled();
  });

  // spec 2026-10-19 (sheet-arrow-strip): the strip becomes the only open/close control (F1).
  it('F1: the strip is the first child of the sheet; the expand button died', () => {
    const { container } = render(<BottomSheet {...props(clock())} />, { wrapper: LanguageProvider });
    const sheet = container.querySelector('.sheet') as HTMLElement;
    expect(sheet.firstElementChild?.className).toBe('sheet-faixa');
    const actions = container.querySelector('.sheet-acoes') as HTMLElement;
    expect(actions.querySelector('button[aria-label="More options"]')).toBeNull();
    const glyphs = [...actions.querySelectorAll('button')].map((b) => b.textContent);
    expect(glyphs).toEqual(['▶', '1×', '2×', '4×']);
  });

  it('F2: exactly one arrow (svg) in the strip, collapsed and expanded', () => {
    const { container, rerender } = render(<BottomSheet {...props(clock())} />, { wrapper: LanguageProvider });
    expect(container.querySelectorAll('.sheet-faixa svg').length).toBe(1);
    rerender(<BottomSheet {...props(clock(), { open: true })} />);
    expect(container.querySelectorAll('.sheet-faixa svg').length).toBe(1);
  });

  it('F3: Enter on the strip calls onToggleOpen', () => {
    const p = props(clock());
    const { container } = render(<BottomSheet {...p} />, { wrapper: LanguageProvider });
    fireEvent.keyDown(container.querySelector('.sheet-faixa') as Element, { key: 'Enter' });
    expect(p.onToggleOpen).toHaveBeenCalledTimes(1);
  });
});
