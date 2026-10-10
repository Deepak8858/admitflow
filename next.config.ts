import type { NextConfig } from "next";

// Report-only until production violation reports are reviewed; Next.js and the theme bootstrap still emit inline scripts.
function contentSecurityPolicy(development = process.env.NODE_ENV === "development") {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""} https://connect.facebook.net`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.facebook.com https://*.fbcdn.net",
    "font-src 'self'",
    `connect-src 'self' https://*.facebook.com https://connect.facebook.net${development ? " ws:" : ""}`,
    "frame-src https://www.facebook.com https://web.facebook.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}


const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  async redirects() {
    return [{ source: "/welcome", destination: "/", permanent: true }];
  },
  async headers() {
    return [{ source: "/(.*)", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "Content-Security-Policy-Report-Only", value: contentSecurityPolicy() },
      ...(process.env.NODE_ENV === "production" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }] : []),
    ] }];
  },
};
export default config;
