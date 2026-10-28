// Capability union on the client side. It MUST stay byte-identical to CAPABILITIES in
// server/lib/rbac.js; the parity test (capabilities-paridade.test.ts) pins that contract.
// A TS type disappears at compile time, so the literal array in that test is the second copy
// of the contract (there is no runtime object derived from the type itself).
export type Capability =
  | 'camera.view'
  | 'camera.control'
  | 'camera.manage'
  | 'camera.manage.global'
  | 'settings.manage'
  | 'users.manage'
  | 'profiles.manage'
  | 'retention.manage';

// Builds a capability check from the effective capabilities returned by the server
// (login/me). Set lookup keeps repeated can() calls O(1) during rendering.
export const makeCan = (caps: readonly Capability[]): ((cap: Capability) => boolean) => {
  const set = new Set<string>(caps);
  return (cap: Capability): boolean => set.has(cap);
};
