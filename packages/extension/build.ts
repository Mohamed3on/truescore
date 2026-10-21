import esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { TRUESCORE_API_BASE } from './src/shared/api-base';

// `--api-base=<url> --out=<dir>` builds a copy that calls another server (a local
// one, for an e2e run). Never into ./truescore: that's the loaded unpacked extension.
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const API_BASE = arg('api-base');
const OUT = arg('out') ?? 'truescore';
if (API_BASE && resolve(OUT) === resolve('truescore')) throw new Error('--api-base needs --out=<dir>: ./truescore is the loaded unpacked extension');
const define = API_BASE ? { __TRUESCORE_API_BASE__: JSON.stringify(API_BASE) } : {};

// Clean
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/sites`, { recursive: true });
mkdirSync(`${OUT}/popup`, { recursive: true });

// Bundle site scripts
await esbuild.build({
  entryPoints: [
    'src/sites/airbnb.ts',
    'src/sites/airbnb-search.ts',
    'src/sites/amazon-search.ts',
    'src/sites/amazon-product.ts',
    'src/sites/booking-search.ts',
    'src/sites/booking-hotel.ts',
    'src/sites/decathlon-pdp.ts',
    'src/sites/decathlon-plp.ts',
    'src/sites/uniqlo-pdp.ts',
    'src/sites/uniqlo-plp.ts',
    'src/sites/ikea-pdp.ts',
    'src/sites/ikea-plp.ts',
    'src/sites/dm-pdp.ts',
    'src/sites/dm-plp.ts',
    'src/sites/docmorris-pdp.ts',
    'src/sites/docmorris-plp.ts',
    'src/sites/rossmann-pdp.ts',
    'src/sites/rossmann-plp.ts',
    'src/sites/bjjfanatics-pdp.ts',
    'src/sites/progress-pdp.ts',
    'src/sites/progress-plp.ts',
    'src/sites/bjjfanatics-plp.ts',
    'src/sites/etsy.ts',
    'src/sites/etsy-pdp.ts',
    'src/sites/aliexpress.ts',
    'src/sites/aliexpress-pdp.ts',
    'src/sites/goodreads.ts',
    'src/sites/gmaps.ts',
    'src/sites/gmaps-bridge.ts',
    'src/sites/gmaps-capture.ts',
    'src/sites/gmaps-search.ts',
    'src/sites/imdb.ts',
    'src/sites/letterboxd.ts',
    'src/sites/reddit.ts',
    'src/sites/transfermarkt.ts',
  ],
  bundle: true,
  outdir: `${OUT}/sites`,
  format: 'iife',
  target: ['chrome120'],
  minify: false,
  define,
});

// Bundle background
await esbuild.build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  outdir: OUT,
  format: 'iife',
  target: ['chrome120'],
  minify: false,
  define,
});

// Bundle popup
await esbuild.build({
  entryPoints: ['src/popup/popup.ts'],
  bundle: true,
  outdir: `${OUT}/popup`,
  format: 'iife',
  target: ['chrome120'],
  minify: false,
  define,
});

// Static assets
if (API_BASE) {
  const manifest = JSON.parse(readFileSync('src/manifest.json', 'utf8'));
  manifest.host_permissions = manifest.host_permissions.map((p: string) => (p === `${TRUESCORE_API_BASE}/*` ? `${API_BASE}/*` : p));
  writeFileSync(`${OUT}/manifest.json`, JSON.stringify(manifest, null, 2));
} else cpSync('src/manifest.json', `${OUT}/manifest.json`);
cpSync('src/icons', `${OUT}/icons`, { recursive: true });
cpSync('src/popup/popup.html', `${OUT}/popup/popup.html`);
cpSync('src/popup/popup.css', `${OUT}/popup/popup.css`);
cpSync('src/styles/amazon-product.css', `${OUT}/sites/amazon-product.css`);
cpSync('src/styles/gmaps.css', `${OUT}/sites/gmaps.css`);
cpSync('src/styles/booking-hotel.css', `${OUT}/sites/booking-hotel.css`);
cpSync('src/styles/letterboxd.css', `${OUT}/sites/letterboxd.css`);
cpSync('src/styles/imdb.css', `${OUT}/sites/imdb.css`);
cpSync('src/styles/reddit.css', `${OUT}/sites/reddit.css`);

console.log(`Build complete → ./${OUT}/`);
