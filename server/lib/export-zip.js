'use strict';
// spec 2026-10-23 (batch download, section 5.4): opens the package BEFORE any header. A
// file that vanished midway would deliver a truncated ZIP that the client only finds out at the end.
const fs = require('node:fs'), path = require('node:path');
const { PassThrough } = require('node:stream');
const { AppError } = require('./errors');
const { writeZip } = require('./zip-stream');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ZIP = 20;
const PRONTO = new Set(['ready', 'done']); // 'done' is the old state

function idsDaQuery(raw) {
  const ids = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_ZIP || ids.some((id) => !UUID.test(id))) {
    throw new AppError('field_invalid', { field: 'ids' });
  }
  return [...new Set(ids)];
}

// ponytail: the same sv-SE format from archive.js:31-34, in four lines. The package name is the
// only place here that needs the time zone.
const carimbo = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Boa_Vista',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  .format(new Date()).replace(' ', 'T').replace(':', '');

async function openExportZip(store, rawIds) {
  const ids = idsDaQuery(rawIds);
  const jobs = [];
  for (const id of ids) {
    const j = await store.ops.exports.get(id);
    if (!j) throw new AppError('export_not_ready');
    jobs.push(j);
  }
  if (jobs.some((j) => !PRONTO.has(j.state))) throw new AppError('export_not_ready');
  if (jobs.some((j) => !j.path || !fs.existsSync(j.path))) throw new AppError('export_file_missing');
  const stream = new PassThrough();
  // read error AFTER the header: destroys the stream (the client sees a truncated ZIP). The
  // pre-check above covers the common case, which is the file vanishing before it starts.
  writeZip(stream, jobs.map((j) => ({ name: j.name || path.basename(j.path), path: j.path })))
    // ponytail: the kernel does not close the stream. Without this `end()` the response never ends and the
    // test (which waits for `end`) hangs. One line, the same contract as zip_stream.test.js:25.
    .then(() => stream.end())
    .catch(() => stream.destroy());
  return { contentType: 'application/zip',
    disposition: `attachment; filename="exportacoes_${carimbo()}.zip"`, stream };
}

module.exports = { openExportZip, idsDaQuery };
