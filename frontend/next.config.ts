import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import path from "node:path";
import withPWA from "next-pwa";

const dev = process.env.NODE_ENV !== "production";
const configDirectory = path.dirname(fileURLToPath(import.meta.url));
// 开发模式允许访问 Next.js 热更新资源的主机名，逗号分隔并支持部署环境覆盖。
const allowedDevOrigins = (process.env.FLYREQ_ALLOWED_DEV_ORIGINS || "127.0.0.1,localhost")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // 显式声明追踪根目录，避免 Next.js 16 在 monorepo/多 lockfile 场景下产生警告
  outputFileTracingRoot: configDirectory,
  // 仅在生产构建时启用静态导出，开发模式关闭以支持 HMR 热更新
  ...(dev ? { allowedDevOrigins } : { output: "export" }),
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default withPWA({
  dest: "public",
  disable: dev,
  register: true,
  skipWaiting: true,
})(nextConfig);
