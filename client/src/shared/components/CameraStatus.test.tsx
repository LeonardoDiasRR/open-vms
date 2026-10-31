import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import CameraStatus from './CameraStatus';

const renderStatus = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);

describe('CameraStatus (M3)', () => {
  it('keeps the badge class contract per state', () => {
    const { container: c1 } = renderStatus(<CameraStatus state="online" />);
    expect(c1.querySelector('.badge')?.className).toBe('badge online');
    const { container: c2 } = renderStatus(<CameraStatus state="error" />);
    expect(c2.querySelector('.badge')?.className).toBe('badge error');
    const { container: c3 } = renderStatus(<CameraStatus state="provisioning" />);
    expect(c3.querySelector('.badge')?.className).toBe('badge provisioning');
  });

  it('offline has no class (neutral dot) and recording adds cheia', () => {
    const { container: c1 } = renderStatus(<CameraStatus state="offline" />);
    expect(c1.querySelector('.badge')?.className).toBe('badge');
    const { container: c2 } = renderStatus(<CameraStatus state="online" recording />);
    expect(c2.querySelector('.badge')?.className).toBe('badge online cheia');
  });

  it('has its own spoken name per state, without depending on color', () => {
    renderStatus(<CameraStatus state="provisioning" />);
    expect(screen.getByRole('img')).toHaveAccessibleName('provisioning');
    const { unmount } = renderStatus(<CameraStatus state="error" recording />);
    expect(screen.getAllByRole('img')[1]).toHaveAccessibleName('error, recording');
    unmount();
  });

  it('respects ariaLabel and title when the caller passes them', () => {
    renderStatus(<CameraStatus state="online" ariaLabel="camera 3 online" title="camera 3" />);
    expect(screen.getByRole('img')).toHaveAccessibleName('camera 3 online');
    expect(screen.getByRole('img').getAttribute('title')).toBe('camera 3');
  });
});
