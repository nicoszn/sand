import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon - keep it out of the client/server
  // component bundling and let Node require() it directly at runtime.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
