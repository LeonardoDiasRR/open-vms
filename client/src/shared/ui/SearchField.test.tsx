import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import SearchField from './SearchField';

// The component is controlled: the test keeps the value the way the App does.
function Wrapper() {
  const [value, setValue] = useState('');
  return <SearchField value={value} onChange={setValue} />;
}

const renderField = (ui = <Wrapper />) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe('SearchField', () => {
  it('shows the placeholder and lifts the typed text to the owner', () => {
    renderField();
    const field = screen.getByPlaceholderText('Search cameras and layouts');
    fireEvent.change(field, { target: { value: 'aeroporto' } });
    expect(field).toHaveValue('aeroporto');
  });

  it('the clear button only shows with text and resets the field', () => {
    renderField();
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search cameras and layouts'), { target: { value: 'aer' } });
    expect(screen.getByLabelText('Clear search')).toHaveAttribute('title', 'Clear search');
    fireEvent.click(screen.getByLabelText('Clear search'));
    expect(screen.getByPlaceholderText('Search cameras and layouts')).toHaveValue('');
    expect(screen.queryByLabelText('Clear search')).not.toBeInTheDocument();
  });

  // spec 2026-10-17 (header search): Esc clears the field, like the CameraTree input did
  it('Escape resets the field', () => {
    renderField();
    const field = screen.getByPlaceholderText('Search cameras and layouts');
    fireEvent.change(field, { target: { value: 'aer' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(field).toHaveValue('');
  });

  // spec 2026-10-17 (PTZ magnifier): the field label is OPTIONAL — without it nothing changes in the
  // sidebar search; with it, whoever filters saved positions gets a name that describes the list.
  it('without label the field keeps the sidebar search default label', () => {
    renderField(<SearchField value="" onChange={() => {}} />);
    expect(screen.getByLabelText('Search cameras and layouts')).toBeInTheDocument();
  });

  it('with label the field answers by the label the consumer asked for', () => {
    renderField(<SearchField value="" onChange={() => {}} label="Filtrar posições salvas" />);
    expect(screen.getByLabelText('Filtrar posições salvas')).toBeInTheDocument();
  });
});
