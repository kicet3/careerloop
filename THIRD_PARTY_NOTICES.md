# Third-Party Notices

이 프로젝트에 포함되었거나 이 프로젝트가 기반으로 삼은 외부 저작물의 고지입니다.
npm 의존성의 라이선스는 각 패키지(`node_modules/*/LICENSE`)를 따릅니다.

## hiring-panel-skill

- 출처: https://github.com/alexyc9381/hiring-panel-skill
- 사용 범위: 심사위원 7명의 구성, 심사 규칙, 산출물 형식(`PANEL.md`, `RESUME-IMPROVED.md`)을 웹 서비스로 옮기고 확장했습니다.
- 라이선스: MIT

```
MIT License

Copyright (c) 2026 Alex Chen (@nocodealex, https://chen.media)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## CareerLoop

- 출처: CareerLoop(같은 저작권자 kicet3의 프로젝트)
- 사용 범위: 공고 보관함·URL 가져오기, 지원 추적·인사이트, 기술 키워드 사전, HWP·HWPX·HTML 파일 추출 코드를 가져와 고쳐 썼습니다.
  가져온 파일은 머리 주석에 `CareerLoop(<원래 경로>)에서 가져옴`으로 표시했습니다(`grep -rn "CareerLoop(" src`로 찾을 수 있음).
  - 파일 추출: `src/lib/ingest/hwp.ts`(원본 `src/server/extractHwp.ts`), `src/lib/ingest/markup.ts`·`src/lib/ingest/extract.ts`의 HWPX·HTML 경로(원본 `src/server/extract.ts`), `src/lib/ingest/extract.test.ts`의 HWP·HWPX·HTML 테스트(원본 `src/server/extract.test.ts`)
  - 공고 보관함: `src/lib/postings/url.ts`(원본 `src/lib/postings.ts`·`src/lib/postingImportTypes.ts`), `deadline.ts`·`filter.ts`(원본 `src/lib/postings.ts`), `jd-sections.ts`(원본 `src/lib/writing.ts`), `fetch.ts`(원본 `src/server/postingImport/fetch.ts`), `page-text.ts`·`extract.ts`(원본 `src/server/postingImport/analyze.ts`), `imports.ts`(원본 `src/server/postingImport/jobs.ts`), 테스트 `pure.test.ts`·`import-pipeline.test.ts`(원본 `src/lib/postings.test.ts`·`postingDeadlineTime.test.ts`·`writing.test.ts`·`src/server/postingImport/import.test.ts`)
  - 지원 인사이트: `src/lib/applications/insights.ts`·`insights.test.ts`(원본 `src/lib/analytics.ts`·`analytics.test.ts`)
  - 기술 키워드 사전: `src/lib/skills/dictionary.ts`·`dictionary.test.ts`(원본 `src/lib/keywords.ts`·`keywords.test.ts`)
- 라이선스: MIT

```
MIT License

Copyright (c) 2026 kicet3

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 나눔고딕 (NanumGothic)

- 파일: `src/lib/report/fonts/NanumGothic-Regular.ttf`, `NanumGothic-Bold.ttf`, `NanumGothic-ExtraBold.ttf`
- 출처: https://github.com/google/fonts (ofl/nanumgothic)
- 사용 범위: PDF 보고서에 내장
- 라이선스: SIL Open Font License 1.1. 전문은 [`src/lib/report/fonts/OFL.txt`](src/lib/report/fonts/OFL.txt)에 있습니다.

```
Copyright (c) 2010, NHN Corporation (http://www.nhncorp.com),
with Reserved Font Name Nanum, Naver Nanum, NanumGothic, Naver 
NanumGothic, NanumMyeongjo, Naver NanumMyeongjo, NanumBrush, Naver
```
