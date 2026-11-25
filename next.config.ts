import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native addon - keep it out of the client/server
  // component bundling and let Node require() it directly at runtime.
  // onnxruntime ships native binaries and loads .onnx weights from disk, so the
  // embedding stack must stay outside the server bundle as well.
  serverExternalPackages: ["better-sqlite3", "@huggingface/transformers", "onnxruntime-node"],

  // Dev only: allow the dev-server preview hostname to load dev assets and
  // HMR. Read from the environment so no deployment-specific host is tracked
  // in the repo, and it has no effect on a production build.
  allowedDevOrigins: process.env.NEXT_ALLOWED_DEV_ORIGIN ? [process.env.NEXT_ALLOWED_DEV_ORIGIN] : [],
};

export default nextConfig;
