import path from "node:path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  agentRules: false,
  outputFileTracingRoot: path.join(process.cwd())
};

export default nextConfig;
