import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // PDF 생성(@react-pdf)과 libsql 네이티브 바인딩은 번들링하지 않고 Node 런타임에서 그대로 불러온다.
  serverExternalPackages: ["@react-pdf/renderer", "@libsql/client", "unpdf", "mammoth"],
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
