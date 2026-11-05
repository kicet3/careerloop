# 이력서 심사위원단 (Resume Panel)

이력서를 올리면 AI 심사위원 7명(서류 자동 필터, 채용 담당자, 현업 매니저, 경쟁 지원자, 대표, 헤드헌터, 동료)이
각자 떨어뜨릴 이유를 찾고, 그 결과를 하나의 보고서로 묶어 주는 웹 서비스입니다.

- **JD 분석·적합도 매트릭스**: 채용 공고(JD)를 붙여넣거나 파일로 올리면 필수/우대 요건과 키워드를 뽑고,
  요건마다 이력서 근거를 인용해 충족·부분·미충족을 표시합니다. JD가 없으면 직무명으로 요건을 *추정*하고 보고서에 경고를 띄웁니다.
- **문제점 목록**(심각도순, 지적한 심사위원 표시), **개선 방향성**(포지셔닝·우선순위·퀵윈·역량 공백·지원 전략·면접 대비)
- **개선된 이력서**: 같은 사실로 재작성하고, 모르는 내용은 지어내지 않고 `[ADD: 질문]`으로 남깁니다. 재작성본을 서류 필터에 다시 돌려 전/후 판정을 보여 줍니다.
- 웹 보고서, **PDF 다운로드**(한글 폰트 내장), 원본 스킬 호환 Markdown(`PANEL.md`, `RESUME-IMPROVED.md`), 읽기 전용 공유 링크
- 이메일·비밀번호 로그인, 진단 이력

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
- **키 없이 화면을 확인할 수 있습니다(개발용).** `LLM_MOCK=1`이면 가짜 심사위원(mock)이 실제 이력서 줄을 인용한
  결정적 결과를 만듭니다. 화면·PDF·공유 흐름을 확인할 때 쓰세요. `MOCK_DELAY_MS`로 단계당 지연을 조절합니다.
- 실제 진단은 `ANTHROPIC_API_KEY`를 넣으면 됩니다. 기본 모델은 `claude-opus-5-5`(`ANTHROPIC_MODEL`로 변경), 진단 1회에 LLM 호출 13회입니다.

### 계정 로그인으로 쓰기 (임시·개인용)

