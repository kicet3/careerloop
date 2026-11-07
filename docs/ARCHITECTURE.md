# CareerLoop — 설계

원본: [hiring-panel-skill](https://github.com/alexyc9381/hiring-panel-skill) (MIT, Alex Chen). Claude Code 스킬 하나(`SKILL.md`)로
동작하던 "클로드 7명이 이력서를 떨어뜨리려고 덤비는" 심사를 웹 서비스로 옮긴다. 원본에 없던 것: **JD 분석·적합도 매트릭스**,
**개선 방향성(로드맵)**, **웹 보고서 + PDF 다운로드**, 로그인·진단 이력.

## 1. 스택

- Next.js 16 App Router + TypeScript + Tailwind v4 (Node 런타임). **Next 16은 학습 데이터와 다르다** — 라우트 핸들러, `after()`,
  `cookies()`, `params`(Promise) 등은 `node_modules/next/dist/docs/`의 해당 문서를 먼저 읽고 쓴다. `middleware`는 `proxy`로 이름이 바뀌었다.
- Claude API: `@anthropic-ai/sdk` 1.x, 모델 기본 `claude-opus-5-5`(env `ANTHROPIC_MODEL`).
- DB: PostgreSQL(로컬 docker `postgres:17-alpine`, 배포 Supabase ap-northeast-2) + Prisma ORM 7.
  - 스키마 `prisma/schema.prisma`(테이블·컬럼은 `@@map`/`@map`으로 snake_case). 마이그레이션 `prisma/migrations`(baseline
    `20261106000000_init`, 모든 테이블 RLS 켬·정책 없음 — Supabase Data API 차단, 앱의 `postgres` 역할은 우회).
  - 클라이언트 `src/lib/db/client.ts`: `prisma`(지연 생성 싱글턴, globalThis 캐시) — `generator "prisma-client"` 출력
    `src/generated/prisma`(git 제외, postinstall·build에서 생성) + 드라이버 어댑터 `PrismaPg`(풀 Vercel 3 / 그 밖 10).
    Supabase Transaction pooler(6543)에서 동작한다. TLS·주소 규칙은 `src/lib/db/config.ts`, 오류 판별(P2002·P2003·P2025)과
    NUL 문자 제거는 `src/lib/db/errors.ts`, 도메인 행 타입은 `src/lib/db/types.ts`.
  - 주소: 런타임 `DATABASE_URL` → `POSTGRES_PRISMA_URL` → `POSTGRES_URL`, 마이그레이션 `DIRECT_URL` → `POSTGRES_URL_NON_POOLING` → 런타임 주소
    (`prisma.config.ts`).
  - 마이그레이션은 런타임에 적용하지 않는다. 로컬 `npm run db:migrate`(prisma migrate deploy), Vercel은 Production 빌드 끝에
    `scripts/migrate.mjs`가 한 번(Preview는 `MIGRATE_ON_BUILD=1`일 때만).
  - 동시성: Postgres는 쓰기를 한 줄로 세우지 않으므로(READ COMMITTED), 확인 후 삽입(하루 제한·버전 번호·레이트 리밋)은 트랜잭션 안
    `pg_advisory_xact_lock`으로, 낙관적 갱신은 조건부 `updateMany`의 count로, 채팅 마지막 메시지 확인은 `SELECT … FOR UPDATE`로 한다.
  - 삭제는 FK `ON DELETE CASCADE`/`SET NULL`이 자식 행을 정리한다. 텍스트·JSON은 저장 전에 NUL 문자를 지운다(Postgres는 `\0`을 못 담는다).
  - 테스트는 Docker 없이 `src/test/db.ts`(PGlite + `pglite-prisma-adapter`에 같은 마이그레이션 적용, `setPrismaForTests`)를 쓴다.
- 검증: zod 4. 테스트: vitest (`npm test`).
- PDF: `@react-pdf/renderer`(서버에서 생성), 한글 폰트 내장.

## 2. 고정 계약 (수정 금지 — 바꿔야 하면 보고만 할 것)

| 파일 | 내용 |
|---|---|
| `src/lib/domain/schemas.ts` | 단계 키, 의존 관계, 각 단계 출력 zod 스키마, 입력 스키마 |
| `src/lib/domain/reviewers.ts` | 심사위원 한국어 이름·역할·판정 라벨, `isPositiveVerdict(reviewer, verdict)` |
| `prisma/schema.prisma`, `src/lib/db/client.ts`, `src/lib/db/types.ts` | 테이블·DB 클라이언트·행 타입(`diagnoses.run_id`, 실행 원장 `diagnosis_runs` 포함) |
| `src/lib/llm/types.ts` | `LlmClient` 인터페이스 |
| `src/lib/report/types.ts` | `ReportModel` — 웹/PDF/MD 렌더러의 유일한 입력 |

## 3. 파이프라인

```
입력(이력서 텍스트, 지원 직무, JD 원문|null, 상황, 메모)
  └─ jd          JD 분석(요건 R1..Rn, 키워드). JD 없으면 직무명으로 '추정'(source=inferred)
       ├─ ats         서류 자동 필터: PASS/REJECT + 인용 근거 ≤5, 키워드 有/無, 파싱 문제
       ├─ gatekeeper  채용 담당자: INTERVIEW/NO, 첫 10초, 면접 질문, 가장 약한 줄 3개
       ├─ manager | rival | ceo | recruiter | teammate   (서로의 결과를 보지 않음)
       └─ fit         요건별 충족/부분/미충족 + 근거 인용, matchScore
  └─ synthesis   7명 결과 + fit → 중복 병합, 심각도순 문제 목록(누가 지적했는지)
       ├─ rewrite     같은 사실로 재작성, 모르는 건 [ADD: 질문]
       │    └─ rescreen  재작성본에 ats 다시 실행 → 전/후 판정
       └─ plan        개선 방향성: 포지셔닝, 우선순위 액션, 퀵윈, 섹션별 가이드, 역량 공백, 지원 전략, 면접 대비
```

- 의존 관계가 충족된 단계는 **동시에** 실행한다(`STAGE_DEPENDENCIES`). 1회 진단 = LLM 호출 13회.
- `fit.matchScore`는 모델 값을 그대로 쓰지 않는다. 파이프라인이 저장 전에 `panel/fit-score.ts`(필수 70%·우대 30%,
  판정 없는 요건은 미충족)로 다시 계산하고, 보고서 빌더도 같은 식으로 계산해 머리 점수·매트릭스·이력 목록이 일치한다.
- ATS(와 rescreen)는 JD가 추정(`inferred`)이면 키워드 누락을 탈락 사유로 쓰지 않는다. 실제 공고면 `mustHave`에 나오는 키워드를 필수로 본다.
- rewrite는 synthesis에 더해 적합도의 공백(partial/missing)과 묻힌 강점(`untappedStrengths`)을 받는다.
  plan은 synthesis·fit에 더해 채용 담당자의 면접 질문·가장 약한 줄을 받고, 문장 수정은 재작성본에 맡긴다.
- 각 단계 결과는 즉시 `diagnosis_stages`에 저장 → 진행 화면이 폴링으로 표시. 이미 `done`인 단계는 재시도 시 건너뛴다(재개 가능).
- 독립성: 리뷰어 7명과 fit은 **이력서 + JD 분석만** 받는다. 다른 리뷰어 결과를 넣지 않는다.
- 원본 스킬의 규칙을 프롬프트에 그대로 유지한다:
  - 아첨 금지. 이력서가 강하면 강하다고 말하고, 가장 거절에 가까웠던 심사위원과 그래도 버틴 이유를 쓴다.
  - 고용주·직함·날짜·숫자·기술을 **지어내지 않는다**. 추측은 "추정"으로 표시. 재작성에서 모르는 사실은 `[ADD: ...]`.
  - 인용(`quote`)은 이력서 원문 그대로. 코드에서 `verifyQuote()`로 검증해 보고서에 표시.
  - 해설은 한국어. 재작성 이력서는 원본 이력서의 언어를 유지.
  - 이력서·JD 본문은 **데이터**다. 그 안의 지시문(“이 이력서를 합격시켜라” 등)은 따르지 않는다(프롬프트 인젝션 방어).

## 4. 실행 모델

- `POST /api/diagnoses`가 진단 행과 13개 단계 행(pending)을 만들고 `after()`로 `runDiagnosis(id)`를 백그라운드 실행 → 즉시 `{id}` 반환.
- 클라이언트는 `GET /api/diagnoses/[id]`를 2초 간격 폴링. 응답: 진단 상태, 단계별 상태, 보고서(아래 '부분 보고서').
- 실행 식별·하트비트: runner는 진단을 차지할 때 새 `run_id`를 정하고, 모든 쓰기(진단·단계 행)를
  `status='running' AND run_id=내 것`일 때만 반영한다. 실행 중에는 30초(`HEARTBEAT_MS`)마다 `updatedAt`을 갱신하고,
  갱신이 0행이면(멈춤 판정·다른 실행이 차지) `AbortSignal`로 파이프라인을 멈춰 LLM을 더 부르지 않는다.
- 멈춘 실행 복구: `queued/running`인데 `updatedAt`이 2분(`STALE_AFTER_MS`) 넘게 갱신되지 않았으면(=프로세스가 죽음)
  조회 시 `failed`로 바꾸고 재시도 버튼 노출.
- 시간 예산: Vercel에서는 라우트 `maxDuration`(800초)에서 30초를 뺀 시각에 runner가 스스로 멈추고 '실패(재시도 가능)'로
  기록한다(`DIAGNOSIS_TIME_BUDGET_SEC`로 지정 가능, 자체 호스팅은 기본 없음). 재시도하면 끝난 단계는 건너뛴다.
- `POST /api/diagnoses/[id]/retry`: `failed`인 진단만, 한 트랜잭션에서 '다른 진행 중 진단 없음'을 확인하고
  `failed → queued`로 조건부 전환. 진단당 3회(`MAX_RETRIES_PER_DIAGNOSIS`)까지.
- 제한: 사용자당 동시 실행 1건, 하루 `DAILY_DIAGNOSIS_LIMIT`(기본 5)건. 하루 제한·재시도 횟수는 append-only 원장
  `diagnosis_runs`로 센다(진단을 지워도 줄지 않는다). 진행 중(queued/running)인 진단은 삭제할 수 없다(409).
  IP당 하루 20건 생성 제한(메모리)도 있다.
- 업로드: 본문은 Content-Length 유무와 관계없이 바이트를 세며 읽다가 22MB를 넘으면 413(`diagnoses/body.ts`).
  DOCX는 mammoth 전에 ZIP 항목을 실제로 풀어 보며 항목당 20MB·합계 60MB를 넘으면 413(zip bomb).
  HWP(5.x, cfb+fflate)·HWPX(ZIP)는 압축 해제 합계 32MB 초과 413(적힌 크기를 믿지 않고 실제로 풀며 센다). 암호·배포용·DRM HWP, 암호 HWPX, HWP 3.x는 415.
  PDF는 50쪽 초과 413, 페이지 사이 15초 예산, 글자 수 상한을 넘으면 더 읽지 않는다.
- 부분 보고서: `done`이면 전체 보고서. `failed`라도 jd·심사위원 7명·fit이 끝났으면 부분 보고서(빠진 섹션 안내 +
  재시도)를 웹·PDF·Markdown(소유자)으로 제공한다. 공유 링크는 `done`만.
- 가짜 심사위원(mock) 엔진은 없다. 테스트는 결정적 가짜 클라이언트(`src/test/fake-llm.ts`, 실제 이력서 줄을 인용)를 주입하고,
  앱 코드는 eslint `no-restricted-imports`로 `src/test/**`를 import하지 못한다. 로컬 확인은 Claude/ChatGPT 계정 로그인 엔진으로 한다.

## 5. LLM 호출 규칙 (src/lib/llm/anthropic.ts)

- `client.beta.messages` + 구조화 출력(`output_config.format`, zod → `betaZodOutputFormat` 또는 JSON schema). 결과는 zod로 다시 검증.
- 서버 측 거절 fallback: `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`. `stop_reason === "refusal"`이면 `LlmPermanentError`.
- 스트리밍(`.stream()` → `finalMessage()`)으로 타임아웃 회피. Opus 5.5는 thinking이 항상 켜져 있고 thinking 토큰도
  `max_tokens`에 들어가므로 단계별로 넉넉히 준다(리뷰어·jd·fit·rescreen 32k, synthesis·rewrite·plan 64k).
  `stop_reason=max_tokens`면 한도를 두 배(최대 128k)로 올려 1회 재요청, 그래도 끊기면 `LlmPermanentError("max_tokens")`
  (사용자 문구는 입력 탓을 하지 않는다). `model_context_window_exceeded`는 별도 사유 `context_window`.
- `thinking`은 생략(Opus 5.5는 adaptive 고정), `output_config.effort`를 단계별로 명시: 리뷰어 `medium`, jd/fit `medium`, synthesis/rewrite/plan `high`.
- `temperature` 등 샘플링 파라미터 금지(400).
- 재시도: 429/5xx/연결 오류는 SDK 재시도(maxRetries)에 맡기고, 스키마 검증 실패는 1회 재요청 후 `LlmPermanentError("invalid_output")`.
- 사용량: `usage.iterations`가 있으면(서버 측 fallback 등) 시도별 값을 합산한다. 실패한 호출도 그때까지의 사용량을
  오류 객체(`error.usage`)에 붙이고, runner가 진단 사용량에 더한다.
- 사용량 원장: `createLlmClient(provider, { userId, referenceId })`가 실제 엔진 클라이언트를 `UsageRecordingLlmClient`(src/lib/llm/usage.ts)로
  감싸 성공·실패한 `generate()` 1건마다 `llm_usage_events`에 1행(사용자·task/stage·엔진·모델·토큰 4종·추정 비용·성공 여부)을 남긴다.
  프롬프트·응답 본문은 저장하지 않는다. 추정 비용은 src/lib/llm/pricing.ts 단가표(USD 백만분의 1 정수, 모르는 모델·CLI 엔진은 null).
  서버 측 fallback으로 여러 모델이 나눠 쓰면 시도별 모델 단가로 매긴다(`usageByModel`). 엔진을 쓸 수 없어(CLI 꺼짐·미설치) 토큰 없이 끝난 실패는 기록하지 않는다.
  기록 실패는 로그만 남기고 기능에 영향을 주지 않는다. 탈퇴하면 CASCADE로 함께 지워진다. 관리자 화면 `/app/admin/usage`(+ `GET /api/admin/usage`).
- 프롬프트 캐싱: `system`은 모든 단계·진단이 같은 공통 규칙(`SYSTEM_PROMPT`) 하나이고 `cache_control`을 붙인다.
  user 메시지는 [공유 자료 블록(cache_control)] + [단계 역할 + 할 일 + 이전 결과] 순서다. system 캐시는 단계·진단을
  넘어 재사용된다. 자료 블록까지의 캐시는 effort와 출력 스키마가 같은 요청끼리만 맞을 수 있고, 동시에 출발한 요청은
  서로의 쓰기를 읽지 못하므로(팬아웃 8개) 단계 간 재사용은 보장하지 않는다. 실제 효과는 `diagnoses.usage.cacheReadTokens`로 확인한다.

## 5-1. 계정 로그인 엔진 (src/lib/llm/cli.ts, src/lib/providers/*) — 임시·개인용

- 엔진 id(`domain/providers.ts`): `anthropic`(API 키) · `claude-cli`(Claude 구독 로그인) · `codex-cli`(ChatGPT 로그인).
  진단 행의 `provider` 컬럼에 저장하고 재시도도 같은 엔진으로 한다. 예전 행(null)은 `anthropic`으로 본다(`legacyProvider`).
  없앤 샘플 엔진(`provider`나 `model`이 `mock`)으로 만든 예전 진단은 보기만 되고, 재시도는 409(`isRetiredEngine`). 데이터 마이그레이션은 하지 않는다.
- `CLI_PROVIDERS=1`일 때만 CLI 엔진이 보인다. 준비된 엔진이 없으면 새 진단은 409로 막는다.
- paperclip의 claude-local·codex-local 방식: 공식 CLI를 자식 프로세스로 실행한다. 토큰은 CLI가 자기 저장소에 두고 앱은 읽지 않는다.
  - 로그인 격리: `CLAUDE_CONFIG_DIR=data/providers/claude`, `CODEX_HOME=data/providers/codex`. `system`이면 기본 로그인 사용(웹 로그인·로그아웃 차단).
  - 로그인(`providers/service.ts`): Claude는 `claude auth login --claudeai` → 안내문의 인가 링크(허용 호스트·경로만) → 사용자가 받은
    코드를 웹에 붙여넣으면 자식 stdin으로 전달. ChatGPT는 `codex login --device-auth` → 기기 인증 링크 + 1회용 코드 → CLI 종료로 완료 감지.
    엔진별 1개, 15분 만료, 프로세스 전역 상태. 링크·코드는 메모리에만 두고 로그에 쓰지 않는다.
  - 상태: `claude auth status`(JSON, `authMethod=claude.ai`만 연결로 인정), `codex login status`. 30초 캐시.
  - 자식 환경은 허용 목록만 넘긴다(`providers/cli.ts` `cliEnv`): PATH·HOME·USER·LOGNAME·SHELL·LANG·LC_*·TZ·TERM·TMPDIR/TMP/TEMP, 프록시(HTTP(S)_PROXY·ALL_PROXY·NO_PROXY)·인증서(NODE_EXTRA_CA_CERTS·SSL_CERT_*),
    XDG_*, Windows 시스템 변수. 여기에 앱이 전용 홈(`CLAUDE_CONFIG_DIR`/`CODEX_HOME`)·`NO_COLOR`·`BROWSER`를 더한다. DB·Neo4j·OAuth·GitHub·R2·세션 비밀,
    `ANTHROPIC_*`/`OPENAI_*`(API 키 과금), `CLAUDE_CODE_*`(중첩 세션 표식), 부모의 `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, `NODE_OPTIONS`는 넘기지 않는다. CLI 로그인은 설정 폴더(·macOS 키체인)에 있어 환경 변수가 필요 없다.
- 호출: 프로세스마다 `mkdtemp`로 만든 0700 작업 폴더에서 실행해 프로젝트 지시 파일·심어 둔 설정을 읽지 않는다.
  자식은 새 프로세스 그룹으로 띄우고(npm 래퍼 → 실제 바이너리) 취소·시간 초과·서버 종료 때 그룹 전체를 끝낸다.
  - Claude: `claude -p --output-format json --model --effort --system-prompt --json-schema <toStrictJsonSchema> --tools "" --strict-mcp-config --setting-sources "" --no-session-persistence`, 자료는 stdin. `structured_output`을 zod로 재검증.
  - Codex: `codex exec --json --sandbox read-only --ephemeral --skip-git-repo-check --output-schema <파일> -c model_reasoning_effort -c project_doc_max_bytes=0 -`
    + 도구 기능 끔(`--disable shell_tool unified_exec code_mode_host apps plugins browser_use computer_use …`, `-c mcp_servers={}`, `-c web_search="disabled"`).
    read-only 샌드박스는 쓰기만 막고 읽기는 막지 않으므로, 이력서에 심은 지시로 서버 파일(.env·로그인 토큰)을 읽지 못하게 하는 것이 목적이다.
    응답 이벤트에 도구 사용 항목(command_execution 등)이 있으면 출력을 버리고 단계를 실패 처리한다.
    stdin = 실행 규칙 + system + user. 마지막 `agent_message`를 JSON으로 읽어 zod 재검증. effort는 low/medium/high로 맞춘다.
  - 실패 분류는 CLI 오류 채널(claude `is_error`, codex `turn.failed`/`error`)과 stderr로만 한다 — 모델이 쓴 글에 '401'·'한도'가 있어도 오판하지 않게.
    로그인 → `LlmPermanentError("auth")`, 구독 한도 → `"usage_limit"`, 미설치 → `"unavailable"`, 시간 초과 → `"timeout"`.
    과부하(429·529)·그 밖의 CLI 오류는 1회 재시도(과부하는 15초 뒤) 후 일반 오류(과부하면 status 529 → '일시적 장애' 문구).
    모델이 JSON이 아닌 글을 내면 짧은 거절 문장은 `"refusal"`, 아니면 스키마 재요청 1회.
  - 동시 CLI 프로세스 `CLI_MAX_CONCURRENCY`(기본 4), 호출당 `CLI_CALL_TIMEOUT_MS`(기본 15분). 자체 호스팅은 진단 전체 마감이 없다(§4).
- 화면: `/app/connections`(AI 연결, CLI 엔진이 켜졌을 때만 메뉴 노출), 새 진단의 'AI 엔진' 선택(준비 안 된 엔진은 사유와 함께 비활성).
  CLI 로그인은 서버의 모든 사용자가 함께 쓰므로 로그인·코드 제출·취소·연결 해제·상태 새로 확인은 관리자만 한다. 일반 사용자는 상태 배지만 보고(버튼·로그인 링크·코드 없음) 페이지 새로고침으로 최신 상태를 본다.
- API: `GET /api/providers`(선택지+연결 상태, 승인된 모든 사용자 — 진행 중인 로그인 `login`은 관리자에게만, 일반 사용자는 null),
  `GET /api/providers/[id]?fresh=1`·`POST /api/providers/[id]` `{action: login|code|cancel|logout}`(관리자만, 아니면 403 `admin_only`).

## 6. 인증

- 가입은 Google(OAuth 2.0/OIDC, state·PKCE·nonce)만. 로그인은 Google 또는 이메일+비밀번호(bcryptjs, 계정 설정에서 지정). 세션: 32바이트 랜덤 토큰 → httpOnly·SameSite=Lax·Secure(APP_ENV=PRODUCTION 또는 프로덕션 빌드) 쿠키 `rp_session`,
  DB에는 SHA-256 해시 저장, 30일 만료(15일 지나면 연장).
- `getCurrentUser()`(서버 전용) / `requireUser()`(없으면 `/login?next=` 리다이렉트) / API용 `requireApiUser()`(401 JSON).
- 모든 진단 조회·수정은 `userId` 소유권 확인. 공유 토큰(`/share/[token]`)만 비로그인 읽기 허용.
- 로그인·가입 실패 메시지는 계정 존재 여부를 드러내지 않는다. 상태 변경 요청은 same-origin(`Origin` 헤더) 확인.
- 레이트 리밋(인스턴스 메모리): 로그인은 IP당·이메일+IP당·계정당, 가입은 IP당, 진단 생성은 IP당 하루, 공개 공유
  페이지·PDF는 IP당 분당. 클라이언트 IP는 X-Forwarded-For 맨 왼쪽을 믿지 않는다 — Vercel은 `x-real-ip`,
  리버스 프록시 뒤면 `TRUSTED_PROXY_HOPS`, 그 밖은 맨 오른쪽 값(`auth/rate-limit.ts clientIp`).

## 6-1. 배포 모드 (APP_ENV, src/lib/config/env.ts)

- `appEnv()`: `APP_ENV` 비면 `DEV`, `DEV`·`PRODUCTION` 밖이면 `AppEnvError`. `isProduction()`. `NODE_ENV`와 별개.
- 시작 검사: `instrumentation.ts register()`가 마이그레이션 전에 `checkEnvOnStartup()`(`config/startup.ts`) → `validateProductionEnv()`를 부른다.
  실패하면 누락 목록을 출력하고 `process.exit(1)`(register가 던지기만 하면 Next는 포트를 연 채 모든 요청에 500을 준다). PRODUCTION이면 빠진 항목
  (`APP_URL`(https)·`DATABASE_URL`·`NEO4J_URI/USER/PASSWORD`·`R2_ACCOUNT_ID/ACCESS_KEY_ID/SECRET_ACCESS_KEY/BUCKET`·AI 엔진
  = `ANTHROPIC_API_KEY` 또는 `CLI_PROVIDERS=1`+`CLI_PROVIDERS_IN_PRODUCTION=1`)을 모두 모아 한국어 오류로 던진다. DEV는 안내를 `console.warn` 한 번. 빌드(`next build`)는 register를 부르지 않아 영향 없다.
- PRODUCTION 동작: 세션 쿠키 항상 Secure(`sessionCookieSecure`, DEV는 `NODE_ENV=production`일 때만) · 저장소는 R2만(설정 없으면
  `StorageConfigError` 503, 로컬 폴백 없음) · `cliProvidersEnabled()`는 `CLI_PROVIDERS_IN_PRODUCTION=1`까지 요구 ·
  `assertSameOrigin`은 `APP_URL` 호스트만 허용(Host·X-Forwarded-Host 무시). `next.config.ts allowedDevOrigins`는 dev 서버 전용이라 무관.
- 화면: 서버에서 `appEnv()`를 레이아웃에 내려 `EnvBadge`(`src/components/app/EnvBadge.tsx`, props `{ env }`)가 DEV일 때만 노란 배지.
- 실행: `npm run dev`(DEV), `npm run start:prod`(`APP_ENV=PRODUCTION next start`).

## 7. 라우트

| 경로 | 설명 |
|---|---|
| `/` | 랜딩: 심사위원 7명 + JD 분석 + 개선 방향성 소개, CTA |
| `/signup`, `/login` | 인증(가입은 Google만, 로그인은 Google·이메일) |
| `/app/account` | 계정 정보, 이메일 로그인용 비밀번호 설정·변경 |
| `/app` | 내 진단 이력(제목, 직무, 상태, 날짜, 7명 중 통과 수) |
| `/app/new` | 새 진단: 이력서(PDF·DOCX·HWP·HWPX·HTML·TXT·MD 업로드 또는 붙여넣기), 지원 직무(필수), JD(붙여넣기 또는 파일, 선택이지만 강력 권장), 상황, 메모 |
| `/app/connections` | (CLI_PROVIDERS=1) Claude·ChatGPT 계정 로그인 연결/해제(관리자만, 일반 사용자는 상태만) |
| `/app/d/[id]` | 진행 중이면 단계별 진행 화면, 완료되면 보고서, 실패했지만 부분 보고서가 가능하면 진행 화면(재시도) + 부분 보고서. 생성 직후 입력 경고는 URL이 아니라 sessionStorage로 넘겨 한 번 표시 |
| `/share/[token]` | 읽기 전용 공유 보고서 |
| `GET /api/auth/google` `GET /api/auth/google/callback` `POST /api/auth/login` `POST /api/auth/logout` `POST /api/account/password` | 가입은 Google OAuth만 |
| `GET/POST /api/diagnoses` | 목록 / 생성(multipart) |
| `GET/DELETE /api/diagnoses/[id]` | 상태+보고서 / 삭제 |
| `POST /api/diagnoses/[id]/retry` | 재시도 |
| `POST/DELETE /api/diagnoses/[id]/share` | 공유 링크 생성/해제 |
| `GET /api/diagnoses/[id]/pdf`, `GET /api/share/[token]/pdf` | PDF 다운로드. 렌더 결과는 메모리 캐시(내용 키)·ETag/304, 동시 요청은 한 번만 렌더. 공유 PDF에는 진단 ID를 넣지 않음 |
| `GET /api/diagnoses/[id]/markdown?file=panel\|resume` | 원본 스킬 호환 `PANEL.md` / `RESUME-IMPROVED.md` |
| `/app/graph`, `/app/resumes`, `/app/resumes/new`, `/app/resumes/[id]` | 경험 그래프(편집 + 채팅), 회사별 이력서 — §11 |
| `/api/graph/**`, `/api/diagnoses/[id]/chat/**`, `/api/resumes/**` | 경험 그래프·그래프 채팅, 심사위원 대화, 회사별 이력서 — §11 |
| `/app/postings`, `/app/postings/[id]`, `/app/applications` | 공고 보관함·공고 상세(내 경력과 대조), 지원 현황(칸반 + 결과 모아 보기) — §11-4 |
| `/api/postings/**`, `/api/applications/**`, `/api/insights`, `/api/insights/skills` | 공고·URL 가져오기·대조, 지원·단계·제출본, 인사이트·스킬 갭 — §11-4 |
| `/app/mcp`, `GET/POST /api/mcp-tokens`, `DELETE /api/mcp-tokens/[id]` | MCP 연결: 개인 접근 토큰 만들기·목록·폐기 — §11-5 |
| `POST /api/mcp` | MCP 서버(Streamable HTTP, 상태 없음, Bearer 토큰). 경험 그래프 읽기 전용 도구 6개 — §11-5 |

## 8. 보고서 구성 (웹·PDF 동일 순서)

1. 표지·요약: 제목, 지원 직무, 상황, 날짜, 헤드라인, **7명 중 N명 통과**, JD 적합도 점수, ATS 전→후
2. 심사위원 7명의 한 줄 평(판정 배지)
3. JD 분석: 포지션 요약, 필수/우대 요건, 키워드, 숨은 신호 + **적합도 매트릭스**(요건 × 충족/부분/미충족 × 근거 인용)
4. 문제점 — 심각도순(인용, 이유, 고칠 방향, 지적한 심사위원)
5. **개선 방향성**: 헤드라인, 포지셔닝, 우선순위(임팩트×노력), 오늘 할 퀵윈, 섹션별 가이드, 역량 공백·메우는 법, 지원 전략, 면접 대비
6. 개선된 이력서 + 변경 내역(전→후) + `[ADD]` 질문 + 재심사 결과
7. 심사위원별 상세
8. 고지: 언어 모델이 만든 구조화된 두 번째 의견이며 면접·합격을 보장하지 않음. 원본 스킬 크레딧.

인용 검증 실패(`verified=false`)는 "원문에서 찾지 못함" 표시. JD가 추정(`inferred`)이면 섹션 상단에 "공고 없이 직무명으로 추정한 요건" 경고.
요건의 공고 인용(`jdQuote`)은 JD 원문과, 재심사 근거 인용은 재작성본과 대조한다. 문제점 번호는 `rank` 그대로(변경 내역·
개선 방향성의 `#N`과 같다). 재심사가 여전히 탈락이면 근거·파싱 문제·연락처/날짜 검사를 함께 보여 준다.
JD 키워드 칩은 웹·PDF 모두 찾음(초록)/못 찾음(빨강)으로 표시한다(`keywordStatus`).

## 9. 파일 소유권 (병렬 작업 시 자기 영역만 수정)

| 영역 | 파일 |
|---|---|
| A. 엔진 | `src/lib/llm/anthropic.ts`, `src/lib/llm/index.ts`, `src/test/fake-llm.ts`(테스트 전용), `src/lib/panel/**` (prompts, pipeline, quotes, runner, 테스트) |
| B. 인증·데이터 접근 | `src/lib/auth/**`, `prisma/**`, `src/lib/db/**`, `src/app/(auth)/**`, `src/app/api/auth/**`, `src/proxy.ts`(필요 시) |
| C. 진단 API·수집 | `src/lib/ingest/**`, `src/lib/diagnoses/**`(조회·생성·제한·공유 서비스), `src/app/api/diagnoses/**`, `src/app/api/share/**` |
| D. 보고서 모델·웹 렌더링 | `src/lib/report/model.ts`, `src/lib/report/markdown.ts`, `src/components/report/**` |
| E. PDF | `src/lib/report/pdf.tsx`, `src/lib/report/fonts/**` |
| F. 앱 화면 | `src/app/layout.tsx`, `src/app/globals.css`, `src/app/page.tsx`, `src/app/app/**`, `src/app/share/**`, `src/components/ui/**`, `src/components/app/**` |

## 10. 모듈 간 인터페이스 (서로 이 시그니처에 맞춰 구현·호출한다)

```ts
// A. src/lib/llm/index.ts
export function createLlmClient(provider?: ProviderId): LlmClient; // 키가 없거나 없앤 엔진이면 호출 시 unavailable 오류
export function currentModelName(): string;              // 진단 행의 model 컬럼에 기록
// A. src/lib/panel/quotes.ts
export function verifyQuote(resumeText: string, quote: string): boolean; // 공백·따옴표·대소문자·글머리표 정규화 후 부분 일치
// A. src/lib/panel/runner.ts  (DB를 읽고 써서 진단 하나를 끝까지 실행. 이미 done인 단계는 건너뜀. 예외를 밖으로 던지지 않음)
export async function runDiagnosis(diagnosisId: string, opts?: { llm?: LlmClient; deadlineAt?: number; heartbeatMs?: number }): Promise<void>;
// A. src/lib/panel/pipeline.ts  (DB 무관 순수 오케스트레이션 — 테스트 대상)
export async function runPipeline(input: DiagnosisInput, deps: {
  llm: LlmClient;
  existing: Partial<StageOutputs>;                       // 이미 끝난 단계(재개용)
  onStageStart(stage: StageKey): Promise<void>;
  onStageDone<K extends StageKey>(stage: K, output: StageOutputs[K], usage: LlmUsage): Promise<void>;
  onStageFailed(stage: StageKey, error: Error): Promise<void>;   // error.usage에 실패 전까지 쓴 토큰이 있을 수 있음
  signal?: AbortSignal;                                  // 중단되면 남은 단계를 시작하지 않음
}): Promise<{ ok: boolean }>;                            // 실패 단계에 의존하는 단계는 실행하지 않음

// B. src/lib/auth/session.ts (server-only)
export async function getCurrentUser(): Promise<{ id: string; email: string; name: string | null } | null>;
export async function requireUser(nextPath?: string): Promise<{ id: string; email: string; name: string | null }>; // 없으면 redirect
export async function requireApiUser(): Promise<{ id: string; email: string; name: string | null } | Response>;    // 없으면 401 Response
export function assertSameOrigin(req: Request): Response | null;                                                   // 위반 시 403 Response
// B. prisma/migrations — prisma migrate deploy로 적용(로컬 npm run db:migrate, Vercel Production 빌드 끝). 런타임은 적용하지 않는다.

// C. src/lib/diagnoses/service.ts (server-only)
export async function getDiagnosisForUser(id: string, userId: string): Promise<{ diagnosis: Diagnosis; stages: DiagnosisStage[] } | null>;
export async function getDiagnosisByShareToken(token: string): Promise<{ diagnosis: Diagnosis; stages: DiagnosisStage[] } | null>;
export async function listDiagnoses(userId: string): Promise<DiagnosisListItem[]>;
export type DiagnosisListItem = { id: string; title: string; subtitle: string; targetRole: string; status: DiagnosisStatus;
  positiveCount: number | null; matchScore: number | null; createdAt: Date; hasJd: boolean };
// GET /api/diagnoses/[id] 응답 JSON
export type DiagnosisStatusResponse = {
  id: string; status: DiagnosisStatus; error: string | null; title: string; shareToken: string | null;
  stages: { stage: StageKey; status: StageStatus; error: string | null }[];
  report: ReportModel | null;   // done이거나, failed라도 jd·심사위원 7명·fit이 끝났으면 (Date는 ISO 문자열로 직렬화됨)
  partial: boolean;             // report가 부분 보고서이면 true
};
// C. src/lib/ingest/extract.ts
export async function extractText(file: { name: string; type: string; bytes: Uint8Array }, opts?: { maxChars?: number }): Promise<{ text: string; warnings: string[] }>;
// PDF(unpdf), DOCX(mammoth), HWP 5.x(ingest/hwp.ts), HWPX·HTML(ingest/markup.ts, HTML은 BOM→meta charset→UTF-8), TXT/MD. 10MB 제한, 텍스트 50자 미만이면 "이미지 PDF로 보임 — 텍스트를 붙여넣어 달라" 오류.
// PDF는 pdfjs-dist의 CMap(node_modules/pdfjs-dist/cmaps)을 넘겨 ToUnicode 없는 한국어 CID 글꼴(macOS 인쇄 PDF 등)도 읽는다.

// D. src/lib/report/model.ts
export function buildReportModel(diagnosis: Diagnosis, stages: DiagnosisStage[]): ReportModel; // 완료된 단계만으로도 부분 생성 가능
export function reportAvailability(status: DiagnosisStatus, stages): { show: boolean; partial: boolean; missing: string[] };
// D. src/lib/report/markdown.ts
export function renderPanelMarkdown(r: ReportModel): string; export function renderResumeMarkdown(r: ReportModel): string;
// D. src/components/report/Report.tsx  (서버/클라이언트 양쪽에서 쓸 수 있는 순수 표현 컴포넌트, 훅 없음)
export function Report(props: { report: ReportModel; actions?: React.ReactNode }): JSX.Element;
// E. src/lib/report/pdf.tsx
export async function renderReportPdf(r: ReportModel): Promise<Uint8Array>;
```

## 11. 경험 그래프·채팅·포트폴리오·이력서 (추가 기능)

공유 타입·공통 모듈 시그니처·파일 소유권은 [CONTRACTS-career.md](./CONTRACTS-career.md)를 본다. 여기서는 구조와 실행 방법만 적는다.

### 11-1. 저장소 구성

| 자료 | 저장소 | 비고 |
|---|---|---|
| 경험 그래프(노드·관계) | Neo4j (`src/lib/graph/*`) | 노드마다 `userId`, 모든 쿼리 userId 조건 + 파라미터. 라벨·관계 이름은 화이트리스트만 Cypher에 들어간다. 본인 노드는 `Person`(API에서 id `"me"`) |
| 채팅 스레드·메시지 | PostgreSQL `chat_threads`·`chat_messages` | `kind: graph \| reviewer`. 그래프 변경안은 메시지 `data`(`graph-proposal`)와 `status`(proposed→applied/dismissed/failed) |
| 경험 그래프 후속 질문 | PostgreSQL `graph_followups` | 그래프 채팅 변경안의 후속 질문과, 변경안에서 뺀 항목 중 채울 수 있는 것(문서 근거 없음·기간/팀 규모 형식)을 템플릿 질문으로 쌓는다. `project_node_id`(Neo4j, FK 없음, null=미지정), `status` open→answered/skipped. 프로젝트 대화가 하나씩 묻고(`followupId`), 답한 변경안을 적용하면 answered. 같은 것을 바꿔 묻지 않게 질문을 주제(역할·팀·기간·기술·성과·측정 기준·배운 점 등)로 비교한다: 이미 채운 항목(확인 대기 변경안 포함)·답한/건너뛴/열린 질문과 겹치는 새 질문은 쌓지 않고, 열린 중복은 목록·대화를 열 때 정리하며(`reconcileProjectFollowups` — 바꿔 쓴 중복은 skipped + `duplicate_of`, 이런 행은 "건너뛴 주제"로 세지 않는다), 답하면 같은 주제의 열린 질문도 answered. 사용자가 다시 연 질문(`reopened_at`)은 이 자동 정리로 닫지 않는다. 프로젝트당 열린 질문 10개 — `src/lib/chat/followups.ts`, `src/lib/chat/followup-topics.ts` |
| 포트폴리오 | PostgreSQL `diagnoses.portfolio_text`·`portfolio_file_name` | 원본 파일은 보관하지 않고 추출 텍스트만 |
| 회사별 이력서 메타·버전 | PostgreSQL `company_resumes`·`resume_versions` | 버전 번호는 이력서별 유일(이력서별 `pg_advisory_xact_lock` 트랜잭션에서 예약) |
| 이력서 본문(버전별 JSON) | R2 또는 로컬 폴더 (`src/lib/storage`) | 키 `users/<userId>/resumes/<resumeId>/v<n>.json`. R2 변수 네 개가 모두 있으면 R2, 아니면 `STORAGE_DIR`. 전체 키 구조·포트폴리오 원본·프로필 사진·큰 파일 직접 업로드(R2 CORS)는 docs/STORAGE.md |

테이블은 `prisma/migrations`의 baseline에 있다(예전 drizzle 0003에 해당). Neo4j 제약·인덱스는 첫 쿼리 때 `ensureGraphSchema()`가 만든다.

개발용 Neo4j 실행(루프백 7474·7687에만 연다):

```bash
docker compose --env-file .env.local -p resume-career up -d neo4j
```

`NEO4J_URI`가 없으면 `graphEnabled()`가 false → 그래프 화면은 안내, 그래프 API·그래프 출처 이력서 초안은 503. 나머지 기능은 영향 없다.

### 11-2. 기능 요약

- **경험 그래프 보기·편집** — `/app/graph`, `GET /api/graph`, `POST /api/graph/ops`(`{ ops: GraphOp[] }`, 1~60개).
  직접 편집과 채팅 변경안이 같은 `GraphOp`와 `applyGraphOps`(한 트랜잭션, 하나라도 틀리면 400 + 아무것도 안 씀)를 쓴다.
  화면은 외부 라이브러리 없는 SVG 관계도(동심원 배치) + 목록 보기 + 상세/폼. 변경이 생기면 window 이벤트 `career-graph:changed`.
- **대화로 그래프 만들기** — `/api/graph/chat/threads[/id[/messages|/retry]]`, `/api/graph/chat/messages/[id]/(apply|dismiss)`.
  메시지 전송은 202로 끝나고 답변은 `after()`에서 만든다(화면은 폴링). LLM 출력(`LlmGraphOpSchema`)을 `toGraphOps` → 기존 노드와
  중복 합치기 → `planGraphOps`로 현재 그래프 기준 검사 → `proposed` 저장. 사용자가 적용하면 `applied`로 선점한 뒤 `applyGraphOps`.
- **심사위원 7명과 대화** — 보고서 심사위원 카드의 '이 심사위원과 대화' 시트, `GET/POST /api/diagnoses/[id]/chat`,
  `GET/DELETE /api/diagnoses/[id]/chat/[threadId]`. 그 심사위원 단계가 done이면 열린다. 진단 때 받은 역할 지시문
  (`buildStagePrompt`의 역할 부분, `STAGE_TASK_HEADING` 앞)과 판정·단계 출력·이력서·JD 분석을 맥락으로 넣고, 수정안
  (`before`→`after`→이유)의 원문 인용을 검증한다. 엔진은 그 진단의 엔진을 우선. 공유 화면에는 없다.
- **포트폴리오 함께 평가** — 새 진단 4단계(선택). 파일(PDF·DOCX·HWP·HWPX·HTML·TXT·MD)과 링크·설명. `<portfolio>` 블록은 심사위원 7명과
  fit·synthesis·rewrite·plan에만 들어가고(jd·rescreen 제외), 인용 필드에는 이력서 원문만 쓰게 한다. 포트폴리오가 없으면 프롬프트는 이전과 바이트 단위로 같다.
- **회사별 이력서** — `/app/resumes`, `/app/resumes/new`, `/app/resumes/[id]`, `/api/resumes/**`. 초안 출처는 경험 그래프·진단 재작성본·빈 문서,
  양식 5종(`RESUME_TEMPLATES`), 저장마다 새 버전(다른 탭이 먼저 저장했으면 409), 버전 복원, 버전별 PDF. "이 이력서로 진단"은
  sessionStorage(`src/lib/resumes/prefill.ts`)로 새 진단 폼에 이력서·직무·JD를 채운다.

### 11-3. LLM·보안 규칙(추가 기능 공통)

- 호출은 `createLlmClient(provider).generate({ task: "graph-chat" | "reviewer-chat" | "resume-draft", ... })`. 출력 스키마는 도메인 스키마 그대로(테스트용 가짜 LLM도 그 스키마로 답한다).
- 사용자 입력·이력서·포트폴리오·그래프·대화는 `wrapData`로 감싸고(`neutralizeChat`), 시스템 프롬프트에 `INJECTION_RULE`을 넣는다. 사실을 지어내지 않고 모르는 값은 `[ADD: …]`/되묻기.
- 상태 변경 라우트는 모두 `assertSameOrigin`, 인증은 `requireApiUser`, 다른 사용자 자료는 404(그래프 연산은 400).
- 남용 방지(프로세스 메모리 기준, 느슨함): 그래프 채팅 사용자당 10분 30통·답변 대기 중 재전송 409, 심사위원 채팅 대화당 30통·24시간 100통(`REVIEWER_CHAT_DAILY_LIMIT`), AI 이력서 초안 하루 30회.

### 11-4. 공고 보관함·지원 현황·경력 대조 (2차)

시그니처·소유권은 CONTRACTS-career.md §7. 테이블(baseline 마이그레이션, 예전 drizzle 0004에 해당): `job_postings`, `posting_imports`,
`applications`, `application_events`, `diagnoses.posting_id`, `company_resumes.posting_id`. 날짜·마감은 KST 순수 함수(`src/lib/time/kst.ts`,
`src/lib/postings/deadline.ts`)로만 계산한다 — 서버(UTC)와 브라우저가 같은 답을 낸다.

- **공고 보관함** — `/app/postings`, `/app/postings/[id]`, `GET/POST /api/postings`, `GET/PATCH/DELETE /api/postings/[id]`.
  모든 쿼리에 `userId` 조건. URL은 `normalizeUrl` 키(`urlKey`, 사용자별 유일)로 중복을 막고 409 + `existingId`. `http(s)`가 아닌 주소는 저장하지 않는다.
  상세의 '이 공고로 진단'(sessionStorage prefill, `postingId`), '이 공고용 이력서'(`/app/resumes/new?postingId=`), '지원 기록 추가'
  (`/app/applications?new=1&postingId=`). `POST /api/diagnoses`·`POST /api/resumes`는 `postingId` 소유권을 확인하고(아니면 404) 비운 직무·JD를 공고 값으로 채운다.
- **URL 가져오기** — `POST /api/postings/import` → 202 `{ jobId, job }`, `GET /api/postings/import[/jobId]`(화면은 폴링).
  엔진이 없으면 작업을 만들기 전에 409. 실행은 `after()`에서 `runImport`: 조건부 UPDATE(`attempts`+1)로 한 번만 차지, 1회 180초 상한,
  5분 넘게 멈춘 작업은 조회 때 다시 실행, 3회 뒤 실패. 페이지 읽기(`fetch.ts`)는 사설·루프백·CGNAT·링크로컬·ULA를 막고(DNS 결과 전부 검사,
  검사한 주소로만 접속), 리다이렉트 3회마다 재검사, 2MB·20초. JSON-LD JobPosting을 본문 앞에 붙이고 LLM task `posting-extract`로 사실을 뽑은 뒤,
  회사·직무 근거가 본문에 없으면 실패, 마감일·시각은 근거 문구에 있을 때만 저장. 외국어(주로 영어) 공고는 근거 검증 뒤 검증된 값만
  task `posting-translate`로 한국어로 옮겨 저장한다(원문은 sourceText, `structured.translatedFrom`, translate.ts). 사용자에게는 보여도 되는 오류 문구만 남긴다.
  제한: 동시 3건, 분당 6회(메모리). 하루 횟수 제한은 없다.
- **내 경력과 대조** — 공고 상세의 `PostingMatchCard`(`GET /api/postings/[id]/match`), 그래프 화면의 `SkillGapPanel`(`GET /api/insights/skills`).
  LLM 없이 계산한다. 요구 기술은 그 공고에 연결된 진단의 JD 분석(단계 완료분) 키워드, 없거나 추정이면 공고 본문에서 사전(`src/lib/skills/dictionary.ts`)으로 뽑고
  '자격 요건'/'우대 사항' 머리글로 필수·우대를 나눈다. 그래프의 기술을 `canonicalSkill`로 맞춰 증명됨(직무·프로젝트·경험의 `USED_SKILL` + 성과)·
  보유만·없음으로 분류. 공고는 Neo4j에 쓰지 않는다. 그래프가 꺼져 있으면 503. '그래프 채팅으로 추가'는 `/app/graph?ask=…#graph-chat`
  (`GraphChatPanel initialMessage` — 입력만 채우고 보내기는 사용자가 누른다).
- **지원 현황** — `/app/applications`(`?new=1&postingId=`, `?open=<id>`), `/api/applications[?postingId=]`, `/api/applications/[id]`,
  `POST /api/applications/[id]/stage`, `GET /api/applications/[id]/submitted[/pdf]`, `GET /api/insights`. 단계 변경과 이벤트는 한 batch이고,
  단계가 읽은 값 그대로일 때만 바꾼다(동시 요청은 하나만 성공, 나머지 409). 제출본: 이력서 버전을 고르거나 처음 '지원 완료' 이후 단계로 갈 때
  그 버전 문서를 `users/<u>/applications/<id>/submitted.json`(+ `submitted-meta.json`)에 복사 — 원본 이력서를 지워도 제출본·PDF·`resumeLabel`이 남는다.
  공고 상태: 지원서를 낸 지원이 생기면 공고 `applied`(이미 `closed`면 유지), 지원 삭제·공고 연결 변경 뒤 다른 지원이 없으면 `applied`→`planned`.
  인사이트는 실제 결과만 센다: 응답률 = 과제·면접·최종 합격에 한 번이라도 도달 / 지원 완료 이후 단계에 도달(이벤트 기준), 단계 도달, 이력서 버전별,
  회사별(연결 진단의 `fit.matchScore`는 참고값), 할 일 제안(마감·일정·팔로업, KST 마감 시각 기준). 예측 표현은 쓰지 않는다. `/app`에 요약 카드.
- **사이드바** — 진단·경력·서류·지원·설정 그룹. 넓은 화면에서 바깥 칸이 행 높이만큼 늘어나 긴 페이지에서도 배경·경계선이 끝까지 이어진다.

### 11-5. MCP 연결 (외부 AI 앱에서 경험 그래프 읽기)

자세한 내용은 [MCP.md](./MCP.md)에 있다. 요약하면 다음과 같다.

- 엔드포인트는 `POST /api/mcp`다. `@modelcontextprotocol/sdk`의 `McpServer`와 `WebStandardStreamableHTTPServerTransport`를 요청마다 새로 만든다(세션 없음, JSON 응답).
- 인증은 개인 접근 토큰(`mcp_tokens`, SHA-256 해시 저장)으로 하고 쿠키는 보지 않는다. 사용자 상태와 필수 동의는 요청마다 다시 본다. 레이트 리밋은 사용자당 10분 300회(`MCP_REQUEST_LIMIT`)다.
- 도구는 `get_profile_summary`·`list_nodes`·`get_node`·`search_graph`·`get_graph_text`·`get_experience_checklist` 6개다. 본문은 순수 함수(`src/lib/mcp/graph-tools.ts`)이고 LLM을 부르지 않는다. 리소스는 `careerloop://graph/schema`·`careerloop://graph/text` 두 개다.
- OAuth(claude.ai 커넥터)는 2단계다. 테이블에 `kind`·`client_id` 자리만 있다.

### 11-6. GitHub 연동 (저장소로 프로젝트 정리)

자세한 내용은 [GITHUB.md](./GITHUB.md)에 있다. 요약하면 다음과 같다.

- 사용자별 GitHub App 사용자 토큰(Contents·Metadata 읽기)을 `github_accounts`에 AES-256-GCM 암호문으로 둔다(`src/lib/crypto/secret-box.ts`). 8시간마다 갱신 토큰으로 바꾸고, 갱신은 사용자별 advisory lock 안에서 한다.
- 고른 저장소의 메타데이터·README 앞부분·의존성 이름·본인 커밋 메시지·PR 제목만 읽어(`src/lib/github/api.ts`, 복제 없음) `github_repo_snapshots`에 저장하고 AI용 요약(`brief.ts`)을 만든다. 24시간 안에는 다시 쓴다.
- `POST /api/graph/chat/github-import` → 프로젝트 고르기·만들기 → 프로젝트 대화(focusNodeId 스레드)에 `repo-import` 메시지 → `runGraphChatReply`가 `graph-repo-import` task로 변경안(문서 가져오기와 같은 검증 사슬)과 후속 질문 5개를 만든다. 이후 그 프로젝트 대화는 `<github_repo>`를 캐시 접두사에 함께 넣는다.
- `GITHUB_APP_CLIENT_ID`·`GITHUB_APP_CLIENT_SECRET`·`GITHUB_TOKEN_ENC_KEY`가 없으면 기능이 꺼진다(API 503 `github_unavailable`, 화면 안내).
