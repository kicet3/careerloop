# CareerLoop 에이전트 실행기 — 같은 Next.js 앱을 맥미니에서 `next start`로 띄워 에이전트 이력서 작성(단계 실행)만 맡긴다(README.md).
# 빌드 문맥은 저장소 루트다(docker-compose.yml 참고).
#   docker build -f deploy/agent/Dockerfile -t careerloop-agent .
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# 의존성 층(잠금 파일이 바뀔 때만 다시 받는다). postinstall의 prisma generate가 스키마·설정을 읽는다.
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
# prisma.config.ts가 불러오는 설정 모듈
COPY src/lib/config ./src/lib/config
RUN npm ci
COPY . .
# 빌드에는 비밀값이 필요 없다(APP_ENV를 비워 DEV 규칙으로 검사 — 운영 검사는 컨테이너 시작 때 instrumentation이 한다).
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    RESUME_AGENT_RUNNER=1
# 앱은 런타임에 cwd 기준 파일(next.config.ts가 불러오는 src/lib/config, PDF 글꼴 등)을 읽으므로 빌드 결과를 통째로 옮긴다.
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/internal/resume-agent/health').then(r=>process.exit(r.status===204?0:1)).catch(()=>process.exit(1))"]
CMD ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]
