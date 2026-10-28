// Type probe: if any of these `@ts-expect-error` directives stops being USED, `tsc` reports
// "Unused '@ts-expect-error' directive" and the guard fails — that is how "typed" is distinguished
// from "looks typed". It is not a runner test; `tsc` is what executes it.
import type { ApiClient } from './api';

const probe = 42 as unknown;
// @ts-expect-error: cameraBrands returns Promise<...>, never number
const a: ReturnType<ApiClient['cameraBrands']> = probe;
// @ts-expect-error: profiles returns Promise<...>, never number
const b: ReturnType<ApiClient['profiles']> = probe;
// @ts-expect-error: timeline returns Promise<...>, never number
const c: ReturnType<ApiClient['timeline']> = probe;

export { a, b, c };
