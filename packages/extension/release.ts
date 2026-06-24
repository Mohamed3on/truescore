// Package a release artifact for the GitHub Release: stamp the version into the
// manifest, rebuild, and zip the loadable folder. Invoked by semantic-release
// (../../.releaserc.json) with the computed version, e.g. `bun release.ts 1.2.0`.
import { $ } from 'bun';

const version = process.argv[2];
if (!version) throw new Error('usage: bun release.ts <version>');

// Stamp the version into the manifest — touch only the version line so the
// commit semantic-release pushes back is a clean one-line diff.
const manifestPath = 'src/manifest.json';
const manifest = await Bun.file(manifestPath).text();
await Bun.write(manifestPath, manifest.replace(/("version":\s*)"[^"]*"/, `$1"${version}"`));

// Rebuild with the stamped version, then zip ./truescore so unzipping gives a
// folder you can point "Load unpacked" straight at.
await $`bun build.ts`;
await $`rm -f truescore.zip`;
await $`zip -r -q truescore.zip truescore`;

console.log(`Packaged truescore.zip @ ${version}`);
