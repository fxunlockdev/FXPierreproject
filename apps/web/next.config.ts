import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@pierre/core"],
  poweredByHeader: false,
  // Playwright drives the dev server via 127.0.0.1; Next 16 treats that as a
  // cross-origin dev host and silently blocks hydration without this.
  allowedDevOrigins: ["127.0.0.1"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
