import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import DiscoveryResults from './ResultadosDescoberta';

const noop = () => {};
// spec 2026-10-19: the labels come from the dictionary — the provider mounts with the default (en).
const renderResults = (ui: React.ReactElement) => render(<LanguageProvider>{ui}</LanguageProvider>);

// Measured DVR candidate (E9): 24 videoSources, 25 channels — the list comes from the channels, never
// from the count.
const DVR = { id: 'dvr1', ip: '10.0.0.201', openPorts: [80], status: 'verified', videoSources: 24, outcome: 'pending' };

const props = (o: Partial<ComponentProps<typeof DiscoveryResults>> = {}): ComponentProps<typeof DiscoveryResults> => ({
  results: [DVR], selected: {}, onSelect: noop, rows: {}, busy: false, scanning: false, job: null, ...o,
});

describe('DiscoveryResults: channels of the multi-channel candidate', () => {
  // The trigger only exists with a credential (canOpenChannels), with >= 2 videoSources and for a new candidate.
  it.each([
    ['no credential', { canOpenChannels: false }],
    ['a single videoSource', { canOpenChannels: true, results: [{ ...DVR, videoSources: 1 }] }],
    ['already added', { canOpenChannels: true, results: [{ ...DVR, outcome: 'added' }] }],
  ])('does not show the trigger (%s)', (_name, o) => {
    renderResults(<DiscoveryResults {...props(o)} />);
    expect(screen.queryByRole('button', { name: `Channels of ${DVR.ip}` })).not.toBeInTheDocument();
  });

  it('the trigger opens the candidate channels in the owner', () => {
    const onOpenChannels = vi.fn();
    renderResults(<DiscoveryResults {...props({ canOpenChannels: true, onOpenChannels })} />);
    const trigger = screen.getByRole('button', { name: `Channels of ${DVR.ip}` });
    expect(trigger).toHaveTextContent('▸');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(onOpenChannels).toHaveBeenCalledWith(DVR);
  });

  it('the list draws the checklist: no stream unchecked with a warning, and marking tells the owner', () => {
    const onToggleChannel = vi.fn();
    renderResults(
      <DiscoveryResults
        {...props({
          canOpenChannels: true,
          onToggleChannel,
          channels: {
            dvr1: {
              list: [
                { channel: 1, has_stream: true },
                { channel: 13, has_stream: false, reason: '404' },
              ],
              marked: [1],
            },
          },
        })}
      />,
    );
    const withStream = screen.getByRole('checkbox', { name: 'Channel 1' });
    const withoutStream = screen.getByRole('checkbox', { name: 'Channel 13' });
    expect(withStream).toBeChecked();
    expect(withoutStream).not.toBeChecked();
    expect(screen.getByText('no stream')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: `Channels of ${DVR.ip}` })).toHaveTextContent('▾');

    fireEvent.click(withoutStream);
    expect(onToggleChannel).toHaveBeenCalledWith('dvr1', 13, true);
  });

  it('the enumeration error appears on the channel row', () => {
    renderResults(
      <DiscoveryResults
        {...props({ canOpenChannels: true, channels: { dvr1: { error: 'invalid credential', list: [], marked: [] } } })}
      />,
    );
    expect(screen.getByText('✕ invalid credential')).toBeInTheDocument();
  });

  // spec 2026-10-23: the refused credential is the one status that blocks the selection, and the row
  // says why. Today the STATUS comes out empty and the checkbox comes out active.
  it('a refused credential shows the reason and keeps the checkbox disabled', () => {
    renderResults(<DiscoveryResults {...props({ results: [{ ...DVR, status: 'invalid_credential' }] })} />);
    expect(screen.getByText('Invalid credentials')).toBeInTheDocument();
    expect((screen.getByLabelText(`Select ${DVR.ip}`) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByText('ONVIF')).not.toBeInTheDocument();
  });

  // decision D2: without a credential in the scan nothing is ineligible, so credential_required selects
  it('credential_required stays selectable and labelled', () => {
    renderResults(<DiscoveryResults {...props({ results: [{ ...DVR, status: 'credential_required' }] })} />);
    expect(screen.getByText('Requires credentials')).toBeInTheDocument();
    expect((screen.getByLabelText(`Select ${DVR.ip}`) as HTMLInputElement).disabled).toBe(false);
  });
});
