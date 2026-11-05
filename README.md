# CareerLoop

이력서를 올리면 AI 심사위원 7명(서류 자동 필터, 채용 담당자, 현업 매니저, 경쟁 지원자, 대표, 헤드헌터, 동료)이
각자 떨어뜨릴 이유를 찾고, 그 결과를 하나의 보고서로 묶어 주는 웹 서비스입니다.

- **JD 분석·적합도 매트릭스**: 채용 공고(JD)를 붙여넣거나 파일로 올리면 필수/우대 요건과 키워드를 뽑고,
  요건마다 이력서 근거를 인용해 충족·부분·미충족을 표시합니다. JD가 없으면 직무명으로 요건을 *추정*하고 보고서에 경고를 띄웁니다.
- **문제점 목록**(심각도순, 지적한 심사위원 표시), **개선 방향성**(포지셔닝·우선순위·퀵윈·역량 공백·지원 전략·면접 대비)
- **개선된 이력서**: 같은 사실로 재작성하고, 모르는 내용은 지어내지 않고 `[ADD: 질문]`으로 남깁니다. 재작성본을 서류 필터에 다시 돌려 전/후 판정을 보여 줍니다.
- 웹 보고서, **PDF 다운로드**(한글 폰트 내장), 원본 스킬 호환 Markdown(`PANEL.md`, `RESUME-IMPROVED.md`), 읽기 전용 공유 링크
- Google 회원가입, Google·이메일 로그인, 진단 이력
- **포트폴리오 함께 평가**(선택): 포트폴리오 파일·링크/설명을 이력서와 별도 자료로 심사위원 7명과 적합도·종합·재작성·계획 단계에 넣습니다.
- **심사위원과 대화**: 진단 보고서의 각 심사위원 카드에서 '이 심사위원과 대화'를 열어, 그 심사위원의 평가 기준으로
  피드백을 어떻게 고칠지 묻고 고친 문장을 다시 평가받습니다.
- **경력 그래프**(Neo4j): 회사·직무·프로젝트·경험·기술·성과·학력·자격증을 관계로 이어 개인 경력을 정리합니다.
  관계도/목록으로 보고 직접 편집하거나, **대화로** 경험을 이야기하면 AI가 변경안을 제안하고 확인 후 적용합니다.
- **회사별 이력서**: 경력 그래프나 진단 재작성본으로 AI 초안을 만들고, 양식 6종·버전 저장/복원·PDF 다운로드를 지원합니다.
- **공고 보관함**: 채용 공고 링크를 붙여넣으면 서버가 공개 페이지를 읽고 AI가 회사·직무·마감일을 정리합니다(본문 근거가 있는
  값만 저장). 직접 추가도 되고, 마감일(KST)·상태·검색으로 관리하며 공고에서 바로 진단·이력서·지원 기록을 시작합니다.
- **내 경력과 대조**: 공고가 요구하는 기술을 경력 그래프와 맞춰 '경력으로 증명됨 / 보유만 표시 / 그래프에 없음'으로 나누고,
  여러 공고에서 자주 빠지는 기술(스킬 갭)을 그래프 화면에 모아 보여 줍니다. AI 호출 없이 계산합니다.
- **지원 현황**: 지원 단계 칸반(모바일은 단계 필터 목록), 단계 이력, 지원 시점 이력서 버전의 제출본 고정(원본을 지워도 PDF 유지),
  실제 결과 기반 응답률·단계 도달·이력서 버전별·회사별 집계와 마감·일정 할 일 제안. 합격 가능성 같은 예측은 하지 않습니다.
- **업로드 형식**: 이력서·포트폴리오·JD 파일은 PDF·DOCX·HWP(5.x)·HWPX·HTML·TXT·MD를 받습니다.

설계 문서는 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)에 있습니다.

## 원본과 라이선스

이 프로젝트는 Alex Chen(@nocodealex)의 Claude Code 스킬
[hiring-panel-skill](https://github.com/alexyc9381/hiring-panel-skill)을 웹 서비스로 옮기고 확장한 것입니다.
원본은 MIT 라이선스이며, 저작권 고지와 라이선스 전문은 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)에 있습니다.
PDF에 쓰는 나눔고딕 폰트는 SIL Open Font License 1.1을 따릅니다(`src/lib/report/fonts/OFL.txt`).

