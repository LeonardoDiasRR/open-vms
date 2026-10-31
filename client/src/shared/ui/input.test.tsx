import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input } from './input';

describe('Input', () => {
  it('renderiza com o placeholder dado', () => {
    render(<Input placeholder="Retencao (dias)" />);
    expect(screen.getByPlaceholderText('Retencao (dias)')).toBeInTheDocument();
  });
});
