import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Switch } from './switch';

describe('Switch', () => {
  it('reflete o estado ligado', () => {
    render(<Switch checked onCheckedChange={() => {}} aria-label="Gravar" />);
    expect(screen.getByRole('switch', { name: 'Gravar' })).toHaveAttribute('aria-checked', 'true');
  });
});
