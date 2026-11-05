# 이력서 심사위원단 (Resume Panel)

이력서를 올리면 AI 심사위원 7명(서류 자동 필터, 채용 담당자, 현업 매니저, 경쟁 지원자, 대표, 헤드헌터, 동료)이
각자 떨어뜨릴 이유를 찾고, 그 결과를 하나의 보고서로 묶어 주는 웹 서비스입니다.

- **JD 분석·적합도 매트릭스**: 채용 공고(JD)를 붙여넣거나 파일로 올리면 필수/우대 요건과 키워드를 뽑고,
  요건마다 이력서 근거를 인용해 충족·부분·미충족을 표시합니다. JD가 없으면 직무명으로 요건을 *추정*하고 보고서에 경고를 띄웁니다.
- **문제점 목록**(심각도순, 지적한 심사위원 표시), **개선 방향성**(포지셔닝·우선순위·퀵윈·역량 공백·지원 전략·면접 대비)
- **개선된 이력서**: 같은 사실로 재작성하고, 모르는 내용은 지어내지 않고 `[ADD: 질문]`으로 남깁니다. 재작성본을 서류 필터에 다시 돌려 전/후 판정을 보여 줍니다.
- 웹 보고서, **PDF 다운로드**(한글 폰트 내장), 원본 스킬 호환 Markdown(`PANEL.md`, `RESUME-IMPROVED.md`), 읽기 전용 공유 링크
- 이메일·비밀번호 로그인, 진단 이력
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

### 배포 모드(APP_ENV)

`APP_ENV`로 모드를 고릅니다. 비우면 `DEV`이고, `DEV`·`PRODUCTION` 밖의 값이면 서버가 뜨지 않습니다.
`NODE_ENV`(빌드 종류)와는 별개라 `npm start`도 `APP_ENV`를 주지 않으면 DEV입니다.

| | DEV(기본) | PRODUCTION |
|---|---|---|
| 시작 검사 | 빠진 설정은 경고 한 번(로컬 저장소 사용·그래프 꺼짐 등) | 필수 설정이 하나라도 빠지면 누락 목록과 함께 기동 실패 |
| 세션 쿠키 | `next start`일 때만 Secure | 항상 Secure |
| 이력서 저장소 | R2 설정이 없으면 로컬 폴더 | R2만(로컬 폴백 없음) |
| CLI 엔진 | `CLI_PROVIDERS=1`이면 켬 | `CLI_PROVIDERS_IN_PRODUCTION=1`까지 있어야 켬 |
| same-origin 검사 | Host·X-Forwarded-Host·APP_URL 호스트 허용 | `APP_URL` 호스트만 허용(Host 헤더를 믿지 않음) |
| 화면 | 사이드바에 노란 `DEV` 배지 | 표시 없음 |

PRODUCTION 필수 설정: `APP_URL`(https), `DATABASE_URL`, `NEO4J_URI`·`NEO4J_USER`·`NEO4J_PASSWORD`,
`R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET`, AI 엔진 하나 이상(`ANTHROPIC_API_KEY` 또는
`CLI_PROVIDERS=1` + `CLI_PROVIDERS_IN_PRODUCTION=1`).

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
| `DATABASE_URL` | 로컬 `file:./data/app.db`, 배포 `libsql://…` |
| `DATABASE_AUTH_TOKEN` | Turso 토큰 |
| `DAILY_DIAGNOSIS_LIMIT` | 사용자당 하루 진단 수(기본 5). 삭제한 진단도 센다 |
| `APP_URL` | 공개 URL. DEV는 (선택) 리버스 프록시 뒤 Origin 검사에 함께 허용, PRODUCTION은 필수(https)이고 이 호스트만 허용 |
| `TRUSTED_PROXY_HOPS` | (선택, 자체 호스팅) X-Forwarded-For를 덧붙이는 우리 쪽 프록시 수. 레이트 리밋의 클라이언트 IP를 이 값으로 정한다 |
| `NEO4J_URI` / `NEO4J_USER` / `NEO4J_PASSWORD` | (선택) 경력 그래프 Neo4j. URI를 비우면 그래프 기능이 꺼진다 |
| `NEO4J_DATABASE` | (선택) Neo4j 데이터베이스 이름(기본 서버 기본값) |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | (선택) 이력서 본문 저장소 R2. 하나라도 비면 로컬 폴더 |
| `R2_ENDPOINT` | (선택) R2 엔드포인트 직접 지정 |
| `STORAGE_DIR` | 로컬 저장소 폴더(기본 `./data/storage`) |
| `REVIEWER_CHAT_DAILY_LIMIT` | (선택) 사용자당 24시간 심사위원 대화 메시지 수(기본 100) |
| `DIAGNOSIS_TIME_BUDGET_SEC` | (선택) 백그라운드 진단의 시간 예산(초). Vercel 기본은 `maxDuration - 30`, 자체 호스팅 기본은 제한 없음 |

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

