# 공고 원문 링크와 원문 캡처

공고 화면의 "원문 공고 열기 ↗" 링크와, URL로 가져온 공고 페이지를 한 장의 이미지로 남겨 두는 원문 캡처를 설명한다.

## 원문 링크

- `src/lib/postings/source-link.ts`의 `safeSourceUrl`은 http/https 주소만 통과시킨다. `user:pass@`가 들어 있는 주소도 거절한다.
- `src/components/postings/SourceLink.tsx`는 링크를 새 탭으로 열고 `rel="noopener noreferrer"`를 붙인다. 클릭 이벤트는 부모로 전달되지 않는다.
  - 보관함 카드는 카드 전체가 `<Link>`다. 그래서 아이콘 링크를 카드 링크의 형제로 두고 절대 위치로 배치했다.
  - 공고 찾기 카드에는 아이콘을, 공고 상세와 공고 찾기 상세에는 텍스트 링크를 둔다.
- 이력서·지원 기록 화면의 연결 공고 링크는 작업 묶음 B가 같은 컴포넌트로 붙인다.

## 원문 캡처 흐름

1. 가져오기 라우트(`POST /api/postings/import`)는 `after(() => runImportThenCapture(jobId))`를 예약한다.
   - 가져오기(`runImport`, 상한 180초)가 끝나면 `queueCaptureForImport`가 공용 공고에 캡처를 예약한다(`requestCapture`).
   - 예약이 성공한 경우에만 같은 백그라운드 작업에서 `runPostingCapture`를 실행한다(상한 75초).
   - 가져오기 응답이나 작업 완료 상태는 캡처를 기다리지 않는다.
   - "다시 가져오기"(refresh)는 이미 있는 캡처도 다시 찍는다(force). 공고마다 1시간에 3회까지다(`POSTING_CAPTURE_TARGET_LIMIT`).
   - 공고 찾기에 이미 있던 공고를 바로 담은 경우(fromShared)에도 캡처가 없거나 실패 상태면 예약한다. 기존 공고는 이렇게 채워진다.
2. `runPostingCapture`는 `claimCapture`(pending → running, 조건부 UPDATE) → `capturePostingPage` → `putObject` → `recordCaptureSuccess`/`recordCaptureFailure` 순서로 진행한다.
   - 이 함수는 예외를 던지지 않는다.
   - 실패 문구는 사용자에게 보여 줘도 되는 한국어만 저장한다. 내부 주소나 스택은 로그에만 남긴다.
3. 저장 위치는 `shared-postings/<sharedPostingId>/capture.webp`이다. 페이지 높이가 WebP 한계(16,383px)를 넘으면 `.jpg`로 저장한다.
   - 이미지는 공용 공고마다 한 장이며, 다시 찍으면 덮어쓴다. 형식이 바뀌면 이전 형식의 파일을 지운다.
4. 화면 상태(`PostingCapture.tsx`)
   - `done`: "원문 캡처 보기" 버튼이 모달을 연다. 모달은 스크롤, 확대·축소(+/−, 맞춤↔100%), Esc 닫기, 포커스 트랩을 지원하고 "캡처 시각 · 원문 확인용 사본 · 출처 링크"를 표시한다.
   - `pending`/`running`: "원문 캡처 중…"을 표시하고 4초마다 상태를 확인한다(최대 150초).
   - `failed`/`none`: "캡처 없음 · 다시 시도"를 표시한다. 시도 상한(5회)에 도달하면 다시 시도 버튼을 숨긴다.

## API

| 메서드·경로 | 동작 |
|---|---|
| `GET /api/shared-postings/[id]/capture` | 이미지 바이트. `canViewCapture`로 권한을 확인하고 `Cache-Control: private, max-age=3600`, `X-Content-Type-Options: nosniff`, `CSP: default-src 'none'; sandbox` 헤더를 붙인다. 캡처가 없으면 404 |
| `GET /api/shared-postings/[id]/capture/info` | `PostingCaptureInfo`를 돌려준다 |
| `POST /api/shared-postings/[id]/capture` | 다시 시도. 이미 찍는 중이거나 완료됐으면 현재 상태를 돌려주고 횟수는 쓰지 않는다. 시도 상한을 넘었으면 409. 그 밖에는 사용자 24시간 10회·공고 1시간 3회 제한을 확인한 뒤 202 `{capture}` |
| `GET·POST /api/postings/[id]/capture[/info]` | 내 공고에 연결된 공용 공고 기준으로 위와 같이 동작한다. 직접 입력한 공고와 다른 사람의 공고는 404 |

