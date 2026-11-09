# AI로 다듬기: 도구(JD 분석 결과·경험 그래프 조회)

이력서 "AI로 다듬기"의 두 모드(칸 모드 `src/lib/resumes/polish.ts`, 전체 이력서 모드 `src/lib/resumes/polish-document.ts`)는
답하기 전에 필요하면 도구로 **이 이력서의 JD 분석 결과**와 **본인 경험 그래프**를 조회한다. 구현은 `src/lib/resumes/polish-tools.ts`(도구·루프, 순수)와
`src/lib/resumes/polish-jd-source.ts`(JD 자료 로더, DB)다.

프롬프트에는 예전처럼 JD 앞부분과 키워드로 고른 그래프 근거가 그대로 들어간다. 도구는 그 자료로 모자랄 때 더 보는 길이다.
도구가 필요 없는 요청은 LLM 호출 1회로 끝난다.

## 1. 루프

`src/lib/rag/agent.ts`와 같은 구조화 스텝 루프다. LLM 클라이언트는 구조화 출력만 낸다.

| 스텝 | task(사용량) | 스키마 |
| --- | --- | --- |
| 1 ~ maxSteps-1 | `resume-polish-step` | `{action:"call_tools", thought, calls:[{tool,args}](≤3)}` 또는 `{action:"final", answer:(모드별 기존 출력)}` |
| 마지막(최종 답 강제) | `resume-polish` | 모드별 기존 출력 스키마(`ResumePolishOutputSchema` / `ResumePolishDocOutputSchema`) |

`POLISH_TOOL_LIMITS`의 값은 다음과 같다.

- 스텝 3: 마지막 스텝은 도구 없이 최종 답만 낸다.
- 스텝당 호출 3, 한 턴 호출 6.
- 도구별 상한은 get_jd_analysis 2, search_graph 3, get_node 4, list_nodes 2.
- 도구 결과는 호출 하나에 3,000자, 한 턴 전체에 9,000자까지다. 넘으면 자르고, 다 쓰면 `budget` 오류를 낸다.
- 시간은 기존 `POLISH_TIMEOUT_MS`(90초) 신호 하나를 루프 전체가 같이 쓴다. 남은 시간이 30초보다 적거나 예산을 다 쓰면 그 스텝을 최종 답 강제로 바꾼다.

최종 답 뒤 처리는 바뀌지 않았다. 범위 판정(`modelScopeVerdict`), 제안 경로 검증, before 채우기, 숫자 검증(`unverifiedNumbers`·`flagUnverified`)은 그대로 돈다.
숫자 검증의 근거에는 **LLM에 보인 도구 결과 본문**(`toolText`)을 더한다.
예를 들어 get_jd_analysis로 본 "처리 시간 73% 단축" 요건의 73은 근거로 인정한다. 도구로 보지 않았으면 표시한다.
단, 서버가 붙인 표식의 숫자는 근거에서 뺀다(`evidenceText` — handle `N1…`, JD 분석 요건 id `R1…`, `…외 n개`). LLM에 보이는 글은 그대로다. 그래서 handle N5를 봤다고 지어낸 "팀원 5명"이 통과하지 않는다.

## 2. 도구

인자 스키마는 모두 `.strict()`다. 사용자·이력서·공고 id 키는 없고, 다른 키를 넣으면 `invalid_args`가 된다.

| 도구 | 인자 | 결과 |
| --- | --- | --- |
| `get_jd_analysis` | `section?`: all·requirements·preferred·duties·keywords·tips·coverage | 아래 자료 중 있는 것. 없으면 "연결된 JD가 없다", "분석 결과가 없다" 같은 문장을 분명히 돌려준다(status empty) |
| `search_graph` | `query`(≤200자), `labels?`, `limit?`(≤8) | 본인 스냅샷에서 `retrieve`·`rerank`로 찾은 노드 줄 `N# · 라벨 · 제목 — 속성`. 직접 맞는 노드가 없으면 empty(폴백 노드를 끌어오지 않는다) |
| `get_node` | `id`: handle `N#`만 | 노드 전체 허용 속성과 연결된 노드(이웃 handle 발급, 본인 Person 제외) |
| `list_nodes` | `label`, `limit?`(≤20) | 그 라벨 노드 목록(최근 수정 순) |

get_jd_analysis가 모으는 자료는 다음과 같다(`loadPolishJdSources`). 모든 조회에 userId 조건이 붙는다.