1. `APP_ENV=PRODUCTION`과 `APP_URL=https://<배포 주소>`를 Vercel 환경 변수에 넣습니다. 비우면 DEV로 떠서 필수 설정 검사가
   경고로만 끝나고, same-origin 검사가 Host 헤더를 믿으며, 화면에 DEV 배지가 보입니다.
2. Turso DB를 만들고 `DATABASE_URL=libsql://<db>.turso.io`, `DATABASE_AUTH_TOKEN`을 넣습니다.
   테이블은 첫 요청 때 자동으로 만들어집니다(`./drizzle` 폴더가 배포물에 포함되도록 `next.config.ts`에 설정되어 있습니다).
3. 이력서 저장소 R2 네 값(`R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET`)을 넣습니다(위 'R2' 절차).
   Vercel은 배포 폴더가 읽기 전용이라 로컬 저장소를 쓸 수 없습니다 — R2가 없으면 이력서 기능이 503을 돌려줍니다.
4. 경력 그래프 Neo4j(`NEO4J_URI`·`NEO4J_USER`·`NEO4J_PASSWORD`, 필요하면 `NEO4J_DATABASE`)를 넣습니다. 서버리스에서 닿는 관리형
   Neo4j(예: Neo4j Aura의 `neo4j+s://…`)를 씁니다.
5. `ANTHROPIC_API_KEY`(필요하면 `ANTHROPIC_MODEL`, `DAILY_DIAGNOSIS_LIMIT`, `REVIEWER_CHAT_DAILY_LIMIT`)를 넣습니다.
6. 배포합니다. `APP_ENV=PRODUCTION`에서 1~5 중 하나라도 빠지면 서버가 누락 목록과 함께 뜨지 않습니다(배포 로그에서 확인).

알아 둘 점:

- **진단은 백그라운드에서 돕니다.** `POST /api/diagnoses`는 진단 행을 만들고 즉시 `{id}`를 돌려준 뒤,
  Next.js `after()`로 같은 함수 호출 안에서 13단계를 이어서 실행합니다. 그래서 이 라우트(와 재시도 라우트)의
  `maxDuration`이 진단 전체 시간보다 길어야 합니다. 현재 **800초**(Vercel Pro/Enterprise의 최대값)입니다.
  **Hobby 플랜은 300초까지만 허용되므로** `src/app/api/diagnoses/route.ts`, `src/app/api/diagnoses/[id]/retry/route.ts`의
  `maxDuration`을 300으로 낮춰야 배포됩니다(값은 리터럴이어야 합니다).
  Vercel에서는 runner가 `maxDuration - 30초`에 스스로 멈추고 '실패(재시도 가능)'로 기록합니다. 함수가 강제로 끊긴 경우에도
  하트비트가 끊긴 지 2분이면 '실패'로 바뀝니다. 재시도하면 끝난 단계는 건너뛰고 이어서 실행합니다(진단당 3회).
- 일부 단계가 실패해도 심사위원 7명과 JD 적합도가 끝났으면 부분 보고서(웹·PDF·Markdown)를 볼 수 있습니다.
- PDF 라우트는 `process.cwd()/src/lib/report/fonts`의 폰트를 읽습니다(추적 포함 설정 완료). Node 런타임 전용입니다.
- 로그인·가입·진단 생성(IP당)·공유 링크 요청 제한은 서버 인스턴스 메모리에 있어 인스턴스마다 따로 셉니다.
  자체 호스팅이면 리버스 프록시 뒤에 두고 `TRUSTED_PROXY_HOPS`를 설정하세요(설정하지 않으면 X-Forwarded-For의
  맨 오른쪽 값을 씁니다). 이메일 인증은 없으므로 계정 여러 개로 하루 제한을 늘리는 것은 IP당 제한으로만 늦춥니다.
- 업로드 제한: 요청 본문 22MB(Content-Length 없는 chunked 요청 포함), 파일당 10MB, PDF 50쪽, DOCX 압축 해제 60MB,
  HWP·HWPX 압축 해제 32MB(ZIP에 적힌 크기를 믿지 않고 실제로 풀어 보며 센다). 암호·배포용·DRM HWP와 암호 HWPX, HWP 3.x는 415로 안내합니다.
- 공고 링크 가져오기: 사설·루프백·CGNAT·링크로컬·IPv6 ULA 주소는 거절하고(DNS 결과 전부 검사, 검사한 주소로만 접속),
  리다이렉트 3회마다 다시 검사, 본문 2MB·20초 상한. 사용자당 하루 20회·동시 3건·분당 6회.
- 로컬 SQLite 파일은 서버리스 환경에서 유지되지 않으므로 배포에서는 반드시 Turso(libsql)를 쓰세요.
