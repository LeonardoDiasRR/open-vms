'use strict';
const { parentPort } = require('node:worker_threads');
const { indexFile, fileAnchor } = require('./fmp4index');

parentPort.on('message', ({ id, file, options }) => {
  try {
    const out = indexFile(file, options);
    if (out && options.anchorNeeded) out.anchor = fileAnchor(file);
    parentPort.postMessage({ id, out });
  } catch (e) { parentPort.postMessage({ id, error: e.message, code: e.code }); }
});
