import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  ...(process.env.CAPACITOR_BUILD === 'true'
    ? { output: 'export' as const, images: { unoptimized: true } }
    : {}),
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
