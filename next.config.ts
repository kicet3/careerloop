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
  // PDF 생성(@react-pdf)·neo4j-driver(경력 그래프)는 번들링하지 않고 Node 런타임에서 그대로 불러온다.
  // DB: Prisma 7 생성 클라이언트(src/generated/prisma, 순수 TS — 번들에 포함)와 어댑터(@prisma/adapter-pg·pg)는
  // Node 런타임에서 그대로 불러온다(쿼리 컴파일러 WASM은 @prisma/client/runtime에 있다). @aws-sdk/client-s3는 Next 기본 외부 패키지 목록에 있다.
  // 테스트 전용 @electric-sql/pglite·pglite-prisma-adapter는 앱 코드에서 불러오지 않는다(ESLint로 src/test/** 사용을 막는다).
  // 공고 원문 캡처(src/lib/postings/capture.ts): puppeteer-core와 @sparticuz/chromium(실행 시 bin/*.br을 /tmp에 풀어 쓰는 ESM 패키지)도
  // 번들링하지 않는다. 함수 크기·시간 고려사항은 docs/POSTING-CAPTURE.md.
  serverExternalPackages: [
    "@react-pdf/renderer",
    "unpdf",
    "mammoth",
    "neo4j-driver",
    "@prisma/client",
    "@prisma/adapter-pg",
    "pg",
    "@sparticuz/chromium",
    "puppeteer-core",
  ],
  // 런타임에 process.cwd() 기준으로 읽는 파일(PDF 한글 폰트, pdf.js CMap)을 서버 번들 추적에 포함한다.
  // 마이그레이션 SQL(prisma/migrations)은 런타임에 읽지 않는다(배포 빌드의 scripts/migrate.mjs가 적용).
  outputFileTracingIncludes: {
    // 한국어 CID 글꼴 PDF의 텍스트 추출에 필요한 CMap (src/lib/ingest/extract.ts)
    "/api/diagnoses": ["./node_modules/pdfjs-dist/cmaps/**/*"],
    // 포트폴리오 업로드·R2 업로드 마무리도 같은 PDF 추출을 쓴다.
    "/api/portfolios": ["./node_modules/pdfjs-dist/cmaps/**/*"],
    "/api/portfolios/*": ["./node_modules/pdfjs-dist/cmaps/**/*"],
    "/api/resumes/*/portfolio": ["./node_modules/pdfjs-dist/cmaps/**/*"],
    "/api/diagnoses/*/pdf": ["./src/lib/report/fonts/**/*"],
    "/api/share/*/pdf": ["./src/lib/report/fonts/**/*"],
    // 이력서 PDF도 보고서와 같은 나눔고딕을 쓴다 (src/lib/resumes/pdf-fonts.ts)
    "/api/resumes/*/pdf": ["./src/lib/report/fonts/**/*"],
    // 원문 캡처를 after()로 실행하는 라우트: @sparticuz/chromium의 압축된 Chromium(bin/*.br, 약 67MB)은 런타임에 경로로 읽으므로
    // 추적에 직접 넣는다. 다른 라우트 함수에는 넣지 않는다(함수 크기 250MB 상한).
    "/api/postings/import": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/postings/import/*": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/postings/*/capture": ["./node_modules/@sparticuz/chromium/bin/**/*"],
    "/api/shared-postings/*/capture": ["./node_modules/@sparticuz/chromium/bin/**/*"],
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
