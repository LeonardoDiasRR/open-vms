'use strict';

// Display roles (spec 2026-10-14). The Hub publisher and the live reader use the SAME rule as the
// player (client/src/features/live/services/profiles.ts): primary = widest; secondary = narrowest
// among the rest. A profile without a width never beats a profile with a known width.
function primaryProfile(profiles) {
  const l = profiles || [];
  if (!l.length) return undefined;
  return l.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
}

function secondaryProfile(profiles) {
  const l = profiles || [];
  const primary = primaryProfile(l);
  const rest = l.filter((p) => p !== primary);
  if (!rest.length) return primary;
  // ponytail: unknown width is worth +Inf — it loses to any real width
  return rest.reduce((a, b) => ((b.width || Infinity) < (a.width || Infinity) ? b : a));
}

// Roles of a camera: primary always (there is a profile with a source), secondary only when it is
// another profile. A single-profile camera publishes 1 path and has no secondary.
function cameraRoles(camera, profiles) {
  const list = ((camera && camera.profile_ids) || [])
    .map((id) => (profiles || {})[id]).filter((p) => p && p.source_url);
  const primary = primaryProfile(list) || null;
  const secondary = secondaryProfile(list);
  return { primary, secondary: secondary && primary && secondary.id !== primary.id ? secondary : null };
}

// Path the profile OCCUPIES on the Hub (spec 2026-10-16): the primary publishes `<uuid>` and the
// secondary publishes `<uuid>/sub`. A profile with no published role does not exist on the Hub.
function profilePath(camera, profiles, profileId) {
  if (!camera) return null;
  const { primary, secondary } = cameraRoles(camera, profiles);
  if (primary && primary.id === profileId) return camera.id;
  if (secondary && secondary.id === profileId) return `${camera.id}/sub`;
  return null;
}

module.exports = { primaryProfile, secondaryProfile, cameraRoles, profilePath };
