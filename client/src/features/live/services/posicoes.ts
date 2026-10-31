// OpenVMS saved positions (spec 2026-10-17): the list is local, so the module only holds the type and
// the limit. The rule that the name defined the set left with `presets.ts` — the name is free now.
// The identity belongs to the wire (`PtzPosition`), so the type is reused instead of copied.
import type { PtzPosition } from '@/shared/utils/api';

export type Position = PtzPosition;

export const LIMIT = 20;
