import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 개발 서버를 Tailscale(MagicDNS *.ts.net·tailnet IP) 등 localhost 밖의 주소로 열 때 dev 자산·HMR 요청을 허용한다.
  // 추가 호스트는 DEV_ALLOWED_ORIGINS에 쉼표로(호스트명만, 스킴·포트 없이). 운영 빌드(next start)에는 영향 없다.
  allowedDevOrigins: [
    "**.ts.net",
    ...(process.env.DEV_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  ],
  // PDF 생성(@react-pdf)과 libsql 네이티브 바인딩은 번들링하지 않고 Node 런타임에서 그대로 불러온다.
  serverExternalPackages: ["@react-pdf/renderer", "@libsql/client", "unpdf", "mammoth"],
  // 런타임에 process.cwd() 기준으로 읽는 파일(마이그레이션 SQL, PDF 한글 폰트, pdf.js CMap)을 서버 번들 추적에 포함한다.
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*"],
    // 한국어 CID 글꼴 PDF의 텍스트 추출에 필요한 CMap (src/lib/ingest/extract.ts)
    "/api/diagnoses": ["./node_modules/pdfjs-dist/cmaps/**/*"],
    "/api/diagnoses/*/pdf": ["./src/lib/report/fonts/**/*"],
    "/api/share/*/pdf": ["./src/lib/report/fonts/**/*"],
  },
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
