import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import PainelAlternancia from './PainelAlternancia';

const renderToggle = (props: Partial<React.ComponentProps<typeof PainelAlternancia>> = {}) =>
  render(<LanguageProvider>
    <PainelAlternancia side="left" collapsed={false} onToggle={() => {}} {...props} />
  </LanguageProvider>);

describe('PainelAlternancia', () => {
  it('on the open left side it announces collapse and uses the close icon', () => {
    const { container } = renderToggle();
    expect(screen.getByRole('button', { name: 'Collapse menu' })).toBeInTheDocument();
    expect(container.querySelector('.lucide-panel-left-close')).not.toBeNull();
  });

  it('on the collapsed left side it announces expand and uses the open icon', () => {
    const { container } = renderToggle({ collapsed: true });
    expect(screen.getByRole('button', { name: 'Expand menu' })).toBeInTheDocument();
    expect(container.querySelector('.lucide-panel-left-open')).not.toBeNull();
  });

  it('on the open right side it announces collapse on the right', () => {
    renderToggle({ side: 'right' });
    expect(screen.getByRole('button', { name: 'Collapse panel' })).toBeInTheDocument();
  });

  it('on the collapsed right side it announces expand on the left', () => {
    renderToggle({ side: 'right', collapsed: true });
    expect(screen.getByRole('button', { name: 'Expand panel' })).toBeInTheDocument();
  });

  it('the click fires onToggle', () => {
    const onToggle = vi.fn();
    renderToggle({ onToggle });
    fireEvent.click(screen.getByRole('button', { name: 'Collapse menu' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
