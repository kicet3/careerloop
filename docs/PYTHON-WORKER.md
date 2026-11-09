# Python AI 워커 (FastAPI @ Mac mini) 기획

상태: 1단계 구현 중 (2026-11-09)

## 1. 목표와 범위

- **옮기는 것**: Vercel 함수 시간 상한(300초)에 걸리는 **장시간 AI 백그라운드 작업**의 실행부만 Python(FastAPI)으로 옮긴다.
- **그대로 두는 것**: 화면(Next.js), 로그인·세션, 권한 확인, 사용량 한도, 작업 행 만들기, 상태 조회 API, 일반 CRUD. 이것들은 모두 Vercel에 남는다.
- **원칙**
  - 한 번에 전환하지 않는다. 작업 종류마다 스위치(`WORKER_JOBS`)를 두고 하나씩 넘긴다.
  - 워커에 문제가 생기면 스위치를 끄는 것만으로 원래 경로인 Vercel의 `after()`로 돌아간다.
  - DB 스키마의 주인은 지금처럼 Prisma 마이그레이션이다. 워커는 같은 표를 SQL로 읽고 쓰며, 스키마를 바꾸지 않는다.
  - 다른 사용자 데이터 격리 규칙(소유자 확인, 그래프 스냅샷 소유 검증)은 Python에서도 코드로 강제한다. 프롬프트에 의존하지 않는다.

## 2. 구성

```
브라우저 ──> Vercel(Next.js)                 Mac mini
              │ 1) 권한·한도 확인, 작업 행(queued) 생성
              │ 2) POST /v1/jobs/{kind}  ─HMAC──> cbt-nginx(443) ──> careerloop-worker(FastAPI, :8090)
              │    (실패하거나 꺼져 있으면 after()로 직접 실행)          │ 3) 작업 행 lease 획득 → LLM 실행 → 결과 저장
              │ 4) 화면은 지금처럼 GET 상태 API를 폴링                      ├─ Supabase Postgres (같은 DB)
              └────────────────────────────────────────────────────────────├─ Neo4j (graph.example.com)
                                                                            ├─ R2
                                                                            └─ Anthropic API
```

- **워커**: `worker/` 폴더.
  - Python 3.12, FastAPI + uvicorn, psycopg 3(async pool), anthropic Python SDK, neo4j driver, boto3, pydantic v2, jsonschema.
  - 테스트는 pytest로 한다.
- **배포**: `deploy/worker/`.
  - Docker 이미지 하나와 compose 파일, cbt-nginx 서버 블록 예시, README를 둔다.
  - 컨테이너 `careerloop-worker`는 `127.0.0.1:8090`에 열고, `cbt_bank_default` 네트워크에 붙여 nginx가 프록시하게 한다.
- **도메인**: 사용자가 연결한다(예: `resume-api.example.com`).
  - DNS A 레코드는 Mac mini 공인 IP를 가리키게 한다.
  - Cloudflare 프록시는 끈다(DNS only). nginx 속도 제한이 클라이언트 IP 기준이라, 프록시를 켜면 모든 요청이 Cloudflare IP로 보여 서명 없는 요청만으로 Vercel 디스패치가 429로 막힐 수 있다. 꼭 켜야 하면 `nginx-worker.conf`의 real_ip 주석(Cloudflare 대역 + `CF-Connecting-IP`)을 채운다.
  - 인증서는 기존 certbot 절차를 따른다.

## 3. Vercel ↔ 워커 계약

### 3.1 디스패치 (Next.js `src/lib/worker/dispatch.ts`)

`dispatchJob(kind, payload, fallback)`의 동작은 다음과 같다.

1. `WORKER_URL`이 있고 `kind`가 `WORKER_JOBS`(쉼표 목록, `*`는 전부)에 들어 있으면 `POST {WORKER_URL}/v1/jobs/{kind}`를 보낸다. 타임아웃은 5초다.
2. 202를 받으면 끝이다.
3. 그 밖의 경우는 `after(fallback)`로 지금처럼 Vercel에서 실행한다. 여기에는 연결 실패, 5xx, 타임아웃, 스위치 꺼짐이 모두 들어간다.
   - 한 작업이 두 번 실행되지는 않는다. 양쪽 모두 작업 행의 `runId`·lease를 확인하기 때문이다.

### 3.2 인증 (HMAC, 양방향 동일 규칙)

