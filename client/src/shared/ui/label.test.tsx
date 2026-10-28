import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Label } from './label';

describe('Label', () => {
  it('renders the text and associates it with the field through htmlFor', () => {
    render(<Label htmlFor="retention">Retention period</Label>);
    const el = screen.getByText('Retention period');
    expect(el).toBeInTheDocument();
    expect(el.getAttribute('for')).toBe('retention');
  });
});
