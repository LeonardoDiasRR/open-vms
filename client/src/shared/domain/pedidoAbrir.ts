import type { Layout } from '@/shared/utils/api';

// Request the tree sends to the view (double click, "Open", "New"): the App provides it and the
// view consumes it. It lives here so Live and Archive share the SAME type (spec 2026-10-18, D13) —
// and `useLayouts` exports `OpenRequest` from here instead of declaring the same union again.
// `Layout` is NOT redeclared: `@/shared/utils/api` already exports it (api.ts:76) with `cells?: Cell[]`.
export type LayoutToOpen = Layout;
export type OpenRequest = { new?: boolean; cameras?: string[] } | Layout | null;
