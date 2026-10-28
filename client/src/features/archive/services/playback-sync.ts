export type PlaybackSample = {
  epoch: number;
  ready: boolean;
  presentedAt: number;
  /** Earliest actual buffered media epoch after the target, in seconds. */
  nextEpoch?: number;
};

/** Return an actual successor epoch (seconds), or null to keep the wall at target.
 * `ready` means usable media at target; only all-stalled walls with skipGaps enabled
 * may recover, and only across gaps strictly shorter than 60 seconds.
 */
export function recoveryTarget(samples: PlaybackSample[], target: number, skipGaps: boolean): number | null {
  if (!skipGaps || samples.some(s => s.ready)) return null;
  // ponytail: buffered evidence only; no timeout-based clock advancement.
  let next = Infinity;
  for (const { nextEpoch } of samples) {
    if (nextEpoch !== undefined && Number.isFinite(nextEpoch) && nextEpoch > target) next = Math.min(next, nextEpoch);
  }
  return next - target < 60 ? next : null;
}
export const STARTUP_WAIT_MS = 3000;
export const HARD_SEEK_COOLDOWN_MS = 2000;

export function syncAction(epoch: number, target: number, rate: number, sinceSeek: number) {
  const drift = target - epoch;
  if (Math.abs(drift) >= 1.5 && sinceSeek >= HARD_SEEK_COOLDOWN_MS) return { seek: target, rate };
  return { seek: null, rate: Math.abs(drift) < 0.15 ? rate : rate * (drift > 0 ? 1.05 : 0.95) };
}

// All ready = release immediately. After the startup deadline a slow camera rejoins on its own;
// a wall with no decodable camera keeps its clock still instead of displaying fictitious progress.
export function wallReady(samples: PlaybackSample[], elapsed: number): boolean {
  const ready = samples.filter(s => s.ready);
  return ready.length > 0 && (ready.length === samples.length || elapsed >= STARTUP_WAIT_MS);
}
