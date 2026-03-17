import esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'fs';

const OUT = 'truescore';

// Clean
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/sites`, { recursive: true });
mkdirSync(`${OUT}/popup`, { recursive: true });

// Bundle site scripts
await esbuild.build({
  entryPoints: [
    'src/sites/airbnb.ts',
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
    'src/sites/goodreads.ts',
    'src/sites/gmaps.ts',
    'src/sites/gmaps-bridge.ts',
    'src/sites/imdb.ts',
    'src/sites/letterboxd.ts',
    'src/sites/transfermarkt.ts',
  ],
  bundle: true,
  outdir: `${OUT}/sites`,
  format: 'iife',
  target: ['chrome120'],
  minify: false,
  define: {
    'process.env.GEMINI_API_KEY': JSON.stringify(process.env.GEMINI_API_KEY || ''),
  },
});

// Bundle background
await esbuild.build({
  entryPoints: ['src/background.ts'],
  bundle: true,
  outdir: OUT,
  format: 'iife',
  target: ['chrome120'],
  minify: false,
});

// Bundle popup
await esbuild.build({
  entryPoints: ['src/popup/popup.ts'],
  bundle: true,
  outdir: `${OUT}/popup`,
  format: 'iife',
  target: ['chrome120'],
  minify: false,
});

// Static assets
cpSync('src/manifest.json', `${OUT}/manifest.json`);
cpSync('src/popup/popup.html', `${OUT}/popup/popup.html`);
cpSync('src/popup/popup.css', `${OUT}/popup/popup.css`);
cpSync('src/styles/amazon-product.css', `${OUT}/sites/amazon-product.css`);
cpSync('src/styles/gmaps.css', `${OUT}/sites/gmaps.css`);

console.log(`Build complete → ./${OUT}/`);
