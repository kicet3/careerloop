# CareerLoop

내 경력과 경험을 한곳에 체계적으로 쌓아 두고, 그 기록으로 이력서 초안을 만들고 채용 공고(JD)를 분석하는 개인용 커리어 관리 웹 서비스입니다.

## 만든 이유

경력과 경험을 체계적으로 관리하지 못하고 있었습니다. 프로젝트에서 무엇을 했고 어떤 성과가 있었는지가 예전 이력서, 메모, 기억 속에 흩어져 있어서 이력서를 쓸 때마다 처음부터 다시 정리해야 했습니다.

CareerLoop는 이 문제를 풀려고 만들었고, 지금 이렇게 쓰고 있습니다.

- **경험·경력을 체계적으로 관리합니다.** 회사·직무·프로젝트·경험·기술·성과를 그래프로 이어 두고, 새 경험이 생기면 대화나 파일 업로드로 계속 채워 넣습니다.
- **이력서 초안을 만듭니다.** 쌓아 둔 경험을 근거로 공고에 맞는 이력서 초안을 만들고 다듬습니다. 근거가 없는 내용은 지어내지 않습니다.
- **JD 분석에 활용합니다.** 채용 공고를 가져와 필수·우대 요건을 구조화하고, 내 경력과 대조해 증명된 것과 빠진 것을 확인합니다.

## 주요 기능

| 영역 | 내용 | 화면 |
|---|---|---|
| 경험 그래프 | 회사·직무·프로젝트·경험·기술·성과·학력·자격증을 관계로 잇는 개인 경력 저장소(Neo4j). 관계도·목록으로 보고 직접 편집 | `/app/graph` |
| 대화로 경험 정리 | 경험을 이야기하거나 이력서·포트폴리오 파일을 올리면 AI가 변경안을 제안하고, 확인한 것만 그래프에 적용. 빈 곳은 후속 질문으로 관리 | `/app/graph` |
| 그래프에 묻기 | 내 그래프만 근거로 답하고 문장마다 출처(노드·경로)를 표시 | `/app/graph` |
| 공고 보관함(JD) | 링크·본문 붙여넣기로 공고를 가져와 회사·직무·마감일·요건을 구조화. 원문 캡처 보존 | `/app/postings` |
| 내 경력과 대조 | 공고가 요구하는 기술을 경험 그래프와 맞춰 '경력으로 증명됨 / 보유만 표시 / 그래프에 없음'으로 분류. 여러 공고에서 자주 빠지는 기술(스킬 갭) 집계 | `/app/postings/[id]` |
| 이력서 | 경험 그래프 기반 AI 초안, JD 분석 → 근거 검색 → 구역별 작성 에이전트, 대화형 첨삭, 버전 저장·복원, PDF 다운로드 | `/app/resumes` |
| 포트폴리오 | PDF 보관, 경험 그래프 기반 포트폴리오 생성, 공개 링크와 방문자 챗봇 | `/app/portfolios` |
| 진단 | 이력서를 AI 심사위원 7명이 평가. JD 적합도 매트릭스, 문제 목록, 개선 방향, 재작성본. 웹·PDF·Markdown 보고서와 읽기 전용 공유 링크 | `/app/new` |
| 면접 연습 | 이력서 근거로 질문 세트를 만들고 답변에 피드백 | `/app/interview` |
| 지원 현황 | 지원 단계 보드, 지원 시점 이력서 제출본 고정, 실제 결과 기반 집계 | `/app/applications` |
| MCP 연결 | 개인 토큰으로 Claude Code·Cursor·Claude Desktop에서 내 경험 그래프를 읽기 전용 조회 | `/app/mcp` |
| GitHub 연동 | 저장소를 프로젝트 노드에 잇고 저장소 정보로 변경안·후속 질문 생성 | `/app/account` |

업로드는 PDF·DOCX·HWP(5.x)·HWPX·HTML·TXT·MD를 받습니다(포트폴리오 보관함은 PDF만).

AI가 만든 초안·진단은 언어 모델의 의견이며, 면접이나 합격을 보장하지 않습니다.

## 구성

```
브라우저 ─────────────┐           MCP 클라이언트(Claude Code 등)
                      ▼                     ▼
          ┌────────────────────────────────────────────┐
          │ Next.js 앱 (화면 + API 라우트 + /api/mcp)    │──(서명된 요청)──▶ Python 워커(선택)
          └──┬─────────┬──────────┬──────────┬─────────┘                  장시간 AI 작업
             ▼         ▼          ▼          ▼
        PostgreSQL   Neo4j     R2 / 로컬   LLM
        (Prisma)   경험 그래프   파일 저장   (Claude API 또는 CLI 엔진)
```

