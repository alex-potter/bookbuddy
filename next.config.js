/** @type {import('next').NextConfig} */
const isMobile = process.env.NEXT_PUBLIC_MOBILE === 'true';

const nextConfig = {
  // Static export for Capacitor/APK builds; normal server build otherwise
  ...(isMobile ? { output: 'export', trailingSlash: true } : {}),
  images: {
    // Required for next export (no image optimisation in static builds)
    unoptimized: isMobile,
  },
};

module.exports = nextConfig;
