const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.join(__dirname, '..');
const apiDir = path.join(root, 'app', 'api');
const apiBak = path.join(root, '_api_bak');

const isCapacitor = process.env.NEXT_PUBLIC_CAPACITOR === 'true';

// Keep android/app/build.gradle versionName/Code in sync with package.json
if (isCapacitor) {
  execSync('node scripts/sync-android-version.js', { stdio: 'inherit', cwd: root });
}

const PWA_PATTERNS = ['sw.js', 'sw.js.map', 'manifest.json', '_pwa-meta.html'];
const WORKBOX_PREFIX = 'workbox-';
const FALLBACK_PREFIX = 'fallback-';
const publicDir = path.join(root, 'public');
const pwaBakDir = path.join(root, '_pwa_bak');

function listPwaFiles() {
  const files = [];
  for (const name of PWA_PATTERNS) {
    const p = path.join(publicDir, name);
    if (fs.existsSync(p)) files.push(p);
  }
  if (fs.existsSync(publicDir)) {
    for (const entry of fs.readdirSync(publicDir)) {
      if (entry.startsWith(WORKBOX_PREFIX) || entry.startsWith(FALLBACK_PREFIX)) {
        files.push(path.join(publicDir, entry));
      }
    }
  }
  return files;
}

// Clear Next.js cache to prevent stale references
fs.rmSync(path.join(root, '.next'), { recursive: true, force: true });

// Stash PWA artifacts only for Capacitor builds (so the APK doesn't ship them).
// For GH Pages we want the SW + manifest to ship, so we leave them in place.
let stashed = [];
if (isCapacitor) {
  stashed = listPwaFiles();
  fs.mkdirSync(pwaBakDir, { recursive: true });
  for (const src of stashed) {
    const dest = path.join(pwaBakDir, path.basename(src));
    fs.renameSync(src, dest);
  }
}

// Stash app/api (both static-export modes need this — no server routes in `output: export`)
fs.cpSync(apiDir, apiBak, { recursive: true });
fs.rmSync(apiDir, { recursive: true, force: true });

try {
  execSync('npx cross-env NEXT_PUBLIC_MOBILE=true next build', { stdio: 'inherit', cwd: root });
} finally {
  // Restore app/api
  fs.cpSync(apiBak, apiDir, { recursive: true });
  fs.rmSync(apiBak, { recursive: true, force: true });

  // Restore PWA artifacts (if we stashed any)
  if (isCapacitor) {
    for (const src of stashed) {
      const fromBak = path.join(pwaBakDir, path.basename(src));
      if (fs.existsSync(fromBak)) {
        fs.renameSync(fromBak, src);
      }
    }
    fs.rmSync(pwaBakDir, { recursive: true, force: true });
  }
}
