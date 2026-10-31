import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './badge';

describe('Badge', () => {
  it('renderiza o texto', () => {
    render(<Badge>online</Badge>);
    expect(screen.getByText('online')).toBeInTheDocument();
  });
});