보고서는 언어 모델이 만든 구조화된 두 번째 의견이며, 면접이나 합격을 보장하지 않습니다.

## 로컬 실행

Node.js 20 이상이 필요합니다.

```bash
cp .env.example .env.local
npm i
npm run dev
```

http://localhost:3000 에서 가입하면 바로 쓸 수 있습니다.

- **마이그레이션은 자동입니다.** 서버가 뜰 때(`src/instrumentation.ts`) `./drizzle`의 마이그레이션을 적용하고,
  기본값으로 `./data/app.db` SQLite 파일을 만듭니다. 따로 `db:migrate`를 돌릴 필요가 없습니다.
- **API 키 없이 로컬에서 확인하려면** Claude/ChatGPT 계정 로그인 엔진을 쓰세요(아래 '계정 로그인으로 쓰기', `CLI_PROVIDERS=1`).
  가짜 심사위원(mock) 엔진은 없앴습니다. 테스트는 실제 LLM 대신 가짜 클라이언트(`src/test/fake-llm.ts`)를 주입합니다.
- 실제 진단은 `ANTHROPIC_API_KEY`를 넣으면 됩니다. 기본 모델은 `claude-opus-5-5`(`ANTHROPIC_MODEL`로 변경), 진단 1회에 LLM 호출 13회입니다.

### 계정 로그인으로 쓰기 (임시·개인용)

