import { useEffect, useState } from 'react';
import { useEsc } from '@/shared/hooks/useEsc';
import type { Brand } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';

// Smaller modal: choose the manufacturer when ONVIF did not answer (spec informar-fabricante-camera).
// The native datalist gives the autocomplete with filtering; Save only enables with the EXACT name
// from the list (case-insensitive).

// Prop contracts of this modal (CameraSettingsModal passes api/camera/onClose/onSelect).
// spec 2026-10-26 (save button): the modal NO LONGER persists. Save emits the chosen name; the parent
// holds it as the pending manufacturer and writes it only on its own Save.
type Api = {
  cameraBrands: () => Promise<Brand[]>;
};

type Props = {
  api: Api;
  camera: { id: string; name: string };
  onClose: () => void;
  onSelect: (name: string) => void;
};

export default function ManufacturerModal({ api, camera, onClose, onSelect }: Props) {
  const { t } = useT();
  const [brands, setBrands] = useState<Brand[]>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEsc(onClose);
  useEffect(() => {
    let alive = true;
    api.cameraBrands()
      .then((b) => { if (alive) setBrands(b); })
      .catch((e) => { if (alive) setError(e.message || t('cameras.manufacturer.load_failed')); });
    return () => { alive = false; };
  }, [api, t]);
  // `name` is the wire key of GET /camera-brands and of POST .../manufacturer.
  const valid = brands.some((b) => b.name.toLowerCase() === name.trim().toLowerCase());
  const save = () => {
    if (!valid) return;
    onSelect(name.trim());
  };
  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-menor">
        <div className="nx-titlebar">
          <span className="nx-title">{t('cameras.manufacturer.title', { name: camera.name })}</span>
          <button className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>
        <div className="nx-body">
          <div className="nx-field">
            {/* missing key: cameras.manufacturer.label (reported) */}
            <label className="nx-label" htmlFor="fab-input">Manufacturer</label>
            <input id="fab-input" className="nx-input" list="fab-list" value={name} autoFocus
              onChange={(e) => setName(e.target.value)} placeholder={t('cameras.manufacturer.filter_placeholder')} />
            <datalist id="fab-list">
              {brands.map((b) => <option key={b.name} value={b.name} />)}
            </datalist>
          </div>
          {error && <p className="nx-aviso">{error}</p>}
          <div className="nx-actions">
            <button className="nx-btn" onClick={onClose}>{t('shared.cancel')}</button>
            <button className="nx-btn" disabled={!valid} onClick={save}>{t('shared.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
