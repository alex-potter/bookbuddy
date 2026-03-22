/** @type {import('next').NextConfig} */
const { version } = require('./package.json');
const isMobile = process.env.NEXT_PUBLIC_MOBILE === 'true';
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

const nextConfig = {
  env: { NEXT_PUBLIC_APP_VERSION: version },
  // Static export for Capacitor/APK builds; normal server build otherwise
  ...(isMobile ? { output: 'export', trailingSlash: true } : {}),
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  images: {
    // Required for next export (no image optimisation in static builds)
    unoptimized: isMobile,
  },
};

module.exports = nextConfig;
