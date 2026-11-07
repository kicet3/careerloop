# 오브젝트 저장소(R2·로컬)와 큰 파일 직접 업로드

코드: `src/lib/storage/index.ts`. R2 변수 네 개(`R2_ACCOUNT_ID`·`R2_ACCESS_KEY_ID`·`R2_SECRET_ACCESS_KEY`·`R2_BUCKET`)가 모두 있으면
Cloudflare R2, 없으면 로컬 폴더(`STORAGE_DIR`, 기본 `./data/storage`). `APP_ENV=PRODUCTION`·Vercel에서는 R2만 쓴다.

## 키 구조

| 접두사 | 내용 | 지우는 때 |
| --- | --- | --- |
| `users/<u>/resumes/<id>/…` | 이력서 버전 JSON 등 | 이력서 삭제·탈퇴 |
| `users/<u>/portfolios/<id>/text-<꼬리>.txt` | 포트폴리오에서 뽑은 글(AI용) | 포트폴리오 삭제·내용 바꾸기·탈퇴 |
| `users/<u>/portfolios/<id>/original-<꼬리>.<확장자>` | 포트폴리오 원본 파일(화면에 그대로 보임, 소유자만 `GET /api/portfolios/[id]/original`) | 포트폴리오 삭제·내용 바꾸기·탈퇴 |
| `users/<u>/profile/photo-<꼬리>.jpg` | 프로필 사진(서버가 600x800 JPEG로 다시 만듦, EXIF 없음, 소유자만 `GET /api/account/photo`) | 사진 바꾸기·지우기·탈퇴 |
| `uploads/<u>/portfolio-<무작위>.<확장자>` | 큰 포트폴리오 파일의 임시 자리(브라우저가 서명 주소로 바로 올림) | 마무리 직후·형식 거절 시·탈퇴, 남은 것은 수명 주기 규칙(1일) |
| `shared-postings/<id>/…` | 공용 공고 원문 캡처 | 공용 공고 정리 |

탈퇴(`src/lib/auth/account.ts` `deleteAccount`)는 `users/<u>/`와 `uploads/<u>/` 접두사를 모두 지운 뒤 DB 행을 지운다.

## 포트폴리오 업로드 두 경로

**받는 형식: PDF만.** 새로 만들기·내용 바꾸기·이력서에서 바로 올리기 모두 확장자 `.pdf` **그리고** 내용 앞 1024바이트 안의 `%PDF-` 표식을 서버가 확인한다
(`src/lib/portfolios/original.ts` `PORTFOLIO_UPLOAD_KINDS`·`ingestPortfolioFile`). 그 밖의 형식(DOCX·HWP·이미지·글 등)이나 확장자만 `.pdf`로 바꾼 파일은
415와 한국어 안내("포트폴리오 파일은 PDF만 올릴 수 있습니다…" / "파일 내용이 PDF 형식이 아닙니다…")로 거절한다. 화면(`PortfolioContentForm`)도
`accept=".pdf,application/pdf"`로 고르게 하고, 보내기 전에 파일 앞부분의 `%PDF-`를 확인한다(서버 확인을 대신하지 않는다).
예전에 올린 PDF 밖 원본(DOCX·HWP·이미지·TXT 등)은 데이터를 바꾸지 않으며 그대로 보이고 내려받고 공유할 수 있다 — 막는 것은 새 업로드뿐이다. 링크·그래프 포트폴리오는 영향이 없다.
이력서 업로드(`FileDrop` `UPLOAD_ACCEPT`)는 그대로다.

- **작은 파일**(Vercel 4MB 이하, 자체 호스팅은 파일 상한까지): 화면이 multipart로 `POST /api/portfolios`(새로)·`PUT /api/portfolios/[id]`(내용 바꾸기)·
  `PUT /api/resumes/[id]/portfolio`(이력서에서 바로)에 보낸다. Vercel 요청 본문 4.5MB 제한 때문에 4MB에서 끊는다.
