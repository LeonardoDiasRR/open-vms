import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useModalFocus } from './useFocoModal';

function Modal({ onMount = () => {} }: { onMount?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  onMount();
  return (
    <div ref={ref}>
      <button>first</button>
      <button>last</button>
    </div>
  );
}

describe('useModalFocus', () => {
  it('opens with focus on the first focusable', () => {
    render(<Modal />);
    expect(document.activeElement?.textContent).toBe('first');
  });

  it('Tab on the last goes back to the first and Shift+Tab on the first goes to the last', () => {
    render(<Modal />);
    const [first, last] = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the trigger on unmount', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<Modal />);
    expect(document.activeElement).not.toBe(trigger);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('returns focus to the trigger even with autoFocus in the content', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    function WithAutoFocus() {
      const ref = useRef<HTMLDivElement>(null);
      useModalFocus(ref);
      return (
        <div ref={ref}>
          <input autoFocus aria-label="field" />
        </div>
      );
    }
    const { unmount } = render(<WithAutoFocus />);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('field');
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it('does not steal focus from someone already inside (autoFocus preserved)', () => {
    function WithAutoFocus() {
      const ref = useRef<HTMLDivElement>(null);
      useModalFocus(ref);
      return (
        <div ref={ref}>
          <button>button</button>
          <input autoFocus aria-label="field" />
        </div>
      );
    }
    render(<WithAutoFocus />);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('field');
  });
});
