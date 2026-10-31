// Streaming profile choice by display context (LiveView):
// primary = highest resolution; secondary = lowest resolution among the others.
// A manual profile (created without resolution) has no width/height: it is never chosen
// as the secondary when another one has a known width, nor as the primary against a bigger one.

// Shape of /api/v1/profiles: width/height only exist on a real stream profile.
export type Profile = { id: string; name?: string; width?: number | null; height?: number | null };

export function primaryProfile(profiles: Profile[] | null | undefined): Profile | undefined {
  const l = profiles || [];
  if (!l.length) return undefined;
  return l.reduce((a, b) => ((b.width || 0) > (a.width || 0) ? b : a));
}

export function secondaryProfile(profiles: Profile[] | null | undefined): Profile | undefined {
  const l = profiles || [];
  const primary = primaryProfile(l);
  const others = l.filter((p) => p !== primary);
  if (!others.length) return primary;
  // unknown width (null/undefined) counts as +Inf: it loses to any real width
  return others.reduce((a, b) => ((b.width || Infinity) < (a.width || Infinity) ? b : a));
}

// Profile the videowall cell shows (spec 2026-10-15): the secondary by default; the primary in
// fullscreen and in any context after the fallback caused by a secondary failure.
// A single-profile camera has no secondary: the grid already returns its own primary.
export function cellProfile(
  profiles: Profile[] | null | undefined,
  { fullscreen = false, fellBack = false }: { fullscreen?: boolean; fellBack?: boolean } = {},
): Profile | undefined {
  const primary = primaryProfile(profiles);
  if (primary && (fullscreen || fellBack)) return primary;
  return secondaryProfile(profiles) || primary;
}
