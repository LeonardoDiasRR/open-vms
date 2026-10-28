'use strict';

// One-off migration of the pt-BR nomenclature to English (spec 2026-10-19). Runs on load, BEFORE the
// access migration; it is idempotent because the source keys/values stop existing on the first pass.
// Returns only the count: the caller persists it, and it already has the backup.
const KEY_MAP = {
  informado_em: 'reported_at',
  rtsp_principal: 'rtsp_primary',
  rtsp_secundario: 'rtsp_secondary',
  manufacturer_origem: 'manufacturer_source',
  canais: 'channels',
  motivo: 'reason',
  posicoes: 'positions',
  inicio: 'start',
  erro: 'error',
  suporta: 'supported',
};
const VALUE_MAP = {
  verificada: 'verified',
  credencial_invalida: 'invalid_credential',
  requer_credencial: 'credential_required',
  nenhum: 'none',
  erro: 'error',
  fila: 'queued',
  exportando: 'exporting',
  pronto: 'ready',
};

function migrateNomenclature(state) {
  let changed = 0;
  // ponytail: exact-value swap (no field list): the map values are VMS states, not free text. If they
  // ever become a camera name, restrict the swap to the `status` key.
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const v = node[i];
        if (typeof v === 'string' && VALUE_MAP[v]) { node[i] = VALUE_MAP[v]; changed++; } else walk(v);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      const english = KEY_MAP[key];
      if (english) {
        // If the English key already exists it WINS (the document was already migrated at that point)
        // and the old one is just leftover: keeping both would never be idempotent.
        if (!(english in node)) node[english] = value;
        delete node[key];
        changed++;
        walk(node[english]);
        continue;
      }
      if (typeof value === 'string' && VALUE_MAP[value]) { node[key] = VALUE_MAP[value]; changed++; }
      else walk(value);
    }
  };
  // ponytail: never take the boot down; the document may be garbage, and what already migrated is done.
  try { walk(state); } catch {}
  return { changed };
}

module.exports = { migrateNomenclature, KEY_MAP, VALUE_MAP };
