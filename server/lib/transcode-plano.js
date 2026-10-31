'use strict';
// Pure plan for per-session transcoding (Nx model): 60 s chunks aligned to epoch and the ffmpeg
// argv. It touches neither disk nor process; the worker is what executes it.
const { dayDir, hourFile } = require('./recorder');
const { createHash } = require('node:crypto');

const CHUNK = 60;

// The recorder writes <YYYY>/<MM>/<DD>/<HH>.mp4 in the LOCAL timezone: the hour-file name comes from
// the same helpers exported by recorder.js (dayDir + hourFile); nothing is recalculated here.
function planChunks({ de: from, ate: to, sources, seconds = CHUNK, representation = 'h264' }) {
  if (sources?.some(s => Number.isFinite(s.anchor))) {
    const out = [];
    for (const source of sources) {
      for (const [start, end] of source.coverage || [[source.anchor, source.end]]) {
        if (!Number.isFinite(end) || end <= from || start >= to) continue;
        const first = start + Math.max(0, Math.floor((from - start) / seconds)) * seconds;
        for (let ini = first; ini < Math.min(end, to); ini += seconds) {
          const fim = Math.min(end, ini + seconds);
          const id = createHash('sha256').update(JSON.stringify(['playback-v2', source.identity || source.filePath,
            source.generation || source.anchor, ini, fim, representation])).digest('hex');
          out.push({ ini, fim, id, arquivoHora: source.arquivoHora, source });
        }
      }
    }
    return out.sort((a, b) => a.ini - b.ini);
  }
  const chunks = [];
  for (let ini = Math.floor(from / CHUNK) * CHUNK; ini < to; ini += CHUNK) {
    const end = Math.min(ini + CHUNK, to);
    if (end <= from) continue;
    const d = new Date(ini * 1000);
    chunks.push({ ini, fim: end, arquivoHora: hourFile(dayDir('', d), d) });
  }
  return chunks;
}

function transcodeCommand({ encoder, source, ini, fim, fps, dest, threads, decoderThreads, sourceAnchor, filters = [], hwDecode, hwSurface }) {
  // ponytail: fim relative to the START of the chunk's hour file (fim % 3600 would give 0 across
  // the hour boundary).
  const hourStart = sourceAnchor ?? ini - (ini % 3600);
  // D2: -threads only makes sense for libx264; on nvenc/qsv/vaapi the option means something else.
  const threadOptions = encoder === 'libx264' && Number.isInteger(threads) && threads >= 1
    ? ['-threads', String(threads)] : [];
  const settings = {
    libx264: ['-preset', 'veryfast', '-crf', '23'],
    h264_nvenc: ['-preset', 'p4', '-cq', '23', '-b:v', '0'],
    h264_qsv: ['-preset', 'veryfast', '-global_quality', '23'],
    h264_vaapi: ['-qp', '23'],
  }[encoder];
  if (!settings) throw new Error('Unsupported H.264 encoder');
  const vf = [...filters, ...(encoder === 'h264_vaapi' ? ['format=nv12', 'hwupload'] : [])];
  return ['-hide_banner', '-loglevel', 'error',
    ...(encoder === 'h264_vaapi' ? ['-vaapi_device', process.env.OPENVMS_VAAPI_DEVICE || '/dev/dri/renderD128'] : []),
    // spec 2026-10-27 (on-demand GPU decode): input option; the worker retries WITHOUT it on failure.
    ...(hwDecode ? ['-hwaccel', 'cuda'] : []),
    // spec 2026-10-27 (full surface): frames never return to system RAM; nvenc reads them directly,
    // so -pix_fmt (a system format request) is dropped when hwSurface is on. The worker falls back
    // to hwDecode-only, then CPU, on failure.
    ...(hwSurface ? ['-hwaccel_output_format', 'cuda'] : []),
    '-ss', String(Math.max(0, ini - hourStart)),
    ...(decoderThreads ? ['-threads', String(decoderThreads)] : []),
    '-i', source, '-t', String(fim - ini),
    ...threadOptions, '-filter_threads', '1',
    ...(vf.length ? ['-vf', vf.join(',')] : []),
    '-map', '0:v:0', '-c:v', encoder, ...settings,
    ...(encoder === 'h264_vaapi' || hwSurface ? [] : ['-pix_fmt', 'yuv420p']),
    '-bf', '0', '-g', String(Math.max(1, Math.round((fps || 25) * 2))), '-an', '-f', 'mp4',
    '-movflags', '+faststart+empty_moov+default_base_moof+frag_keyframe', dest];
}

module.exports = { planChunks, transcodeCommand };

