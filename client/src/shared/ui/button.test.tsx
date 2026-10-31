import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Button } from './button';

describe('Button', () => {
  it('renders the label and forwards the click', () => {
    let clicks = 0;
    render(<Button onClick={() => { clicks += 1; }}>Save</Button>);
    screen.getByRole('button', { name: 'Save' }).click();
    expect(clicks).toBe(1);
  });
});
