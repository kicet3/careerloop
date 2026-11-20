# 에이전트 실행기 (Next.js @ Mac mini)

에이전트 이력서 작성(단계 실행, 작업당 8~15분)을 Vercel 함수 대신 맥미니에서 실행한다. Vercel 사용량(함수 실행 시간)을 줄이는 것이 목적이다.
Python 워커(`deploy/worker`)로 옮기지 않고 **같은 Next.js 앱을 맥미니에서 `next start`로 띄워** 에이전트 코드(`src/lib/resume-agent`)를 그대로 쓴다.
프롬프트·스키마·단계 계획이 한 벌이라 두 구현을 맞출 일이 없다.

```
브라우저 ──> Vercel(Next.js)                                   Mac mini
              │ 1) 권한·동시 작업 확인, 작업 행(waiting) 생성
              │ 2) POST /api/internal/resume-agent/advance ─HMAC─> cbt-nginx(443) ──> careerloop-agent(next start, :3000)
              │    (202가 아니면 지금처럼 Vercel after()로 직접 실행)        │ 3) 리스 획득 → 단계 실행(한 호출 20분) → DB에 저장
              │ 4) 화면은 지금처럼 GET 상태 API를 폴링                        ├─ Supabase Postgres(같은 DB)
              └───────────────────────────────────────────────────────────────├─ Neo4j(careerloop-graph)
                                                                              └─ Anthropic API
                                                     5) 10초마다 주기 점검: 이어 줄 호출이 없는 작업을 DB에서 찾아 실행
```

- **결과 전달은 DB다.** 실행기가 작업 행·단계 행·이력서를 같은 Postgres에 쓰고, 화면은 Vercel의 상태 API를 폴링한다. webhook 회신·Redis는 쓰지 않는다
  (작업 행이 큐이고 리스가 중복 실행을 막는다. Vercel 함수는 구독을 유지할 수 없어 pub/sub의 받는 쪽이 될 수 없다).
- **깨우기는 서명 호출**(`RESUME_AGENT_CHAIN_SECRET`의 HMAC, 2분 만료 — `src/lib/resume-agent/chain.ts`). 본문은 작업 id·runId뿐이고 userId는 실행기가 DB에서 읽는다.
- **놓쳐도 이어진다.** 실행기는 10초마다 `sweepRunnerJobs`로 "대기 중 + 리스 없음(10초 이상)" 또는 "리스 만료" 작업을 찾아 실행한다
  (`src/lib/resume-agent/runner-loop.ts`, `RESUME_AGENT_RUNNER=1`일 때 `src/instrumentation.ts`가 켠다). 서명 호출이 닿지 않았거나 실행기를 재시작해도 화면 없이 이어진다.
- **실행기가 꺼져 있으면** Vercel이 5초 안에 202를 못 받고 지금처럼 직접 실행한다(다음 호출도 실행기 → 안 받으면 Vercel 자기 호출 순서로 이어 간다).
  이때 Vercel 로그에 `실행기 넘기기 실패(<사유>)`가 남고 작업 행 `chain_error`에 `handoff:<사유>`가 적힌다. 실행기가 살아나면 다음 호출부터 실행기가 받는다.

## 환경 변수

| 어디 | 변수 | 값 |
|---|---|---|
| Vercel | `RESUME_AGENT_CHAIN_SECRET` | 32자 이상(`openssl rand -hex 32`). 실행기와 같은 값 |
| Vercel | `RESUME_AGENT_RUNNER_URL` | 실행기 주소(https만). 예: `https://WORKER_DOMAIN`. 비우면 Vercel에서 실행(끄는 스위치) |
| 실행기 | `RESUME_AGENT_CHAIN_SECRET` | Vercel과 같은 값 |
| 실행기 | `RESUME_AGENT_RUNNER=1`, `APP_ORIGIN=http://127.0.0.1:3000` | compose가 넣는다 |
| 실행기 | 그 밖 | Vercel Production과 같은 값(`.env.example`). `VERCEL*` 변수는 넣지 않는다 |
| 실행기 | `RESUME_AGENT_RUNNER_CONCURRENCY` | (선택) 주기 점검이 동시에 실행하는 작업 수, 기본 3(서명 호출로 바로 받은 작업은 따로 센다) |

## 띄우기

```sh
cd deploy/agent
cp .env.example .env && chmod 600 .env   # 값 채우기
docker compose -p careerloop-agent up -d --build
docker compose -p careerloop-agent ps      # healthy 확인
docker logs careerloop-agent | grep agent-runner   # "주기 점검을 시작했습니다"
```

1. cbt-nginx에 `nginx-agent.conf`의 `map`·`upstream`(http 블록)과 `location`(워커 서버 블록)을 넣고 `docker exec cbt-nginx nginx -t && docker exec cbt-nginx nginx -s reload`.
2. 확인: `curl -s -o /dev/null -w '%{http_code}\n' -X POST https://WORKER_DOMAIN/api/internal/resume-agent/advance` → `401`(서명 없음).
3. Vercel Production에 `RESUME_AGENT_CHAIN_SECRET`·`RESUME_AGENT_RUNNER_URL`을 넣고 재배포한다.
4. 에이전트 작성을 하나 시작하고 `docker logs -f careerloop-agent`와 진행 화면으로 확인한다.

## 운영

- **앱을 배포할 때 실행기도 다시 빌드한다**(`docker compose -p careerloop-agent up -d --build`). 실행기 빌드가 오래돼 단계 출력 스키마 버전
  (`AGENT_SCHEMA_VERSION`)이 Vercel보다 낮으면 실행기는 새 작업을 받지 않고(409) Vercel이 실행한다 — 다시 빌드할 때까지 Vercel 사용량이 든다.
  버전이 같아도 프롬프트·단계 코드는 실행기 빌드의 것이 쓰이므로 배포 뒤 바로 다시 빌드한다.
- **시계**: 서명(±60초 허용)과 리스(60초)가 두 서버의 시계를 쓴다. 맥미니·Docker VM 시계가 1분 이상 어긋나면 넘기기가 401이 되거나 실행 중인
  작업이 멈춘 것으로 판정된다. 맥이 잠들지 않게 하고, 넘기기 실패 사유가 `runner_status_401`이면 비밀값 다음으로 시계를 확인한다(`docker exec careerloop-agent date -u`).
- DB 마이그레이션은 지금처럼 Vercel 빌드가 적용한다. 실행기는 스키마를 바꾸지 않는다.
- 끄기: Vercel에서 `RESUME_AGENT_RUNNER_URL`을 지우고 재배포하면 Vercel에서 실행한다. 실행기 컨테이너가 떠 있는 동안에는 주기 점검이
  대기 작업을 계속 주워 가므로, 완전히 되돌리려면 컨테이너도 내린다(`docker compose -p careerloop-agent down`).
- 실행기를 멈추면 실행 중이던 단계는 끊기고 리스가 60초 뒤 만료된다. 다시 띄우면 주기 점검이 그 단계부터 이어 간다(끝난 단계는 건너뜀).
- 밖으로 여는 경로는 `/api/internal/resume-agent/advance` 하나다. 화면·로그인·다른 API는 nginx가 프록시하지 않는다.
