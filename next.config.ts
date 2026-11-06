import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // a separate build folder lets a preview build run beside the main server (set NEXT_DIST_DIR)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