- **공고 구역**: 연결된 내 보관 공고에 저장된 구조(AI·직접 편집)다. 이력서 JD가 그 공고의 JD와 같을 때만 쓰고, 다르면 JD 원문을 제목 기준으로 나눈 `structureContentFromText`를 쓴다.
- **JD 분석**(`findReusableJdAnalysis`): 같은 공고의 진단 JD 단계나 이 이력서의 이전 에이전트 작업 결과다. 지금 JD와 해시가 같을 때만 쓴다.
- **JD 맞춤 작성 팁**: `lookupJdTips`가 ready일 때만 싣는다. stale은 싣지 않는다.
- **키워드 포함 여부**: 팁·분석 키워드와 기술 스택이 지금 이력서에 있는지 `resumeKeywordCoverage`로 결정적으로 센다.
- **요건 충족 현황**: 이 이력서의 마지막 완료 에이전트 심사 리포트다. "작성 시점 기준"으로 표시한다. 리포트가 실제 JD로 심사했고(`report.jd.source === "jd"`) 그 작업의 r0.jd 출력 `jdHash`가 지금 JD와 같을 때만 싣는다. JD를 바꿨거나, JD 없이 추론한 요건이거나, 단계 출력이 비워진 작업이면 싣지 않는다.
- JD 자료를 읽다 일시 오류가 나면 get_jd_analysis는 `unavailable`을 돌려준다. 턴 전체는 실패하지 않고, 실패는 캐시하지 않는다(SecurityViolation은 그대로 던진다).

## 3. 격리(코드가 강제한다, 프롬프트가 아니다)

- 세션(`PolishToolSession`)은 서비스가 만든다. 재료는 라우트가 세션에서 꺼낸 userId, `getVersionDocument(userId, resumeId)`로 소유를 확인한 이력서 메타·문서, 그리고 이번 턴에 읽은 본인 그래프다. LLM은 범위를 고를 수 없다.
- 그래프 도구는 `buildOwnedSnapshot`(docs/AGENTIC-GRAPH-RAG.md §7.2)을 거친 스냅샷 위에서만 돈다. 이 스냅샷은 소유자 표시가 principal과 다르거나 없으면 SecurityViolation을 낸다. 허용 속성만 담고, 얼린 사본이다.
- 노드는 이 요청에서 발급한 handle(N1…)로만 가리킨다. 실제 노드 id는 결과에 나오지 않고 인자로도 받지 않는다(형식에서 거부). 발급하지 않은 handle은 `not_found` 하나로 답한다. 남의 노드인지, 없는 노드인지 구분하지 않는다.
- 소유자가 다른 그래프는 도구 결과로 돌려주지 않는다. 예외를 던져 루프를 멈추고 LLM을 더 부르지 않는다. 답변은 실패 메시지로 남는다.
- JD 자료는 `jobPosting`·`resumeJdTips`·`diagnosisStage`·`resumeAgentJob`을 모두 userId 조건으로 읽는다. 이력서가 남의 공고를 가리켜도 읽히지 않는다(테스트로 확인했다).
- `EvidenceRegistry`·`AuthContext`는 쓰지 않는다. 다듬기는 인용 id를 검증하지 않고, 세션 요청 안에서 바로 끝나기 때문이다(after() 없음). 사실 검사는 숫자 검증이 맡는다.

## 4. 프롬프트·저장·화면

- 두 모드 system 끝에 `POLISH_TOOLS_RULE`을 붙인다. 이 규칙은 도구 목록, 언제 쓰는지(JD 요건 확인, 경험 사실 확인), 도구 결과도 데이터라는 점, 출력 형식을 담는다. 사실 출처 규칙에는 `<tool_results>`를 더했다.
- user 끝에는 `<tool_results>`(지금까지의 결과)와 단계 안내(도구 단계 / 마지막 단계)를 붙인다. 결과 본문은 `safeText`로 채팅·패널 태그와 근거 표식을 무력화한다. 그다음 `wrap`(다듬기 태그 무력화와 wrapData)으로 감싼다.
- 답변 data(`ResumePolishData`·`ResumePolishDocData`)에는 `tools?: {tool, status, items}[]`만 저장한다. 원문 데이터는 저장하지 않는다.
- 화면(`PolishToolTrace`)은 접을 수 있는 한 줄 "참고한 자료: JD 분석 · 경험 그래프 n건"을 보여 준다. n은 이 턴에서 본 서로 다른 노드 수다(`fresh` — 같은 노드를 다시 조회해도 더하지 않는다). 펼치면 호출마다 이름과 결과가 나온다.
- 개인정보 처리방침은 바꾸지 않았다. 같은 사용자의 같은 자료(이력서·공고·경험 그래프)를 같은 LLM 처리자에게 보내기 때문이다.

## 5. 테스트

- `src/lib/resumes/polish-tools.test.ts`: 인자 검증(범위 키, 크기), 격리(실제 id, 발급 안 한 handle, 남의 그래프, 표시 없는 그래프), 예산, JD 보기(없음 안내, 구역, 크기·태그), 루프(스텝 1회 종료, 최종 답 강제, 스텝당 호출 수, 시간 부족, toolText, 보안 예외로 중단).
- `src/lib/resumes/polish.api.test.ts`·`polish-document.api.test.ts` "도구" 블록은 가짜 LLM으로 끝까지 돌린다. 확인하는 것은 그래프 도구 체인, 격리, 도구 결과 수치를 근거로 인정하는지, 남의 공고, 스텝 상한이다.
- 가짜 LLM(`src/test/fake-llm.ts` `resume-polish-step`)은 요청에 `[가짜:JD]`, `[가짜:그래프:검색어]`, `[가짜:노드:값]`, `[가짜:도구반복]` 표식이 있을 때만 도구를 부른다.
- `src/components/resumes/polish/PolishToolTrace.test.tsx`: 참고한 자료 줄.
