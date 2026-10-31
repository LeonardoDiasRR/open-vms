export type PlaybackMetric = 'start' | 'first-frame-ms' | 'buffering-ms' | 'retry' | 'error'
  | 'drift-ms' | 'dropped-frames' | 'buffer-bytes';

// Local DOM events only. No token, URL, credentials or automatic outbound telemetry.
export function playbackMetric(video: HTMLVideoElement, name: PlaybackMetric, value: number) {
  video.dispatchEvent(new CustomEvent('openvms-playback-metric', {
    bubbles: true, detail: { name, value, at: performance.now() },
  }));
}
