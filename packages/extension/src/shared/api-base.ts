// The TrueScore server every extension call goes to. `bun build.ts --api-base=<url>`
// bakes in another one (a local server, for an e2e run); tests and the normal
// build get production.
declare const __TRUESCORE_API_BASE__: string | undefined;
export const TRUESCORE_API_BASE = typeof __TRUESCORE_API_BASE__ === 'string' ? __TRUESCORE_API_BASE__ : 'https://truescore.mohamed3on.com';