- 헤더는 `X-Worker-Timestamp`(unix 초)와 `X-Worker-Signature`(`v1=` + hex)다.
- 서명은 `HMAC-SHA256(WORKER_SHARED_SECRET, "worker.v1." + ts + "." + method + "." + path + "." + sha256hex(body))`로 만든다.
- 허용 오차는 ±60초다. 비교는 상수 시간으로 한다. 비밀값이 32자 미만이면 워커가 시작하지 않는다.
- 페이로드에는 작업 id와 runId만 담는다. userId는 워커가 DB의 작업 행에서 다시 읽는다. 요청 본문을 믿지 않기 위해서다.

### 3.3 워커 API

| 메서드·경로 | 설명 |
|---|---|
| `GET /healthz` | 프로세스가 살아 있는지(인증 없음, 내용 없음) |
| `GET /readyz` | DB·Neo4j 연결 확인(HMAC 필요) |
| `POST /v1/jobs/{kind}` | 본문 `{id, runId}`. 같은 (kind, id, runId)가 이미 큐에 있거나 실행 중이면 그대로 202를 돌려준다(멱등). |

### 3.4 실행 보장

- 워커는 받은 작업을 자기 안의 async 큐에서 실행한다. 동시 실행 수는 `WORKER_CONCURRENCY`(기본 4)다.
  - 받아 두는 수는 실행 수 + `WORKER_QUEUE_BACKLOG`(기본 0)까지다. 빈 자리가 없으면 503을 돌려 Vercel이 바로 실행한다. 시간 상한은 작업 행의 시작 시각부터 재므로, 202를 준 뒤 큐에서 오래 기다리게 하면 Vercel fallback 없이 시간 초과로 끝난다.
  - precheck(DB 작업 행 읽기)는 2.5초 안에 끝나야 한다. 넘으면 503이다. 디스패치 타임아웃(5초)이 지나 Vercel이 직접 실행하기 시작한 뒤에 워커도 같은 작업을 받는 일을 줄인다.
- 각 작업은 TS 쪽과 **같은 조건부 UPDATE**(`WHERE id=$1 AND run_id=$2 AND status IN (...)`)로 시작한다. 그래서 Vercel 경로와 동시에 실행되는 일이 없다.
  - 작업 행이 처음부터 실행 상태라 상태만으로는 막을 수 없어서, 시작 선점 표시를 함께 적는다.
    - `resume-draft`: `stage='material'` → `'writing'` 전환과 `result.runner`
    - `portfolio-graph`: `result.claimRunId`
    - `interview-questions`: 세션 `usage.claimRunId`
    - `interview-feedback`: 답변 `usage.claimAttempt`(시도마다 바뀌는 `created_at`)
  - `resume-draft`는 워커가 선점하면(`result.runner='worker'`) Vercel 멈춤 판정이 워커 시간 상한(15분 + 60초)을 쓴다. 그 밖에는 Vercel 기준(330초) 그대로다.
- **스위퍼**가 60초마다 돈다. 켜진 종류의 작업 중 2분 넘게 아무도 집지 않은 것을 다시 집는다. 디스패치가 유실되거나, 202 뒤 워커가 재시작돼 큐에서 사라진 경우를 위한 장치다.
  - 1단계 작업 표에는 `queued` 상태가 없다. 그래서 "아직 선점되지 않음"을 기준으로 삼는다.
  - 지금은 `resume-draft`만 대상이다: `stage='material'`이고 시작 후 120~300초인 행.
  - `portfolio-graph`(270초 상한)와 면접 작업(5~6분 stale)은 남은 시간이 짧아 다시 집지 않는다. 기존 stale 규칙으로 닫히고 다시 시도로 이어 간다.
- 워커 종료(배포·재시작)로 끊긴 `running` 작업은 다음처럼 처리한다.
  - `resume-draft`는 저장한 이력서·버전을 지우고, 선점한 뒤였으면 바로 실패로 닫는다.
  - 나머지는 기존 stale 규칙대로 실패 처리된다. 화면의 다시 시도로 이어서 할 수 있다.

## 4. 공유 계약이 어긋나지 않게 하는 장치

- **출력 스키마**: zod 스키마를 `scripts/export-worker-schemas.ts`로 JSON Schema로 뽑아 `worker/app/schemas/generated/*.json`에 넣는다(zod 4 `z.toJSONSchema`).
  - 워커는 이 JSON Schema로 LLM 구조화 출력과 검증을 한다.
  - vitest 테스트가 "생성 파일이 최신인지"를 확인한다.
  - zod의 transform·refine 같은 후처리는 Python에서 같은 규칙으로 따로 옮기고 테스트한다.
- **프롬프트**: TS 테스트가 고정 입력으로 만든 system·user 문자열을 `worker/tests/fixtures/prompts/*.json`에 쓴다(`UPDATE_WORKER_FIXTURES=1`일 때만 갱신).
  - pytest는 Python이 만든 문자열이 **글자 하나까지 같은지** 확인한다.
  - TS 프롬프트를 고치고 Python을 고치지 않으면 테스트가 실패한다.
