import "server-only";
/** 배포 모드(APP_ENV) 규칙의 서버 전용 입구. 규칙 자체는 env-rules.ts(순수 — next.config.ts의 빌드 검사도 쓴다). */
export * from "./env-rules";
