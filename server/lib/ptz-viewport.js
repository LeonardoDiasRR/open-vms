'use strict';
const { AppError } = require('./errors');

// Zoom on the marked area (spec 2026-10-18, section 5.3). PURE module: receives the normalized 0..1 box
// and the GetStatus state and returns the AbsoluteMove as TEXT with 6 decimals — the same shape as the
// ONVIF wire, so the route does not carry loose numbers. Nothing here talks to the device.
const DEFAULT_FOV = 60;            // horizontal FOV at minimum zoom (spec 5.3); overridden by cam.fov_grau
const DEFAULT_ASPECT = 16 / 9;
// Amendment E2: the ONVIF generic space normalizes the whole MECHANICAL travel into [-1, 1]. The travel
// adopted as reference is 360 degrees of pan and 180 of tilt. These two constants are the ONLY
// calibration point of the module: if the real camera moves too little (or too much), this is the pair
// that changes.
const DEGREES_PER_UNIT_PAN = 180;
const DEGREES_PER_UNIT_TILT = 90;
const DECIMALS = 6;

const isGeneric = (space) => /\/PositionGenericSpace$/.test(String(space || ''));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
// `Number(null)` and `Number('')` are 0, and 0 is a LEGITIMATE position in ONVIF: the empty value must
// become NaN here, otherwise "the camera did not return the zoom" would become "the camera is at zoom
// zero".
const toNumber = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const text = (v) => v.toFixed(DECIMALS);

// The box arrives from the browser as JSON: a number may come as a string, and outside 0..1 it is not
// a video area.
function readBox({ left, top, right, bottom } = {}) {
  const l = toNumber(left), t = toNumber(top), r = toNumber(right), b = toNumber(bottom);
  if (![l, t, r, b].every(Number.isFinite)) throw new AppError('box_invalid');
  if (l < 0 || t < 0 || r > 1 || b > 1) throw new AppError('box_outside_video');
  if (r - l <= 0 || b - t <= 0) throw new AppError('box_empty');
  return { left: l, top: t, right: r, bottom: b };
}

// ---- spec 2026-10-19 (Nx parity): aim and zoom by tangent projection ----
// Copies the shape of `QnViewportPtzController::viewportMove` (libnx_vms_common.so, 0x874610): the frame
// is a plane at z = 1, `2*tan(fov/2)` from the center; the aim is the `atan2`/`asin` of the radius
// ROTATED by the current position; the new FOV is `2*atan(side*tan(fov/2))`, interpolated between fovMax
// (zoom 0) and fovMin (zoom 1) ON THE IMAGE PLANE (tangent), not in degrees. Our convention (checked
// against the plane probe): pan 0 = +Z, growing towards +X; positive tilt = up; screen y grows downwards.
const DEG = Math.PI / 180;
const hasRealFov = (min, max) => Number.isFinite(min) && Number.isFinite(max)
  && min > 0 && max > 0 && min < max && max < 180;

function tangentMove({ box, pan, tilt, z, fovMin, fovMax, aspect }) {
  const fovH = 2 * Math.atan((1 - z) * Math.tan(fovMax / 2 * DEG) + z * Math.tan(fovMin / 2 * DEG));
  const fovV = 2 * Math.atan(Math.tan(fovH / 2) / aspect);
  const p = pan * DEGREES_PER_UNIT_PAN * DEG;
  const tl = tilt * DEGREES_PER_UNIT_TILT * DEG;
  const x = ((box.left + box.right) / 2 - 0.5) * 2 * Math.tan(fovH / 2);
  const y = -((box.top + box.bottom) / 2 - 0.5) * 2 * Math.tan(fovV / 2);
  const y2 = y * Math.cos(tl) + Math.sin(tl);
  const z2 = -y * Math.sin(tl) + Math.cos(tl);
  const wx = x * Math.cos(p) + z2 * Math.sin(p);
  const wz = -x * Math.sin(p) + z2 * Math.cos(p);
  const side = Math.max(box.right - box.left, box.bottom - box.top);
  const fovReq = 2 * Math.atan(side * Math.tan(fovH / 2));
  return {
    pan: text(clamp(Math.atan2(wx, wz) / (DEGREES_PER_UNIT_PAN * DEG), -1, 1)),
    tilt: text(clamp(Math.asin(y2 / Math.hypot(wx, y2, wz)) / (DEGREES_PER_UNIT_TILT * DEG), -1, 1)),
    zoom: text(clamp((Math.tan(fovReq / 2) - Math.tan(fovMax / 2 * DEG))
      / (Math.tan(fovMin / 2 * DEG) - Math.tan(fovMax / 2 * DEG)), 0, 1)),
  };
}

// FOV at the current zoom: `fovGrau` is the FOV with the camera at MINIMUM zoom (spec 5.3) and the
// generic space coordinate goes from 0 (wide angle) to 1 (tele), so fov(z) = fovGrau * (1 - z) —
// amendment E2, which replaces the spec's `fovGrau / zoom` (626 degrees with the measured zoom of
// 0.095833).
function computeMovement({ caixa: box, state: st, fovGrau = DEFAULT_FOV, aspecto: aspect = DEFAULT_ASPECT,
                            fovMinGrau, fovMaxGrau } = {}) {
  const pan = toNumber(st && st.pan), tilt = toNumber(st && st.tilt), zoom = toNumber(st && st.zoom);
  if (![pan, tilt, zoom].every(Number.isFinite)) throw new AppError('ptz_position_missing');
  // The [-1, 1] clamp only holds in the generic space: in a proprietary space the whole conversion is void.
  if (!isGeneric(st.spacePanTilt) || !isGeneric(st.spaceZoom)) throw new AppError('ptz_space_unsupported');
  const a = Number(aspect) > 0 ? Number(aspect) : DEFAULT_ASPECT;
  const z = clamp(zoom, 0, 1);
  const fovMin = toNumber(fovMinGrau);
  const fovMax = toNumber(fovMaxGrau);
  if (hasRealFov(fovMin, fovMax)) {
    return tangentMove({ box, pan, tilt, z, fovMin, fovMax, aspect: a });
  }
  const fovDegrees = Number(fovGrau) > 0 ? Number(fovGrau) : DEFAULT_FOV;
  const fovH = fovDegrees * (1 - z);
  const fovV = fovH / a;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const side = Math.max(box.right - box.left, box.bottom - box.top);
  return {
    // a box to the right of the center moves the camera to the right; the video Y grows DOWNWARDS
    pan: text(clamp(pan + ((cx - 0.5) * fovH) / DEGREES_PER_UNIT_PAN, -1, 1)),
    tilt: text(clamp(tilt - ((cy - 0.5) * fovV) / DEGREES_PER_UNIT_TILT, -1, 1)),
    // the zoom that makes the box FILL the frame: shrinks the FOV by the box's longest side
    zoom: text(clamp(1 - (1 - z) * side, 0, 1)),
  };
}

module.exports = { DEFAULT_FOV, DEGREES_PER_UNIT_PAN, DEGREES_PER_UNIT_TILT, readBox, computeMovement };
