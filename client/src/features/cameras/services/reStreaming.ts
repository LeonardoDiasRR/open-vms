// Re-streaming URL the server publishes for the camera: the path is the camera id and the port is
// the hub's mediamtx one (verified live: 97 published paths, 64 named as UUIDs, and the active
// camera id among them). The PASSWORD does not enter: the server keeps only its scrypt hash and the
// client never has it — the text goes out with the literal <password> marker and whoever pastes it
// in the player replaces it.
// A missing port falls back to 8554, the mediamtx rtspAddress (deploy/mediamtx.yml).
export function urlReStreaming({ user, host, port, cameraId }: {
  user: string; host: string; port?: number | string | null; cameraId: string;
}): string {
  const p = Number(port) || 8554;
  return `rtsp://${user}:<password>@${host}:${p}/${cameraId}`;
}
