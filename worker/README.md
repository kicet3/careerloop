# CareerLoop AI 워커 (개발 안내)

Vercel 함수 시간 상한에 걸리는 장시간 AI 작업을 실행하는 FastAPI 앱입니다. 설계는 `docs/PYTHON-WORKER.md`, 배포는 `deploy/worker/README.md`.

## 실행·테스트

```sh
cd worker
uv sync
uv run pytest -q
WORKER_SHARED_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgresql://... uv run uvicorn app.main:create_app --factory --port 8090
```

Next.js 쪽에서 로컬 워커를 쓰려면 `.env.local`에 `WORKER_URL=http://127.0.0.1:8090`, 같은 `WORKER_SHARED_SECRET`, `WORKER_JOBS=<kind>`를 넣습니다(평문 http는 localhost만 허용).

## 구조

| 경로 | 내용 |
|---|---|
| `app/main.py` | 앱 팩토리, `/healthz`·`/readyz`·`POST /v1/jobs/{kind}` |
| `app/config.py` | 설정(pydantic-settings). 비밀값 32자 미만이면 시작하지 않음 |
| `app/security/signing.py` | HMAC 서명·검증(TS `src/lib/worker/sign.ts`와 같은 규칙) |
| `app/jobs/` | 작업 계약(`base.py`), 등록부(`registry.py`), 큐(`queue.py`), 스위퍼(`sweeper.py`) |
| `app/llm/` | Anthropic 클라이언트·사용량 기록·단가(TS `src/lib/llm/*` 포팅) |
| `app/graph/` | 경험 그래프 읽기·텍스트·소유자 확인(TS `src/lib/graph/*` 포팅) |
| `app/db.py`, `app/storage.py` | Postgres 풀, R2 |
| `app/schemas/generated/` | TS에서 생성한 출력 JSON Schema·그래프 도메인 표(손으로 고치지 않음) |
| `tests/fixtures/` | TS에서 생성한 공유 fixture(HMAC 벡터·단가·strict 스키마·그래프 텍스트) |

## 작업 종류 추가

1. `app/jobs/<kind>.py`에 `run(ctx, job_id, run_id)`와 `KIND = JobKind(name="<kind>", run=run, precheck=table_precheck("<표>", (<실행할 수 있는 상태>,)), sweep_query=...)`를 둡니다.
2. `app/jobs/registry.py`의 `registered_kinds()` 목록에 `<module>.KIND,` 한 줄을 더합니다.
3. 규칙: user_id·provider·입력은 DB 작업 행에서만 읽고(요청 본문 금지), TS와 같은 조건부 UPDATE로 시작·기록하며, 그래프는 `assert_graph_owner`, 저장소 키는 `assert_user_key`로 확인합니다. LLM은 `ctx.llm.create(row.provider, LlmUsageContext(user_id=row.user_id, reference_id=job_id))`.

## TS와 맞추기

zod 스키마·단가·서명·그래프 텍스트 규칙을 TS에서 고쳤으면 저장소 루트에서 다시 만들고 양쪽 테스트를 돌립니다.

```sh
npx tsx scripts/export-worker-schemas.ts      # 또는 UPDATE_WORKER_FIXTURES=1 npx vitest run src/lib/worker/fixtures.test.ts
npx vitest run src/lib/worker
cd worker && uv run pytest -q
```
