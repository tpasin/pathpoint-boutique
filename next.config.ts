import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @cursor/sdk ships webpack LICENSE.txt side-effects that Turbopack rejects;
  // keep it external so Node loads the package at runtime.
  serverExternalPackages: ["@cursor/sdk"],
};

export default nextConfig;