- **LLM 사용량**: `llm_usage_events`에 TS와 같은 열과 같은 단가로 기록한다(`src/lib/llm/pricing.ts`를 Python으로 옮기고, 단가표 일치를 fixture로 확인한다).

## 5. 단계

| 단계 | 작업 종류(kind) | TS 원본 | 비고 |
|---|---|---|---|
| **1** | 공통 기반 | `src/lib/llm/*`, `db`, `storage` | HMAC, 큐·lease·스위퍼, Anthropic 클라이언트(구조화 출력·캐시·사용량), 배포 파일 |
| **1** | `resume-draft` | `src/lib/resumes/draft*.ts` | 이력서 AI 초안 |
| **1** | `portfolio-graph` | `src/lib/portfolios/graph-*.ts` | 그래프 기반 포트폴리오 |
| **1** | `interview-questions`, `interview-feedback` | `src/lib/interview/*` | 면접 질문·피드백 |
| 2 | `diagnosis` | `src/lib/panel/*`, `src/lib/diagnoses/*` | 13단계 심사 파이프라인(마감 연장 이어달리기를 없앨 수 있다) |
| 3 | `resume-agent` | `src/lib/resume-agent/*` | 구역별 에이전트 v2(단계 체인·HMAC 자기 호출을 워커 안의 루프로 바꾼다) |
| 4 | `graph-chat`, `graph-qa`, `graph-import` | `src/lib/chat/*`, `src/lib/rag/*` | 격리 규칙(스냅샷 소유 검증, evidence 재조회)을 그대로 옮기고 격리 테스트 17종도 함께 옮긴다 |
| 5 | `posting-import`, `posting-capture` | `src/lib/postings/*` | Mac mini에서 Playwright(Chromium)를 쓴다. @sparticuz/chromium 제약이 없어진다 |

- 각 단계는 "구현 → 같은 입력 fixture로 TS와 결과 비교 → 운영에서 해당 kind만 켜서 확인 → 기본 켜기" 순서로 진행한다.
- 모든 단계가 끝나면 Vercel 쪽 실행부(`run*Job`)를 지워도 된다. 다만 되돌리기 경로로 남겨 두는 것을 기본으로 한다.

## 6. 환경 변수

**Vercel(Next.js)**

| 이름 | 값 | 설명 |
|---|---|---|
| `WORKER_URL` | `https://<연결한 도메인>` | 워커 주소. 없으면 모든 작업을 Vercel에서 실행한다 |
| `WORKER_SHARED_SECRET` | `openssl rand -hex 32` | 워커와 같은 값 |
| `WORKER_JOBS` | `resume-draft,portfolio-graph,interview` 또는 `*` | 워커로 보낼 작업 종류 |

**Mac mini (`deploy/worker/.env`, git 제외)**

| 이름 | 값 |
|---|---|
| `WORKER_SHARED_SECRET` | Vercel과 같은 값 |
| `DATABASE_URL` | Supabase 연결 문자열. 세션 풀러(5432) 또는 direct를 쓰고 `sslmode=require`를 붙인다 |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`(선택) | Vercel과 같은 값 |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | 그래프 연결 정보. 같은 Mac mini라도 TLS 이름이 맞도록 `bolt+s://graph.example.com:7697`을 쓴다 |
| `R2_*` | Vercel과 같은 이름과 값 |
| `APP_ENV` | `PRODUCTION` |
| `WORKER_CONCURRENCY` | 기본 `4` |
| `WORKER_QUEUE_BACKLOG` | 기본 `0`(빈 자리가 없으면 503 → Vercel이 실행) |

## 7. 보안

- 워커 공개 경로는 `/healthz` 하나뿐이다. 나머지는 모두 HMAC으로 보호한다. nginx에서 본문 크기 상한 64KB와 요청 속도 제한을 둔다.
- 워커는 사용자 세션을 받지 않는다. 사용자 판단은 모두 DB의 작업 행에서 한다(`user_id`).
- 비밀값은 `.env`(권한 600)에만 둔다. 컨테이너는 root가 아닌 사용자로 실행한다.
- 로그에는 이력서 본문, JD 본문, 프롬프트를 남기지 않는다. 작업 id, kind, 걸린 시간, 토큰 수만 남긴다.
- 개인정보 처리방침: 처리 위치가 "Vercel(미국)"에서 "운영자 서버(Mac mini, 한국)"로 일부 바뀐다. 처리 위탁·국외 이전 항목을 손봐야 하는지는 1단계를 운영에서 켜기 전에 확인한다.