API 키 없이 **Claude 구독 계정**(Pro·Max)이나 **ChatGPT 계정**으로 진단을 돌릴 수 있습니다.
[paperclip](https://github.com/paperclipai/paperclip)의 `claude-local`·`codex-local` 어댑터처럼, 서버 PC에 설치된 공식 CLI에
로그인시키고 그 CLI(`claude -p`, `codex exec`)로 모델을 호출합니다.

1. 서버 PC에 [Claude Code](https://docs.claude.com/en/docs/claude-code)(`claude`)나 [Codex CLI](https://github.com/openai/codex)(`codex`)를 설치합니다.
2. `.env.local`에 `CLI_PROVIDERS=1`을 넣고 서버를 다시 시작합니다.
3. 상단 메뉴 **AI 연결**에서 로그인합니다.
   - Claude: [로그인 링크 열기] → 브라우저에서 승인 → 표시된 코드를 화면에 붙여넣기
   - ChatGPT: [인증 페이지 열기] → 화면의 1회용 코드 입력(ChatGPT 보안 설정에서 기기 코드 인증을 허용해야 할 수 있음)
4. 새 진단의 **AI 엔진**에서 연결한 계정을 고릅니다. 재시도도 같은 엔진으로 돌아갑니다.

로그인 정보는 CLI가 앱 전용 폴더(`data/providers/claude`, `data/providers/codex` — git 제외)에 저장하므로, 이 PC의 개인
Claude Code·Codex 로그인과 섞이지 않고 웹에서 연결 해제해도 개인 로그인은 그대로입니다. 이미 로그인된 개인 CLI를 그대로 쓰려면
`CLAUDE_CLI_CONFIG_DIR=system`·`CODEX_CLI_HOME=system`으로 두세요(이때는 웹에서 로그인·로그아웃할 수 없습니다).

> 주의: 연결한 계정의 구독 사용량이 쓰이고, 이 서버에 가입한 모든 사용자가 그 계정으로 진단하게 됩니다. 본인 PC에서 혼자 쓸 때만
> 켜 두세요. 구독 계정을 다른 사람에게 서비스로 제공하는 것은 Anthropic·OpenAI 약관에 어긋날 수 있습니다. Vercel 같은 서버리스
> 배포에서는 CLI가 없어 동작하지 않습니다.

### Tailscale로 다른 기기에서 접속

`npm run dev`는 모든 인터페이스(:3000)에서 받으므로 tailnet 기기에서 바로 열 수 있다.

- HTTPS(권장, tailnet 전용): `tailscale serve --bg --https=9470 http://127.0.0.1:3000` → `https://<기기>.<tailnet>.ts.net:9470` (끄기: `tailscale serve --https=9470 off`)
- 직접: `http://<tailnet IP>:3000` — 이 경우 `.env.local`의 `DEV_ALLOWED_ORIGINS`에 그 IP를 넣는다(`*.ts.net`은 기본 허용).

계정 로그인 엔진(CLI_PROVIDERS)을 켠 채 열면 tailnet에서 가입한 모든 사용자가 그 구독 계정으로 진단한다.

### 환경 변수

| 이름 | 설명 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API 키. 비우면 Claude API 엔진이 빠진다(mock으로 바뀌지 않음) |
| `ANTHROPIC_MODEL` | 기본 `claude-opus-5-5` |
| `LLM_MOCK` | `1`이면 키가 있어도 mock |
| `MOCK_DELAY_MS` | mock 단계당 지연(ms) |
| `CLI_PROVIDERS` | `1`이면 계정 로그인 엔진(Claude CLI·Codex CLI)을 켠다 |
| `CLAUDE_CLI_CONFIG_DIR` / `CODEX_CLI_HOME` | CLI 로그인 저장 폴더(기본 `./data/providers/…`). `system`이면 이 PC의 기본 로그인 사용 |
| `CLAUDE_CLI_MODEL` / `CODEX_CLI_MODEL` | CLI 엔진 모델(기본 `claude-opus-5-5` / codex 기본 모델) |
| `CLI_MAX_CONCURRENCY` | 동시에 띄우는 CLI 프로세스 수(기본 4) |
| `CLI_CALL_TIMEOUT_MS` | CLI 호출 하나의 제한 시간(기본 15분) |
| `CLAUDE_CLI_PATH` / `CODEX_CLI_PATH` | CLI 실행 파일 경로(기본 PATH의 `claude` / `codex`) |
| `DATABASE_URL` | 로컬 `file:./data/app.db`, 배포 `libsql://…` |
| `DATABASE_AUTH_TOKEN` | Turso 토큰 |
| `DAILY_DIAGNOSIS_LIMIT` | 사용자당 하루 진단 수(기본 5). 삭제한 진단도 센다 |
| `APP_URL` | (선택) 리버스 프록시 뒤에서 Origin 검사에 쓸 공개 URL |
| `TRUSTED_PROXY_HOPS` | (선택, 자체 호스팅) X-Forwarded-For를 덧붙이는 우리 쪽 프록시 수. 레이트 리밋의 클라이언트 IP를 이 값으로 정한다 |
| `DIAGNOSIS_TIME_BUDGET_SEC` | (선택) 백그라운드 진단의 시간 예산(초). Vercel 기본은 `maxDuration - 30`, 자체 호스팅 기본은 제한 없음 |

### 명령

```bash
npm test          # vitest
# 실제 CLI 엔진으로 13단계를 끝까지 돌리는 선택 테스트(구독 사용량 사용)
LIVE_CLI=claude-cli CLI_PROVIDERS=1 CLAUDE_CLI_CONFIG_DIR=system npx vitest run src/lib/llm/cli.live.test.ts
npm run lint
npm run typecheck
npm run build && npm start
```

## 배포 (Vercel + Turso)

1. Turso DB를 만들고 `DATABASE_URL=libsql://<db>.turso.io`, `DATABASE_AUTH_TOKEN`을 Vercel 환경 변수에 넣습니다.
   테이블은 첫 요청 때 자동으로 만들어집니다(`./drizzle` 폴더가 배포물에 포함되도록 `next.config.ts`에 설정되어 있습니다).
2. `ANTHROPIC_API_KEY`(필요하면 `ANTHROPIC_MODEL`, `DAILY_DIAGNOSIS_LIMIT`)를 넣습니다.
3. 배포합니다.

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
- 업로드 제한: 요청 본문 22MB(Content-Length 없는 chunked 요청 포함), 파일당 10MB, PDF 50쪽, DOCX 압축 해제 60MB.
- 로컬 SQLite 파일은 서버리스 환경에서 유지되지 않으므로 배포에서는 반드시 Turso(libsql)를 쓰세요.
