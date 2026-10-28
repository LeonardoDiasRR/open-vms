import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import ManufacturerModal from './ManufacturerModal';

// spec 2026-10-26 (save button): the modal only READS brands and EMITS the choice (onSelect). It never
// writes; the parent persists on its own Save. The api mock above has exactly one method on purpose.
const api = { cameraBrands: () => Promise.resolve([{ name: 'Uniview' }, { name: 'Bosch' }]) };
const mount = (over: Record<string, unknown> = {}) => render(<LanguageProvider><ManufacturerModal
  api={api} camera={{ id: 'c1', name: 'Camera 1' }}
  onClose={() => {}} onSelect={() => {}} {...over} /></LanguageProvider>);

describe('ManufacturerModal: choose without persisting', () => {
  it('renders open with the camera title, the label and the buttons', async () => {
    mount();
    expect(screen.getByText(/Camera manufacturer/)).toBeInTheDocument();
    expect(screen.getByLabelText('Manufacturer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps Save disabled until a name from the list is typed', async () => {
    mount();
    const input = screen.getByLabelText('Manufacturer') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Uniview' } });
    // the brands arrive async (cameraBrands promise): the list must LAND before `valid` can flip
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.change(input, { target: { value: 'NotABrand' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('Save emits the trimmed name and calls NOTHING else (no write here)', async () => {
    const onSelect = vi.fn();
    const spy = vi.spyOn(api, 'cameraBrands');
    mount({ onSelect });
    fireEvent.change(screen.getByLabelText('Manufacturer'), { target: { value: ' Uniview ' } });
    // wait for the async brand list to land, otherwise Save is still disabled and the click is inert
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSelect).toHaveBeenCalledWith('Uniview');
    expect(spy).toHaveBeenCalledTimes(1); // only the brands read exists in this component
  });

  it('closes on ESC', () => {
    const onClose = vi.fn();
    mount({ onClose });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Cancel comes before Save, with Save at the far right', () => {
    const { container } = mount();
    const buttons = Array.from(container.querySelectorAll('.nx-actions button'));
    expect(buttons[0].textContent).toBe('Cancel');
    expect(buttons[buttons.length - 1].textContent).toBe('Save');
  });
});