- 이미지는 공개 URL 없이 위 인증 라우트로만 내려준다.
- 화면은 `?v=<capturedAt>`를 붙여 다시 찍은 뒤 캐시된 이미지가 보이지 않게 한다.

## SSRF 방어

URL 가져오기 fetcher(`fetch.ts`)와 같은 규칙을 쓴다. 공개 주소만 허용하므로 사설, 루프백, CGNAT(100.64/10), 링크로컬, ULA, 문서용 대역은 막힌다.

1. 첫 주소: 브라우저를 띄우기 전에 `publicTarget(url)`로 URL 형식과 DNS 결과를 확인한다.
2. 출구 프록시(`capture-egress.ts`): 브라우저는 `--proxy-server=http://127.0.0.1:<임의 포트>`와 `--proxy-bypass-list=<-loopback>`로 실행한다. 그래서 하위 리소스, 리다이렉트, 웹소켓, 서비스 워커 요청과 루프백 주소까지 모든 네트워크 요청이 이 프로세스 안의 프록시를 지난다.
   - 프록시는 호스트를 다시 확인한다. DNS 응답 중 하나라도 비공개 주소면 거절한다.
   - 연결은 확인한 IP로만 연다(DNS 고정). 브라우저 쪽 DNS 리바인딩은 통하지 않는다.
   - 포트는 80과 443만 허용한다.
   - 받은 데이터가 25MB를 넘으면 모든 연결을 끊고 새 연결도 거절한다(509).
3. 요청 가로채기(`page.setRequestInterception(true)`): 1차 거름망이다. 문서, 하위 리소스, 리다이렉트의 각 단계를 확인해 허용하지 않는 스킴(file:, chrome:, ftp: 등)과 호스트, 포트를 `abort`한다. 동영상과 오디오도 받지 않는다.
4. 그 밖의 브라우저 설정
   - 다음 플래그로 프록시 밖으로 나가는 경로를 닫는다: `--disable-quic`, `--dns-prefetch-disable`, `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`, DoH와 AsyncDns 끄기.
   - 다운로드를 막고, 서비스 워커를 우회하고, 쿠키 없는 새 브라우저 컨텍스트를 쓴다.
   - DevTools는 `pipe: true`로 연결해 디버깅 포트를 열지 않는다.

## 브라우저 선택

| 환경 | 실행 파일 |
|---|---|
| Vercel·Lambda(`VERCEL` 또는 `AWS_LAMBDA_FUNCTION_NAME`) | `@sparticuz/chromium`의 `executablePath()`가 `/tmp`에 압축을 푼다(headless shell, `setGraphicsMode=false`) |
| `CHROME_PATH` 설정 | 그 경로 |
| macOS | `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` |
| 그 밖 | "캡처 브라우저가 없습니다." 오류로 실패 상태가 기록된다. 가져오기에는 영향이 없다 |

### 버전

| 패키지 | 버전 | Chromium |
|---|---|---|
| `@sparticuz/chromium` | 153.0.0 | 153 |
| `puppeteer-core` | 25.11.0 | 153.0.8010.36 |

- `puppeteer-core` 25.11.0은 기준 Chrome이 153.0.8010.36이라 `@sparticuz/chromium` 153과 메이저가 맞는다. 둘 다 정확한 버전으로 고정했다.
- 최신 25.16.0은 Chrome 156 기준이라 고르지 않았다.
- Node 요구 버전은 각각 `^22.17.0 || >=24`와 `>=22.12.0`이다. 프로젝트는 `engines.node` 22.x(Vercel Node 22)를 쓴다.
- 로컬 Chrome(156)은 puppeteer 25.11에서도 동작을 확인했다.
- 버전을 올릴 때는 두 패키지의 Chromium 메이저를 함께 맞춘다. puppeteer-core의 `src/revisions.ts`에 기준 Chrome 버전이 있다.

