import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import EmptyState from './EstadoVazio';

describe('EmptyState (M2)', () => {
  it('renders the message and respects the class of the call site', () => {
    const { container } = render(<EmptyState className="nx-empty" message="Nenhum dispositivo" />);
    expect(container.firstElementChild?.tagName).toBe('DIV');
    expect(container.firstElementChild?.className).toBe('nx-empty');
    expect(screen.getByText('Nenhum dispositivo')).toBeInTheDocument();
  });

  it('respects the requested element (li in the tree, span in the timeline)', () => {
    const { container: tree } = render(<EmptyState as="li" className="muted" message="nenhuma câmera" />);
    expect(tree.firstElementChild?.tagName).toBe('LI');
    const { container: line } = render(<EmptyState as="span" className="tl-empty" message="sem gravação" />);
    expect(line.firstElementChild?.tagName).toBe('SPAN');
  });

  it('shows icon and action when they exist', () => {
    render(<EmptyState message="vazio" icon={<svg data-testid="ico" />} action={<button>tentar</button>} />);
    expect(screen.getByTestId('ico')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tentar' })).toBeInTheDocument();
  });
});