- **큰 파일**(4MB 초과 ~ `PORTFOLIO_MAX_UPLOAD_MB`, 기본 30MB, R2일 때만):
  1. `POST /api/portfolios/uploads` `{ fileName, size, type? }` → 서버가 확장자(`.pdf`)·브라우저가 알린 MIME(`type`이 있으면 `application/pdf`)·크기를
     확인하고(PDF가 아니면 서명 주소를 주기 전에 415) 업로드 레이트 리밋을 센 뒤
     `uploads/<세션 사용자>/portfolio-<무작위>.<확장자>`에 대한 **서명된 PUT 주소**(10분, `Content-Type: application/octet-stream`과
     `Content-Length`를 서명에 포함)를 준다.
  2. 브라우저가 그 주소로 R2에 바로 `PUT`한다(**버킷 CORS 설정 필요 — 아래**).
  3. 같은 endpoint에 JSON `{ uploadId, fileName, title?, description? }`로 마무리 → 서버가 세션 사용자의 임시 키만 읽어 크기·형식(`.pdf` + `%PDF-` 매직 바이트)을
     다시 확인하고(틀리면 415 + 임시 파일 삭제) 글을 뽑은 뒤, **확인한 바로 그 바이트**를 `users/<u>/portfolios/<id>/original-…`에 새로 쓰고 임시 파일을 지운다
     (서버 쪽 복사를 쓰지 않는다 — 서명 주소가 살아 있는 동안 확인과 복사 사이에 다른 바이트로 덮어쓸 수 있기 때문).
     다른 사용자의 `uploadId`를 보내도 자기 `uploads/<u>/`에서 찾으므로 404다.
     `uploadId` 하나는 한 번만 마무리한다(`rate_events` 버킷 `portfolio-upload-finalized`, 25시간) — 서명 주소로 다시 올려 다시 마무리하면 409.
- 로컬 저장소(개발)는 서명 주소가 없어 늘 multipart로 받는다(자체 호스팅 상한 = 파일 상한).

## R2 버킷 설정 (운영자가 한 번)

### CORS — 큰 파일 직접 업로드에 필요

Cloudflare 대시보드 → R2 → 버킷 → Settings → CORS Policy에 아래 JSON을 넣는다(또는 `wrangler r2 bucket cors set <bucket> --file cors.json`).
설정하지 않으면 4MB 넘는 포트폴리오 업로드가 브라우저에서 "파일을 저장소에 올리지 못했습니다"로 실패한다(작은 파일은 영향 없음).

```json
[
  {
    "AllowedOrigins": ["https://resume.snowlink.team", "http://localhost:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

- 개발 서버에서 R2를 쓰지 않으면(로컬 저장소) `localhost:3000`은 필요 없다. 다른 미리보기 도메인(Vercel Preview 등)에서 시험하려면 그 출처를 더한다.
- CORS에 `GET`은 열지 않는다. 4MB가 넘는 원본은 앱 라우트가 소유자 확인 뒤 R2 서명 GET 주소로 302하지만, 브라우저는 그 주소를
  iframe·img·내려받기(탐색)로 열 뿐 fetch로 읽지 않으므로 CORS가 필요 없다. 사진과 4MB 이하 원본은 앱 라우트가 그대로 내려준다.

### 수명 주기 규칙 — 임시 업로드 정리

R2 → 버킷 → Settings → Object lifecycle rules → Add rule: 접두사 `uploads/`, **1일 뒤 객체 삭제**.
서명은 받았지만 마무리하지 않은(창을 닫는 등) 임시 파일을 치운다. 정상 흐름은 마무리 때 바로 지운다.

## 내려줄 때의 보안 헤더

`GET /api/portfolios/[id]/original`(소유자만, 남의 것은 404):

- 늘 `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Cross-Origin-Resource-Policy: same-origin`.
- PDF·이미지·TXT/MD만 `inline`(파일 이름은 `filename*=UTF-8''…`). HTML·DOCX·HWP·HWPX는 늘 첨부, HTML은 `application/octet-stream`으로 —
  올린 HTML이 우리 출처에서 실행되지 않는다.
- PDF 밖은 `Content-Security-Policy: sandbox; default-src 'none'; …`. PDF는 브라우저 내장 PDF 보기(자체 격리)가 CSP sandbox 아래에서 열리지 않아
  `frame-ancestors 'self'`만 둔다.
- `?view=html`(DOCX): 서버가 mammoth로 HTML을 만들어 CSP sandbox로 내려주고, 화면은 `<iframe sandbox="">`로 넣는다.
  그림(data URI)은 합계 3MB까지만 넣고 넘는 그림은 빼고 안내를 남긴다. 결과가 4MB를 넘으면 422(원본 내려받기 안내).
- **4MB 넘는 원본(R2)**: Vercel Functions는 응답 본문도 4.5MB로 막으므로 본문을 싣지 않고, 소유자 확인 뒤 **60초짜리 서명 GET 주소로 302**한다.
  서명에 `response-content-type`(HTML은 `application/octet-stream`), `response-content-disposition`(inline/attachment, `filename*`),
  `response-cache-control: private, no-store`를 넣는다. R2는 다른 출처라 우리 쿠키·화면에 닿지 않지만, TXT·MD는 그쪽에서도 첨부로만 보낸다.
  이 경로에는 nosniff·CSP 헤더가 붙지 않는다(R2가 주는 헤더). 4MB 이하·로컬 저장소는 위 헤더로 앱이 그대로 내려준다.
