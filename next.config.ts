import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { validateProductionEnv } from "./src/lib/config/env-rules";

/**
 * Vercel 빌드에서는 런타임과 같은 배포 모드 검사를 빌드 때 한다. PRODUCTION(Vercel Production 배포는 APP_ENV를 비워도
 * PRODUCTION)인데 필수 설정이 빠졌으면 빌드를 실패시켜, 모든 요청이 500이 되는 배포가 Ready로 올라가지 않게 한다.
 */
function checkVercelBuildEnv(phase: string): void {
  if (phase !== PHASE_PRODUCTION_BUILD || !process.env.VERCEL) return;
  const { env, warnings } = validateProductionEnv(process.env);
  console.log(`[env] Vercel 빌드: APP_ENV=${env}${warnings.length ? `\n- ${warnings.join("\n- ")}` : ""}`);
}

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
  // neo4j-driver(경력 그래프)도 Node 런타임에서 그대로 불러온다. @aws-sdk/client-s3는 Next 기본 외부 패키지 목록에 있다.
  serverExternalPackages: ["@react-pdf/renderer", "@libsql/client", "unpdf", "mammoth", "neo4j-driver"],
  // 런타임에 process.cwd() 기준으로 읽는 파일(마이그레이션 SQL, PDF 한글 폰트, pdf.js CMap)을 서버 번들 추적에 포함한다.
  outputFileTracingIncludes: {
    "/*": ["./drizzle/**/*"],
    // 한국어 CID 글꼴 PDF의 텍스트 추출에 필요한 CMap (src/lib/ingest/extract.ts)
    "/api/diagnoses": ["./node_modules/pdfjs-dist/cmaps/**/*"],
    "/api/diagnoses/*/pdf": ["./src/lib/report/fonts/**/*"],
    "/api/share/*/pdf": ["./src/lib/report/fonts/**/*"],
    // 이력서 PDF도 보고서와 같은 나눔고딕을 쓴다 (src/lib/resumes/pdf-fonts.ts)
    "/api/resumes/*/pdf": ["./src/lib/report/fonts/**/*"],
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

export default function config(phase: string): NextConfig {
  checkVercelBuildEnv(phase);
  return nextConfig;
}