## 캡처 설정 (`POSTING_CAPTURE`)

| 항목 | 값 |
|---|---|
| 뷰포트 | 폭 1280px(높이 900px), deviceScaleFactor 1 |
| 탐색 | `domcontentloaded`까지 25초. 이후 네트워크가 조용해질 때까지 최대 8초 기다린다 |
| 지연 로딩 | 높이 상한까지 스크롤(최대 6초)한 뒤 맨 위로 돌아오고, 최대 2.5초 더 기다린다 |
| 쿠키·앱 배너 | "동의/수락/닫기/Accept…" 버튼을 눌러 보고(배너·고정 요소 안의 버튼만), 화면을 30% 넘게 덮거나 배너처럼 보이는 고정 요소를 숨긴다. 두 번 시도하고, 실패해도 계속 진행한다 |
| 높이 | 상한 20,000px. 넘으면 위쪽부터 잘라 찍고(clipped) 모달에 안내를 표시한다 |
| 인코딩 | WebP 품질 70. 높이가 16,383px를 넘으면 JPEG 70을 쓴다. 8MB를 넘으면 품질 45로 다시 찍고, 그래도 넘으면 실패로 처리한다 |
| 전체 마감 | 75초. 마감에 걸리면 브라우저를 강제로 닫는다 |
| 동시 실행 | 인스턴스당 브라우저 2개 |
| 시도 상한 | 자동 시도와 다시 시도를 합쳐 5회(성공하면 0으로 초기화). pending이나 running이 3분 넘게 이어지면 멈춘 작업으로 보고 다시 맡는다 |

## 브라우저로 열어 읽기(가져오기 대체 경로)

본문을 자바스크립트로 그리는 채용 사이트(예: Knockout으로 상세 API를 불러 그리는 careers.smilegate.com)는 정적 HTML에 공고가 없다. 가져오기(`runImport`)는 이런 페이지를 캡처와 같은 헤드리스 Chromium으로 한 번 열어 그려진 본문으로 분석한다.

- 언제 여는가(실행마다 최대 1회)
  - 정적 본문이 빈 껍데기일 때(`needsRendering`, `rendered-text.ts`): 본문 150자 미만, 또는 1,500자 미만이면서 Knockout `data-bind`·Angular·Vue 템플릿, 빈 앱 루트(`#root`·`#__next` 등), 자바스크립트 필요 안내, "Loading..." 같은 표식이 있을 때. JobPosting JSON-LD가 있으면 열지 않는다. 이때는 AI 분석 전에 연다.
  - AI가 정적 본문에서 회사·직무를 찾지 못했을 때(`PostingExtractError`): 그때 열어 한 번 더 분석한다.