API 키 없이 **Claude 구독 계정**(Pro·Max)이나 **ChatGPT 계정**으로 진단을 돌릴 수 있습니다.
[paperclip](https://github.com/paperclipai/paperclip)의 `claude-local`·`codex-local` 어댑터처럼, 서버 PC에 설치된 공식 CLI에
로그인시키고 그 CLI(`claude -p`, `codex exec`)로 모델을 호출합니다.

1. 서버 PC에 [Claude Code](https://docs.claude.com/en/docs/claude-code)(`claude`)나 [Codex CLI](https://github.com/openai/codex)(`codex`)를 설치합니다.
2. `.env.local`에 `CLI_PROVIDERS=1`을 넣고 서버를 다시 시작합니다.
3. 왼쪽 메뉴 **AI 연결**에서 로그인합니다.
   - Claude: [로그인 링크 열기] → 브라우저에서 승인 → 표시된 코드를 화면에 붙여넣기
   - ChatGPT: [인증 페이지 열기] → 화면의 1회용 코드 입력(ChatGPT 보안 설정에서 기기 코드 인증을 허용해야 할 수 있음)
4. 새 진단의 **AI 엔진**에서 연결한 계정을 고릅니다. 재시도도 같은 엔진으로 돌아갑니다.

로그인 정보는 CLI가 앱 전용 폴더(`data/providers/claude`, `data/providers/codex` — git 제외)에 저장하므로, 이 PC의 개인
Claude Code·Codex 로그인과 섞이지 않고 웹에서 연결 해제해도 개인 로그인은 그대로입니다. 이미 로그인된 개인 CLI를 그대로 쓰려면
`CLAUDE_CLI_CONFIG_DIR=system`·`CODEX_CLI_HOME=system`으로 두세요(이때는 웹에서 로그인·로그아웃할 수 없습니다).

> 주의: 연결한 계정의 구독 사용량이 쓰이고, 이 서버에 가입한 모든 사용자가 그 계정으로 진단하게 됩니다. 본인 PC에서 혼자 쓸 때만
> 켜 두세요. 구독 계정을 다른 사람에게 서비스로 제공하는 것은 Anthropic·OpenAI 약관에 어긋날 수 있습니다. Vercel 같은 서버리스
> 배포에서는 CLI가 없어 동작하지 않습니다.

### 경력 그래프(Neo4j)와 이력서 저장소(R2)

경력 그래프·그래프 채팅·그래프 기반 이력서 초안은 Neo4j가 있어야 동작합니다. `NEO4J_URI`를 비우면 해당 화면은 안내만 보이고
API는 503을 돌려줍니다(진단·심사위원 대화·진단 기반 이력서는 그대로 동작). 개발용 Neo4j는 `docker-compose.yml`로 띄웁니다.

```bash
# .env.local에 NEO4J_URI=bolt://127.0.0.1:7687, NEO4J_USER=neo4j, NEO4J_PASSWORD=<비밀번호>
docker compose --env-file .env.local -p resume-career up -d neo4j
# 브라우저 콘솔: http://127.0.0.1:7474 (루프백에만 열림). 끄기: docker compose -p resume-career stop neo4j
```

제약 조건·인덱스는 첫 연결 때 자동으로 만듭니다. 모든 노드에 `userId`가 들어가고 모든 쿼리가 그 조건으로 묶입니다.

회사별 이력서 본문은 버전마다 JSON 객체(`users/<userId>/resumes/<resumeId>/v<n>.json`)로 저장합니다(메타는 SQLite).
`R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET` 네 값이 모두 있으면 Cloudflare R2를,
하나라도 비면 로컬 폴더(`STORAGE_DIR`, 기본 `./data/storage`)를 씁니다.

1. Cloudflare 대시보드 → R2에서 비공개 버킷을 만듭니다(공개 접근·커스텀 도메인 불필요).
2. R2 → API 토큰 관리에서 **객체 읽기 및 쓰기** 권한 토큰을 그 버킷으로만 제한해 만들고, Access Key ID·Secret Access Key를 받습니다.
3. 계정 ID와 함께 네 값을 `.env.local`(배포는 환경 변수)에 넣습니다. 관할 구역 버킷이면 `R2_ENDPOINT`를 직접 지정합니다.

> 서버리스 배포(Vercel)에서는 로컬 폴더가 유지되지 않으므로 이력서 기능을 쓰려면 R2가 필요합니다.

### Tailscale로 다른 기기에서 접속

`npm run dev`는 모든 인터페이스(:3000)에서 받으므로 tailnet 기기에서 바로 열 수 있다.

- HTTPS(권장, tailnet 전용): `tailscale serve --bg --https=9470 http://127.0.0.1:3000` → `https://<기기>.<tailnet>.ts.net:9470` (끄기: `tailscale serve --https=9470 off`)
- 직접: `http://<tailnet IP>:3000` — 이 경우 `.env.local`의 `DEV_ALLOWED_ORIGINS`에 그 IP를 넣는다(`*.ts.net`은 기본 허용).

계정 로그인 엔진(CLI_PROVIDERS)을 켠 채 열면 tailnet에서 가입한 모든 사용자가 그 구독 계정으로 진단한다.

### Google 로그인

Google 계정 로그인(OpenID Connect 인가 코드 + PKCE)은 별도 라이브러리 없이 `/api/auth/google`(시작)·`/api/auth/google/callback`(콜백)으로 동작합니다.
처음 로그인하면 계정이 만들어지고, 같은 이메일(인증된 Google 이메일)의 기존 이메일 계정이 있으면 그 계정에 연결합니다.

1. [Google Cloud Console](https://console.cloud.google.com/) → API 및 서비스 → **OAuth 동의 화면**에서 앱 이름·지원 이메일을 넣고 범위 `openid`·`email`·`profile`을 씁니다(테스트 단계면 테스트 사용자에 본인 계정 추가).
2. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**, 유형 **웹 애플리케이션**.
3. **승인된 리디렉션 URI**에 접속할 주소마다 추가합니다.
   - `http://localhost:3000/api/auth/google/callback` (로컬)
   - `https://dev-machine.example-tailnet.ts.net:9470/api/auth/google/callback` (Tailscale `tailscale serve` https)
   - 배포: `https://<APP_URL 호스트>/api/auth/google/callback`
4. 발급된 클라이언트 ID·보안 비밀을 `.env.local`(배포는 환경 변수)의 `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`에 넣고 서버를 다시 띄웁니다.

> Google은 `http://100.101.102.103:3000` 같은 IP 주소 리디렉션 URI를 허용하지 않습니다(localhost 제외). tailnet IP로 직접 열었다면 Google 로그인은 Tailscale https 주소(`*.ts.net`)나 localhost로 접속해서 사용하세요.

redirect URI의 origin 결정:

- PRODUCTION: 앱 주소만 씁니다(요청의 Host 헤더는 믿지 않음). 앱 주소는 `APP_URL`, 비어 있으면 Vercel 배포 주소(아래 '배포' 참고).
- DEV: `GOOGLE_REDIRECT_ORIGIN` → 앱 주소 → 요청 origin 순. 요청 origin은 `X-Forwarded-Host`·`X-Forwarded-Proto`(tailscale serve)를 따르며
  localhost·`*.ts.net`·`DEV_ALLOWED_ORIGINS` 호스트만 허용합니다. 콜백은 시작한 주소와 같은 origin으로 돌아와야 하므로 보통은 비워 두고,
  특정 주소로 고정하고 싶을 때만 `GOOGLE_REDIRECT_ORIGIN=https://dev-machine.example-tailnet.ts.net:9470`처럼 지정합니다.

회원가입은 **Google 계정으로만** 합니다(처음 Google 로그인하면 자동 가입, 이메일 가입 없음).
로그인은 Google 또는 이메일·비밀번호로 합니다. 이메일 로그인은 Google로 가입한 뒤 **설정 > 계정**(`/app/account`)에서 비밀번호를 정한 사용자만 쓸 수 있습니다(비밀번호를 바꾸면 다른 기기 세션은 해제).
`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`은 PRODUCTION 필수입니다. DEV에서 비어 있으면 시작 시 안내하고 Google 버튼을 비활성화합니다(이미 비밀번호가 있는 계정만 로그인 가능).

### 배포 모드(APP_ENV)

`APP_ENV`로 모드를 고릅니다. 비우면 `DEV`이고(단 Vercel Production 배포는 `PRODUCTION`), `DEV`·`PRODUCTION` 밖의 값이면 서버가 뜨지 않습니다.
`NODE_ENV`(빌드 종류)와는 별개라 `npm start`도 `APP_ENV`를 주지 않으면 DEV입니다.

| | DEV(기본) | PRODUCTION |
|---|---|---|
| 시작 검사 | 빠진 설정은 경고 한 번(로컬 저장소 사용·그래프 꺼짐 등) | 필수 설정이 하나라도 빠지면 누락 목록과 함께 기동 실패 |
| 세션 쿠키 | `next start`일 때만 Secure | 항상 Secure |
| 이력서 저장소 | R2 설정이 없으면 로컬 폴더 | R2만(로컬 폴백 없음) |
| CLI 엔진 | `CLI_PROVIDERS=1`이면 켬(Vercel에서는 항상 꺼짐) | `CLI_PROVIDERS_IN_PRODUCTION=1`까지 있어야 켬(Vercel에서는 항상 꺼짐) |
| same-origin 검사 | Host·X-Forwarded-Host·앱 주소 호스트 허용 | 앱 주소 호스트만 허용(Host 헤더를 믿지 않음). Vercel Preview는 그 배포 주소도 |
| 화면 | 사이드바에 노란 `DEV` 배지 | 표시 없음 |

PRODUCTION 필수 설정: `APP_URL`(https — Vercel에서는 비우면 배포 주소), `DATABASE_URL`(Turso `*.turso.io`면 `DATABASE_AUTH_TOKEN`도,
Vercel에서는 `file:` 불가), `NEO4J_URI`·`NEO4J_USER`·`NEO4J_PASSWORD`, `R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET`,
`GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`, AI 엔진 하나 이상(`ANTHROPIC_API_KEY` 또는 `CLI_PROVIDERS=1` + `CLI_PROVIDERS_IN_PRODUCTION=1` —
Vercel에서는 `ANTHROPIC_API_KEY`만).

```bash
npm run build && npm run start:prod   # APP_ENV=PRODUCTION next start
```

### 환경 변수

| 이름 | 설명 |
|---|---|
| `APP_ENV` | 배포 모드 `DEV`(기본) \| `PRODUCTION`. 위 '배포 모드' 참고 |
| `ANTHROPIC_API_KEY` | Claude API 키. 비우면 Claude API 엔진이 빠진다 |
| `ANTHROPIC_MODEL` | 기본 `claude-opus-5-5` |
| `CLI_PROVIDERS` | `1`이면 계정 로그인 엔진(Claude CLI·Codex CLI)을 켠다 |
| `CLI_PROVIDERS_IN_PRODUCTION` | `1`이면 `APP_ENV=PRODUCTION`에서도 CLI 엔진을 켠다(기본 꺼짐) |
| `CLAUDE_CLI_CONFIG_DIR` / `CODEX_CLI_HOME` | CLI 로그인 저장 폴더(기본 `./data/providers/…`). `system`이면 이 PC의 기본 로그인 사용 |
| `CLAUDE_CLI_MODEL` / `CODEX_CLI_MODEL` | CLI 엔진 모델(기본 `claude-opus-5-5` / codex 기본 모델) |
| `CLI_MAX_CONCURRENCY` | 동시에 띄우는 CLI 프로세스 수(기본 4) |
| `CLI_CALL_TIMEOUT_MS` | CLI 호출 하나의 제한 시간(기본 15분) |
| `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH` | CLI 실행 파일 경로(기본 PATH의 `claude` / `codex`) |
| `DATABASE_URL` | 로컬 `file:./data/app.db`, 배포 `libsql://…`. 비우면 Vercel Turso 연동의 `TURSO_DATABASE_URL` |
| `DATABASE_AUTH_TOKEN` | Turso 토큰. 비우면 `TURSO_AUTH_TOKEN` |
| `MIGRATE_ON_BUILD` | (Vercel Preview 전용) `1`이면 Preview 빌드에서도 마이그레이션을 적용(Preview 전용 DB일 때만) |
| `DB_MIGRATE_AT_RUNTIME` | (Vercel, 비상용) `1`이면 빌드 대신 런타임 첫 요청에 마이그레이션 적용(예전 방식) |
| `DAILY_DIAGNOSIS_LIMIT` | 사용자당 하루 진단 수(기본 5). 삭제한 진단도 센다 |
| `APP_URL` | 공개 URL. DEV는 (선택) 리버스 프록시 뒤 Origin 검사에 함께 허용, PRODUCTION은 필수(https)이고 이 호스트만 허용. Vercel에서 비우면 Production은 `https://$VERCEL_PROJECT_PRODUCTION_URL`, Preview는 `https://$VERCEL_BRANCH_URL` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google 로그인 OAuth 클라이언트. PRODUCTION 필수(가입은 Google로만) |
| `GOOGLE_REDIRECT_ORIGIN` | (선택, DEV 전용) 리디렉션 URI의 origin 고정 |
| `TRUSTED_PROXY_HOPS` | (선택, 자체 호스팅) X-Forwarded-For를 덧붙이는 우리 쪽 프록시 수. 레이트 리밋의 클라이언트 IP를 이 값으로 정한다 |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | (선택) 경력 그래프 Neo4j. URI를 비우면 그래프 기능이 꺼진다 |
| `NEO4J_DATABASE` | (선택) Neo4j 데이터베이스 이름(기본 서버 기본값) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | (선택) 이력서 본문 저장소 R2. 하나라도 비면 로컬 폴더 |
| `R2_ENDPOINT` | (선택) R2 엔드포인트 직접 지정 |
| `STORAGE_DIR` | 로컬 저장소 폴더(기본 `./data/storage`) |
| `REVIEWER_CHAT_DAILY_LIMIT` | (선택) 사용자당 24시간 심사위원 대화 메시지 수(기본 100) |
| `DIAGNOSIS_TIME_BUDGET_SEC` | (선택) 백그라운드 진단의 시간 예산(초). Vercel 기본은 `maxDuration - 30`(이보다 크게 줘도 이 값에서 멈춤), 자체 호스팅 기본은 제한 없음 |

### 명령

```bash
npm test          # vitest
# 실제 CLI 엔진으로 13단계를 끝까지 돌리는 선택 테스트(구독 사용량 사용)
LIVE_CLI=claude-cli CLI_PROVIDERS=1 CLAUDE_CLI_CONFIG_DIR=system npx vitest run src/lib/llm/cli.live.test.ts
npm run lint
npm run typecheck
npm run build && npm start        # APP_ENV 그대로(기본 DEV)
npm run build && npm run start:prod   # APP_ENV=PRODUCTION
```

## 배포 (Vercel + Turso)

저장소에 `vercel.json`이 있습니다: 함수 리전 `icn1`(서울 — Turso·Neo4j·사용자와 가깝게. DB 호출이 요청마다 여러 번 직렬로
일어나 기본 리전 `iad1`(미국 동부)이면 호출마다 150ms 이상 늘어납니다)과 빌드 명령 `npm run vercel-build`(`next build` 뒤
`scripts/migrate.mjs`로 DB 마이그레이션을 **배포당 한 번** 적용). Node는 `package.json` `engines`로 22.x에 고정합니다.

### 라이브 환경 변수 파일

`.env.production.example`이 Production에 넣을 값의 템플릿입니다. `.env.vercel.production`으로 복사해 채운 뒤
Vercel → Settings → Environment Variables → **Import .env**로 붙여넣고 범위는 **Production만** 고릅니다.
(`.env.production`·`.env.production.local` 이름은 쓰지 마세요 — 로컬 `next build`가 자동으로 읽어 PRODUCTION 검사에 걸립니다.)

### 준비 (외부 서비스)

1. **Turso DB** — `turso db create careerloop --location <서울에서 가까운 위치(예: aws-ap-northeast-1)>`,
   `turso db show careerloop --url`(→ `DATABASE_URL=libsql://…turso.io`), `turso db tokens create careerloop`(→ `DATABASE_AUTH_TOKEN`).
   Vercel Marketplace의 Turso 연동을 쓰면 `TURSO_DATABASE_URL`·`TURSO_AUTH_TOKEN`이 들어오는데, 앱은 `DATABASE_*`가 없으면 이 값을 씁니다.
2. **Neo4j Aura** — 아시아 리전 인스턴스를 만들고 `NEO4J_URI=neo4j+s://…databases.neo4j.io`, `NEO4J_USER`, `NEO4J_PASSWORD`
   (필요하면 `NEO4J_DATABASE`).
3. **Cloudflare R2** — 버킷을 만들고 그 버킷으로 제한한 '객체 읽기·쓰기' API 토큰 발급 → `R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·
   `R2_SECRET_ACCESS_KEY`·`R2_BUCKET`. Vercel 배포 폴더는 읽기 전용이라 R2 없이는 이력서 기능이 503입니다.
4. **Anthropic** — `ANTHROPIC_API_KEY`(필요하면 `ANTHROPIC_MODEL`). Vercel에는 claude·codex CLI가 없어 계정 로그인 엔진(CLI)은
   `CLI_PROVIDERS`와 무관하게 꺼지고 'AI 연결' 메뉴도 숨겨집니다.
5. **Google OAuth** — 위 'Google 로그인' 절차로 웹 클라이언트를 만들고, 승인된 리디렉션 URI에
   `https://<운영 도메인>/api/auth/google/callback`을 넣습니다(`APP_URL`을 비우면 `<프로젝트>.vercel.app` 같은 운영 기본 도메인).
   → `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`. 가입은 Google로만 되므로 빠지면 아무도 가입할 수 없습니다.

### Vercel 환경 변수

Vercel 프로젝트 → Settings → Environment Variables. 값마다 적용 환경을 고릅니다 — **운영 비밀(운영 DB·버킷·그래프)은 Production에만** 넣으세요.
기본 선택(모든 환경)으로 넣으면 Preview 배포가 운영 DB·R2·Neo4j를 그대로 씁니다.

| 변수 | Production | Preview |
|---|---|---|
| `APP_ENV` | `PRODUCTION`(비워도 Production 배포는 PRODUCTION) | 비움(DEV, 화면에 DEV 배지) 또는 `PRODUCTION` |
| `APP_URL` | `https://<운영 도메인>`(비우면 `https://$VERCEL_PROJECT_PRODUCTION_URL`) | 비움(→ `https://$VERCEL_BRANCH_URL`) 또는 고정 스테이징 도메인 |
| `DATABASE_URL` / `DATABASE_AUTH_TOKEN` | 운영 Turso DB | **별도** Turso DB(또는 Turso 브랜치) + `MIGRATE_ON_BUILD=1` |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | 운영 Aura | 별도 인스턴스(비우면 그래프 기능만 꺼짐) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | 운영 버킷 | 별도 버킷 |
| `ANTHROPIC_API_KEY` | 필수 | 필요하면(비용 주의) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | 필수 | 아래 'Preview 배포' 참고 |
| `DAILY_DIAGNOSIS_LIMIT` · `REVIEWER_CHAT_DAILY_LIMIT` · `DIAGNOSIS_TIME_BUDGET_SEC` | 선택 | 선택 |

Preview를 쓰지 않으려면 Settings → Git에서 Preview 배포를 끄는 편이 가장 간단합니다.

### 배포 순서

1. 위 '준비'와 환경 변수를 넣습니다.
2. 저장소를 Vercel에 가져옵니다(Framework: Next.js. 빌드 명령은 `vercel.json`이 정합니다).
3. 배포합니다. Vercel 빌드는 `next.config.ts`에서 런타임과 같은 필수 설정 검사를 하므로, PRODUCTION인데 빠진 값이 있으면
   **빌드가 누락 목록과 함께 실패**합니다(빌드 로그에서 확인). 런타임 시작 검사(`src/instrumentation.ts`)도 그대로 있어, 빌드 뒤에
   값을 지웠다면 함수가 시작하지 못하고 Runtime Logs에 누락 목록이 남습니다.
4. 빌드가 끝나면 `scripts/migrate.mjs`가 Production DB에 마이그레이션을 적용합니다(Preview는 `MIGRATE_ON_BUILD=1`일 때만).
   런타임은 Vercel에서 마이그레이션을 적용하지 않고 DB가 최신인지 확인만 합니다 — 새 인스턴스 여러 개가 동시에 같은 마이그레이션을
   적용하는 경쟁과, Preview 배포가 운영 DB 스키마를 먼저 바꾸는 일을 막기 위해서입니다. 빌드에서 DB에 닿지 못하는 환경이면
   `npm run db:migrate:deploy`(같은 환경 변수로)를 직접 실행하거나 `DB_MIGRATE_AT_RUNTIME=1`로 예전 방식(첫 요청 때 적용)을 씁니다.
5. 운영 도메인으로 접속해 Google 로그인 → 새 진단 → 보고서까지 확인합니다.

### Preview 배포

- `APP_ENV`를 비우면 Preview는 DEV 규칙으로 뜹니다(DEV 배지, Host 기반 Origin 검사). `APP_ENV=PRODUCTION`을 주면 앱 주소는
  `APP_URL` → `https://$VERCEL_BRANCH_URL` → `https://$VERCEL_URL` 순이고, same-origin 검사는 그 배포 주소(`VERCEL_URL`·`VERCEL_BRANCH_URL`)도 허용합니다.
- Google은 와일드카드 리디렉션 URI를 받지 않습니다. Preview에서 Google 로그인이 필요하면 스테이징 도메인을 한 브랜치에 고정해
  Google 콘솔에 `https://<스테이징 도메인>/api/auth/google/callback`을 등록하고 Preview 범위 `APP_URL`로 넣으세요. 아니면 Preview에서는
  비밀번호를 설정한 계정의 이메일 로그인만 씁니다.
- Preview의 DB·R2·Neo4j는 운영과 분리하세요(위 표). Preview가 운영 DB를 공유하면 마이그레이션이 빌드에서 건너뛰어지고, 새 마이그레이션이
  있는 브랜치는 런타임 확인에서 'DB 스키마가 이 배포보다 오래됐습니다' 오류로 멈춥니다(운영 DB를 바꾸지 않음).

### 플랜과 실행 시간(maxDuration)

- **진단은 백그라운드에서 돕니다.** `POST /api/diagnoses`는 진단 행을 만들고 즉시 `{id}`를 돌려준 뒤, Next.js `after()`로 같은 함수
  호출 안에서 13단계를 이어서 실행합니다. 진단 생성·재시도 라우트의 `maxDuration`은 **300초**(모든 플랜에서 배포 가능)이고,
  runner는 `maxDuration - 30초`(270초)에 스스로 멈춥니다. 시간 제한으로 멈춘 진단은 진행 화면이 남은 단계를 **자동으로 이어서**
  실행합니다(끝난 단계는 건너뜀, 진단당 4회, 사용자 재시도 3회와 따로 셈). 진행 화면을 닫았다면 다시 열 때 이어집니다.
- **Pro/Enterprise(fluid compute 켬)** 라면 `src/app/api/diagnoses/route.ts`, `src/app/api/diagnoses/[id]/retry/route.ts`의
  `maxDuration`을 800까지 올려 한 번에 끝낼 수 있습니다(값은 리터럴이어야 합니다). Hobby나 fluid compute를 끈 Pro는 300이 상한이라
  더 큰 값이면 배포가 거절됩니다.
- **fluid compute는 켜 두세요**(새 프로젝트 기본값, Settings → Functions). Hobby에서 fluid compute를 끄면 함수 상한이 60초로 내려가
  `maxDuration = 300`인 라우트 때문에 배포가 거절됩니다.
- 그래프 채팅(`maxDuration` 300)은 요청 시작부터 270초에, 심사위원 채팅·AI 이력서 초안(요청 안에서 대기)은 240초에 멈추고 실패를
  기록합니다. 함수가 강제로 끊긴 경우에도 진단은 하트비트가 끊긴 지 2분이면 '실패'로 바뀌고 재시도할 수 있습니다.

### 그 밖에 알아 둘 점

- 일부 단계가 실패해도 심사위원 7명과 JD 적합도가 끝났으면 부분 보고서(웹·PDF·Markdown)를 볼 수 있습니다.
- PDF 라우트는 `process.cwd()/src/lib/report/fonts`의 폰트를, 업로드 추출은 pdf.js CMap을 읽습니다(`next.config.ts`의
  `outputFileTracingIncludes`로 배포물에 포함). Node 런타임 전용입니다.
- **업로드 제한**: Vercel Functions는 요청 본문이 4.5MB를 넘으면 핸들러 전에 413으로 거절하므로, Vercel에서는 **파일당 4MB,
  파일 합계 4MB**(화면에서 미리 검사)입니다. 자체 호스팅은 요청 본문 32MB(Content-Length 없는 chunked 요청 포함), 파일당 10MB.
  공통: PDF 50쪽, DOCX 압축 해제 60MB, HWP·HWPX 압축 해제 32MB(ZIP에 적힌 크기를 믿지 않고 실제로 풀어 보며 센다).
  암호·배포용·DRM HWP와 암호 HWPX, HWP 3.x는 415로 안내합니다. 더 큰 파일은 텍스트를 붙여넣어 쓰세요.
- **요청 제한**: 비용이 드는 제한은 DB에 기록해 인스턴스 사이에 공유합니다 — 사용자당 하루 진단(`DAILY_DIAGNOSIS_LIMIT`)·재시도,
  IP당 하루 진단 20건, AI 이력서 초안 사용자당 24시간 30회, 그래프 채팅 사용자당 10분 30회, 심사위원 채팅, 공고 가져오기.
  로그인·비밀번호 변경·공유 링크·Google 로그인 시도 제한은 짧은 창의 메모리 제한이라 인스턴스마다 따로 셉니다.
  Vercel에서는 클라이언트 IP로 플랫폼이 넣는 `x-real-ip`를 씁니다. 자체 호스팅이면 리버스 프록시 뒤에 두고 `TRUSTED_PROXY_HOPS`를
  설정하세요(설정하지 않으면 X-Forwarded-For의 맨 오른쪽 값을 씁니다). 이메일 인증은 없으므로 계정 여러 개로 하루 제한을 늘리는 것은
  IP당 제한으로만 늦춥니다.
- 삭제(공고·진단·이력서·지원)는 FK cascade에 기대지 않고 자식 행을 같은 배치에서 직접 정리합니다(원격 libsql은 요청마다 새 연결이라
  `PRAGMA foreign_keys`가 보장되지 않음).
- 공고 링크 가져오기: 사설·루프백·CGNAT·링크로컬·IPv6 ULA 주소는 거절하고(DNS 결과 전부 검사, 검사한 주소로만 접속),
  리다이렉트 3회마다 다시 검사, 본문 2MB·20초 상한. 사용자당 하루 20회·동시 3건·분당 6회.
- 로컬 SQLite 파일은 서버리스 환경에서 유지되지 않으므로 배포에서는 반드시 Turso(libsql)를 쓰세요(Vercel에서 `file:` 주소면 빌드·시작 검사가 막습니다).
