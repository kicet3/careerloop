import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // 테스트용 가짜 LLM·도우미(src/test/**)는 테스트 파일에서만 쓴다. 앱 코드가 가짜 심사 결과를 낼 수 없게 막는다.
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}"],
    ignores: ["src/**/*.test.{ts,tsx}", "src/**/*.test-utils.{ts,tsx}", "src/test/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/test", "@/test/*", "**/test/fake-llm"],
              message: "테스트 전용 모듈입니다. 앱 코드에서는 실제 엔진(createLlmClient)을 쓰세요.",
            },
            {
              group: ["@electric-sql/pglite", "@electric-sql/pglite/*", "pglite-prisma-adapter"],
              message: "PGlite는 테스트 DB 전용입니다. 앱 코드는 @/lib/db/client의 prisma를 쓰세요.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 런타임 데이터(gitignore 대상: 업로드·DB·엔진 공급자 파일). 소스가 아니다.
    "data/**",
    // Prisma 생성 클라이언트(prisma generate). 소스가 아니다.
    "src/generated/**",
  ]),
]);

export default eslintConfig;
