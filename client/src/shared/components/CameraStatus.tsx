import { useT } from '@/shared/i18n';

// M3: the camera status dot is ONE across the app. Outline = state, filled = recording
// (design system semantics). The spoken name follows the color — color is never the only signal.
type State = 'online' | 'offline' | 'error' | 'provisioning';

const WORD_KEYS = {
  online: 'cameras.status.online',
  offline: 'cameras.status.offline',
  error: 'cameras.status.error',
  provisioning: 'cameras.status.provisioning',
} as const;

export type CameraState = State;

type Props = { state: CameraState; recording?: boolean; title?: string; ariaLabel?: string; inactive?: boolean };

export default function CameraStatus({ state, recording = false, title, ariaLabel, inactive = false }: Props) {
  const { t } = useT();
  // `offline` has no CSS rule: the dot stays neutral, which is today's design.
  const stateClass = state === 'offline' ? '' : ` ${state}`;
  // spec 2026-10-27 (camera-ativa 4.3): an inactive camera is gray (the offline neutral) even when online
  const inactiveClass = inactive ? ' inativa' : '';
  const spoken = ariaLabel ?? `${t(WORD_KEYS[state])}${recording ? `, ${t('cameras.status.recording')}` : ''}`;
  return (
    <span className={`badge${stateClass}${recording ? ' cheia' : ''}${inactiveClass}`} role="img"
      aria-label={spoken} title={title ?? spoken} />
  );
}
