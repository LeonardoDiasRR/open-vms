export type QualityState = { preview: boolean; changedAt: number };
export function qualityFor(q: { enabled: boolean; rate: number; frames: number; dropped: number; stalls: number; now: number }, state: QualityState): QualityState {
  if (!q.enabled || q.rate < 4) return state.preview ? { preview: false, changedAt: q.now } : state;
  if (q.now - state.changedAt < 30000) return state;
  const ratio = q.frames > 0 ? q.dropped / q.frames : 0;
  if (!state.preview && (q.stalls >= 2 || (q.frames >= 60 && ratio > 0.1))) return { preview: true, changedAt: q.now };
  if (state.preview && q.frames >= 60 && ratio < 0.02 && q.stalls === 0) return { preview: false, changedAt: q.now };
  return state;
}