| 계층 | 기술 |
|---|---|
| 웹 | Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS 4 |
| DB | PostgreSQL 17 + Prisma 7 (배포는 Supabase PostgreSQL) |
| 그래프 | Neo4j 5 (선택 — 없으면 그래프 기능만 꺼짐) |
| 파일 저장 | Cloudflare R2 (선택 — 없으면 로컬 폴더 `./data/storage`) |
| LLM | Anthropic Claude API, 또는 Claude Code·Codex CLI 계정 로그인 엔진 |
| 워커 | Python 3.12 + FastAPI (`worker/`, 선택) |
| 테스트 | vitest + PGlite, 워커는 pytest |

| 경로 | 역할 |
|---|---|
| `src/app/` | 화면과 API 라우트 |
| `src/components/` | 화면 컴포넌트 |
| `src/lib/` | 서버 도메인 로직(인증, 그래프, RAG, 이력서 에이전트, 진단 파이프라인 등) |
| `prisma/` | 스키마와 마이그레이션 |
| `worker/` | Python 워커 |
| `deploy/` | 자체 호스팅용 Neo4j·워커 Docker 구성 예시 |
| `docs/` | 설계·운영 문서 |

## 로컬 실행

### 준비물

- Node.js **22.x**
- Docker (Compose v2) — 로컬 PostgreSQL, 선택으로 Neo4j
- Google OAuth 클라이언트 — 회원가입이 Google 계정으로만 되므로 필요합니다(아래 3번)
- AI 엔진 하나 — Anthropic API 키, 또는 Claude Code·Codex CLI(아래 4번)

### 1. 설치와 DB

```bash
git clone https://github.com/kicet3/careerloop.git
cd careerloop
cp .env.example .env.local     # DATABASE_URL 기본값이 아래 docker postgres를 가리킨다
npm i                          # postinstall이 prisma generate를 실행한다
npm run db:up                  # 로컬 PostgreSQL(docker, 127.0.0.1:54329)
npm run db:migrate             # 마이그레이션 적용
```

- 포트 54329가 이미 쓰이면 `.env.local`에 `POSTGRES_PORT=<다른 포트>`를 넣고 `DATABASE_URL`의 포트도 같이 바꿉니다.
- 서버는 마이그레이션을 자동으로 적용하지 않습니다. 새 마이그레이션을 받으면 `npm run db:migrate`를 다시 실행하세요.

### 2. `.env.local` 최소 설정

| 변수 | 값 |
|---|---|
| `DATABASE_URL` | `.env.example` 기본값 그대로 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 3번에서 발급한 값 |
| `ADMIN_EMAILS` | 본인 Google 이메일. 새 가입자는 승인 대기로 시작하므로, 여기에 넣어야 첫 계정이 관리자로 자동 승인됩니다 |
| `ANTHROPIC_API_KEY` 또는 `CLI_PROVIDERS=1` | AI 엔진(4번) |

### 3. Google 로그인 설정