- 무엇을 읽는가(`render.ts`): `domcontentloaded`(15초) → 네트워크 유휴·본문 길이 안정(최대 10초) → `document.body.innerText`, 그린 DOM(보안 검사 판별·제목/공유 메타 — 페이지 안에서 2MB로 잘라 받는다), 로드 중 받은 같은 사이트 JSON 응답(응답당 512KB·합계 2MB·20개 — 버퍼 상한을 둔 별도 CDP 세션에서 받은 크기(압축 푼 바이트)를 세고, 다 받은 뒤 상한 안일 때만 본문을 가져온다). 실행 도중 마감·취소되면 늦게 뜬 브라우저도 닫고, 닫힌 뒤에야 동시 실행 차례를 돌려준다. 전체 40초, 전송량 15MB. 이미지·글꼴·동영상은 받지 않고 페이지 안의 버튼은 누르지 않는다.
- 모델에 주는 본문(`renderedPageText`): 페이지 제목·공유 제목/설명 → 보이는 본문 → "페이지가 불러온 데이터"(화면에 없는 JSON 값). 근거 검증과 원문 저장도 이 본문 기준이다. 공고 주소는 정적으로 읽은 최종 주소를 그대로 쓴다.
- 작업 상태: 여는 동안 `rendering`("페이지 열어 읽는 중", 진행 막대는 읽기 단계).
- 우회하지 않는다: 스텔스 플러그인·지문 위장·검사 풀기·우회 프록시를 쓰지 않고 User-Agent는 캡처와 같다. 열린 화면이 보안 검사(fetch.ts와 같은 판별 + 짧은 본문의 검사 문구)면 `blocked`(본문 붙여넣기 안내)로 끝난다.
- 열기에 실패하고 정적 본문으로도 찾지 못하면 열기 실패 문구(시간 초과·브라우저 없음·일반)를 남긴다.
- 브라우저 실행·SSRF 방어·동시 실행 상한(인스턴스당 2개, 캡처와 공용)은 `browser.ts`의 `withGuardedPage`를 캡처와 함께 쓴다.
- Playwright가 아니라 기존 puppeteer-core + @sparticuz/chromium을 쓴다: 같은 헤드리스 Chromium 방식이고, Vercel 함수 번들·추적 설정이 이미 되어 있다.

## Vercel 함수 크기·시간 고려사항

- **함수 크기**
  - `@sparticuz/chromium/bin`(압축 약 67MB)을 `outputFileTracingIncludes`로 넣는 라우트는 캡처를 실행하는 라우트뿐이다: `/api/postings/import`, `/api/postings/import/*`, `/api/postings/*/capture`, `/api/shared-postings/*/capture`.
  - Vercel 함수 상한은 압축 해제 기준 250MB다. 다른 라우트(PDF 폰트 등)와 겹치지 않으니 여유가 있다.
  - 함수가 커지면 `@sparticuz/chromium-min`과 외부 tar를 쓰는 방식으로 바꿀 수 있다(코드에서는 `executablePath(url)`만 바꾸면 된다).
- **번들링**: `serverExternalPackages`에 `@sparticuz/chromium`과 `puppeteer-core`를 넣었다. chromium은 `import.meta.url` 기준으로 `bin/`을 찾기 때문에 번들링하지 않는다. 두 패키지 모두 캡처할 때만 동적 `import()`로 불러온다.
- **시간**
  - 해당 라우트의 `maxDuration`은 300이다. 가져오기 상한 180초(브라우저로 열어 읽기 40초 포함)와 캡처 상한 75초를 더한 255초가 그 안에 들어온다.
  - 콜드 스타트에서는 Chromium 압축 해제에 수 초가 더 걸린다. `/tmp/chromium`이 있으면 다시 풀지 않는다.
- **메모리**: Chromium에는 1GB 이상(권장 1.6GB 이상)이 필요하다. Vercel 함수 메모리 설정(Standard 2GB 이상)을 확인한다.
- **아키텍처**: npm 패키지 `@sparticuz/chromium`에는 x64 바이너리만 들어 있다. Vercel 함수는 x64(AL2023)에서 돌기 때문에 그대로 쓸 수 있다. arm64로 바꾸려면 `@sparticuz/chromium-min`과 arm64 pack을 써야 한다.
- **비용**: 캡처 한 건에 함수 시간 5~15초와 이미지 0.3~3MB(R2)가 든다. 공용 공고마다 한 장이므로 같은 공고를 여러 사용자가 담아도 한 번만 찍는다.

## 로컬 확인

```bash
# 실제 브라우저로 한 장 찍기(저장 안 함)
CAPTURE_LIVE_URL=https://job-boards.greenhouse.io/<회사>/jobs/<id> CAPTURE_LIVE_OUT=/tmp/cap.webp \
  npx vitest run src/lib/postings/capture.test.ts -t live
```

2026-11-06 macOS Chrome 156 측정값:

| 페이지 | 결과 |
|---|---|
| Greenhouse 공고 상세 | WebP 1280×8710, 665KB, 5.4초 |
| 원티드 목록 페이지 | 높이 상한 적용, JPEG 1280×20000, 2.98MB, 8.8초 |
