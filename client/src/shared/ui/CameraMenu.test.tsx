import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { renderHook } from '@testing-library/react';
import { LanguageProvider, useT } from '@/shared/i18n';
import CameraMenu from './CameraMenu';
import { cameraMenuItems } from '@/shared/hooks/useCameras';
import type { Capability } from '@/shared/domain/capabilities';

const items3 = [
  { id: 'a', label: 'A' },
  { id: 'b', label: 'B' },
  { id: 'c', label: 'C' },
];

const wrapper = ({ children }: { children: React.ReactNode }) => <LanguageProvider>{children}</LanguageProvider>;
const labels = () => renderHook(() => useT(), { wrapper }).result.current;

describe('CameraMenu', () => {
  it('renders one menuitem per item and forwards onPick', () => {
    const picked: string[] = [];
    render(<CameraMenu x={10} y={10} items={[{ id: 'config', label: 'Camera settings' }]}
      onPick={(id) => picked.push(id)} onClose={() => {}} />);
    const item = screen.getByRole('menuitem', { name: 'Camera settings' });
    item.click();
    expect(picked).toEqual(['config']);
  });

  it('opens with focus on the first item and walks with the arrows (wrapping at the ends)', () => {
    render(<CameraMenu x={10} y={10} items={items3} onPick={() => {}} onClose={() => {}} />);
    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
  });

  it('Escape closes the menu', () => {
    const onClose = vi.fn();
    render(<CameraMenu x={10} y={10} items={items3} onPick={() => {}} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // spec 2026-10-19 (destructive item always last): the partition belongs to the renderer.
  const texts = () => screen.getAllByRole('menuitem').map((b) => b.textContent);

  it('renders destructive items after the harmless ones, preserving the builder order (stable partition)', () => {
    render(<CameraMenu x={10} y={10} onPick={() => {}} onClose={() => {}} items={[
      { id: 'x1', label: 'Excluir A', danger: true },
      { id: 's1', label: 'São B' },
      { id: 'x2', label: 'Excluir D', danger: true },
      { id: 's2', label: 'São C' },
    ]} />);
    expect(texts()).toEqual(['São B', 'São C', 'Excluir A', 'Excluir D']);
  });

  it('a menu with only destructive items preserves the builder order', () => {
    render(<CameraMenu x={10} y={10} onPick={() => {}} onClose={() => {}} items={[
      { id: 'x1', label: 'Um', danger: true },
      { id: 'x2', label: 'Dois', danger: true },
    ]} />);
    expect(texts()).toEqual(['Um', 'Dois']);
  });

  it('the single-camera menu renders "Delete camera" last (the request menu)', () => {
    render(<CameraMenu x={10} y={10} onPick={() => {}} onClose={() => {}}
      items={cameraMenuItems({ kind: 'camera', id: 'c1' }, [], false, labels())} />);
    const labelsText = texts();
    expect(labelsText[labelsText.length - 1]).toBe('Delete camera');
    // correction 2026-10-26: the order starts at the settings (the operator's request), not at Rename
    expect(labelsText[0]).toBe('Camera settings');
    expect(labelsText).toEqual(['Camera settings', 'Deactivate camera', 'Create group', 'Rename', 'Delete camera']);
  });

  // Task 4.2 (camera ativa): one toggle item on the single camera, a label pair on the batch.
  // The ids are the contract: toggle-active / activate-all / deactivate-all.
  const menu = (m: Parameters<typeof cameraMenuItems>[0], marked: Parameters<typeof cameraMenuItems>[1] = [],
    can?: (cap: Capability) => boolean) =>
    cameraMenuItems(m, marked, false, labels(), can);

  it('single camera, active target: one toggle-active item labelled "Deactivate camera"', () => {
    const items = menu({ kind: 'camera', id: 'c1' });
    expect(items.filter((i) => i.id === 'toggle-active')).toHaveLength(1);
    expect(items.find((i) => i.id === 'toggle-active')?.label).toBe('Deactivate camera');
    // ativa: true means the same as absent (the tolerant read)
    expect(menu({ kind: 'camera', id: 'c1', ativa: true }).find((i) => i.id === 'toggle-active')?.label)
      .toBe('Deactivate camera');
  });

  it('single camera, inactive target: the SAME id labelled "Activate camera"', () => {
    const items = menu({ kind: 'camera', id: 'c1', ativa: false });
    expect(items.filter((i) => i.id === 'toggle-active')).toHaveLength(1);
    expect(items.find((i) => i.id === 'toggle-active')?.label).toBe('Activate camera');
  });

  it('toggle-active needs camera.manage (global alone does not open it)', () => {
    const items = menu({ kind: 'camera', id: 'c1' }, [], (cap) => cap === 'camera.manage.global');
    expect(items.some((i) => i.id === 'toggle-active')).toBe(false);
    // the sibling camera.manage items are gone too, the folder one stays
    expect(items.map((i) => i.id)).toEqual(['create-group']);
  });

  it('batch (>=2 marked, target inside): BOTH activate-all and deactivate-all, regardless of the mixed states', () => {
    const marked = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2', ativa: false }];
    const items = menu({ kind: 'camera', id: 'c1' }, marked);
    const ids = items.map((i) => i.id);
    expect(ids).toContain('activate-all');
    expect(ids).toContain('deactivate-all');
    expect(items.find((i) => i.id === 'activate-all')?.label).toBe('Activate all');
    expect(items.find((i) => i.id === 'deactivate-all')?.label).toBe('Deactivate all');
    // the batch pair does not depend on the mixed state: all-active selection brings both too
    const allOn = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2' }];
    const ids2 = menu({ kind: 'camera', id: 'c1' }, allOn).map((i) => i.id);
    expect(ids2).toContain('activate-all');
    expect(ids2).toContain('deactivate-all');
  });

  it('batch pair needs camera.manage (the mutation touches cameras)', () => {
    const marked = [{ kind: 'camera', id: 'c1' }, { kind: 'camera', id: 'c2' }];
    const items = menu({ kind: 'camera', id: 'c1' }, marked, (cap) => cap === 'camera.manage.global');
    const ids = items.map((i) => i.id);
    expect(ids).not.toContain('activate-all');
    expect(ids).not.toContain('deactivate-all');
  });
});