1. [Google Cloud Console](https://console.cloud.google.com/) → API 및 서비스 → OAuth 동의 화면을 만들고 범위 `openid`·`email`·`profile`을 씁니다.
2. 사용자 인증 정보 → OAuth 클라이언트 ID(유형: 웹 애플리케이션)를 만듭니다.
3. 승인된 리디렉션 URI에 `http://localhost:3000/api/auth/google/callback`을 추가합니다.
4. 클라이언트 ID·보안 비밀을 `.env.local`에 넣습니다.

가입은 Google로만 하고, 이메일·비밀번호 로그인은 가입 후 **설정 > 계정**에서 비밀번호를 정한 계정만 쓸 수 있습니다.

### 4. AI 엔진

둘 중 하나를 고릅니다. 둘 다 없으면 화면은 뜨지만 AI 기능이 동작하지 않습니다.

- **Claude API**: `ANTHROPIC_API_KEY`를 넣습니다. 기본 모델은 `claude-opus-5-5`이고 `ANTHROPIC_MODEL`로 바꿉니다.
- **계정 로그인 엔진(개인용)**: 서버 PC에 [Claude Code](https://docs.claude.com/en/docs/claude-code)(`claude`)나 [Codex CLI](https://github.com/openai/codex)(`codex`)를 설치하고 `CLI_PROVIDERS=1`을 넣은 뒤, 관리자 계정으로 왼쪽 메뉴 **AI 연결**에서 로그인합니다. 이 서버에 가입한 모든 사용자가 그 구독 계정을 쓰게 되므로 본인 PC에서 혼자 쓸 때만 켜세요. Vercel 같은 서버리스 배포에서는 동작하지 않습니다.

### 5. 실행

```bash
npm run dev
```

http://localhost:3000 을 열고 Google로 로그인합니다.

### 6. 경험 그래프(Neo4j) 켜기

경험 그래프, 그래프 대화, 그래프 기반 이력서 초안은 Neo4j가 있어야 동작합니다. `NEO4J_URI`를 비우면 해당 화면은 안내만 보이고 나머지 기능은 그대로 동작합니다.

```bash
# .env.local: NEO4J_URI=bolt://127.0.0.1:7687, NEO4J_USER=neo4j, NEO4J_PASSWORD=<직접 정한 비밀번호>
docker compose --env-file .env.local -p resume-career up -d neo4j
```

제약 조건과 인덱스는 첫 연결 때 자동으로 만들어집니다. 콘솔은 http://127.0.0.1:7474 (루프백 전용)입니다.

### 그 밖의 선택 기능

| 기능 | 켜는 방법 | 문서 |
|---|---|---|
| 파일 저장소 R2 | `R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET` 네 값 모두(하나라도 비면 로컬 폴더) | [`docs/STORAGE.md`](docs/STORAGE.md) |
| 실시간 알림 | Supabase Realtime 설정(없으면 새로고침 방식) | [`docs/REALTIME.md`](docs/REALTIME.md) |
| GitHub 연동 | GitHub App 설정 | [`docs/GITHUB.md`](docs/GITHUB.md) |
| MCP | 앱의 `/app/mcp`에서 토큰 발급 | [`docs/MCP.md`](docs/MCP.md) |
| Python 워커 | `WORKER_URL`·`WORKER_SHARED_SECRET`·`WORKER_JOBS`(없으면 Next 서버가 직접 실행) | [`docs/PYTHON-WORKER.md`](docs/PYTHON-WORKER.md), [`worker/README.md`](worker/README.md) |

### 명령

```bash
npm run dev                       # 개발 서버
npm test                          # vitest (Docker·DB·API 키 없이 실행된다)
npm run lint
npm run typecheck
npm run build && npm start        # 프로덕션 빌드 실행(APP_ENV 기본 DEV)
npm run db:up                     # 로컬 postgres(docker)
npm run db:migrate                # 마이그레이션 적용
npm run db:dev -- --name <이름>   # 스키마 변경 → 새 마이그레이션
npm run db:studio                 # prisma studio
cd worker && uv sync && uv run pytest -q   # 워커 테스트
```

## 배포

운영 구성은 Vercel(Next.js 앱) + Supabase PostgreSQL + 자체 호스팅 Neo4j + Cloudflare R2이고, 장시간 작업용 Python 워커를 선택으로 둡니다. `APP_ENV=PRODUCTION`에서는 필수 설정이 하나라도 빠지면 빌드·기동이 누락 목록과 함께 실패합니다.

- 배포 모드, 환경 변수 전체 목록, Vercel 배포 절차: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)
- 운영 환경 변수 템플릿: [`.env.production.example`](.env.production.example)
- 자체 호스팅 Neo4j·워커: [`deploy/graph/README.md`](deploy/graph/README.md), [`deploy/worker/README.md`](deploy/worker/README.md)

저장소의 문서·예시에 나오는 도메인·IP·경로는 자리표시자입니다. 실제 접속 주소와 비밀값은 git에서 제외된 `.env*` 파일과 배포 환경 변수에만 둡니다.

## 문서

| 문서 | 내용 |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 전체 설계 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 배포·환경 변수·운영 |
| [`docs/AGENTIC-GRAPH-RAG.md`](docs/AGENTIC-GRAPH-RAG.md), [`docs/GRAPH-QA.md`](docs/GRAPH-QA.md) | 그래프 검색과 질의응답 |
| [`docs/RESUME-AGENT.md`](docs/RESUME-AGENT.md), [`docs/RESUME-SECTION-AGENTS.md`](docs/RESUME-SECTION-AGENTS.md), [`docs/RESUME-POLISH-TOOLS.md`](docs/RESUME-POLISH-TOOLS.md) | 이력서 작성 에이전트와 첨삭 |
| [`docs/EXPERIENCE-CATEGORIES.md`](docs/EXPERIENCE-CATEGORIES.md) | 경험 체크리스트 기준 |
| [`docs/POSTING-CAPTURE.md`](docs/POSTING-CAPTURE.md) | 공고 원문 캡처 |
| [`docs/PYTHON-WORKER.md`](docs/PYTHON-WORKER.md) | Python 워커 |
| [`docs/STORAGE.md`](docs/STORAGE.md), [`docs/REALTIME.md`](docs/REALTIME.md), [`docs/GITHUB.md`](docs/GITHUB.md), [`docs/MCP.md`](docs/MCP.md) | 저장소, 실시간 알림, GitHub, MCP |

## 원본과 라이선스

MIT 라이선스입니다([`LICENSE`](LICENSE)).

진단 기능은 Alex Chen(@nocodealex)의 Claude Code 스킬 [hiring-panel-skill](https://github.com/alexyc9381/hiring-panel-skill)(MIT)을 웹 서비스로 옮기고 확장한 것입니다. 저작권 고지와 라이선스 전문은 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)에 있습니다. PDF에 쓰는 나눔고딕 폰트는 SIL Open Font License 1.1을 따릅니다(`src/lib/report/fonts/OFL.txt`).
