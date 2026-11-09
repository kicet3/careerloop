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

## 5. 항목 제안: 여러 칸 한 번에 고치기·새 항목 추가

칸 제안(`{path, after}`)은 한 칸만 바꾼다. 프로젝트·경력은 항목 하나를 카드 하나로 다루는 **항목 제안**을 더했다.
계약은 `src/lib/domain/resume-polish-items.ts`(순수, 화면·서버 공용), 검증은 `src/lib/resumes/polish-items.ts`다.

| 종류 | 언제 | 모드 | 적용 |
| --- | --- | --- | --- |
| `item-edit` | 한 항목의 여러 칸(이름·회사·팀·역할·기간·요약·문제·행동·결과·근거·기여·기술 / 경력: 회사·부서·직무·기간·지역·담당 범위·기여)을 한 번에 채우거나 고칠 때 | 칸 모드(대상 칸이 든 항목), 전체 모드 | 고칠 칸 전부를 한 번에. 하나라도 제안 뒤 바뀌었거나 그 자리에 다른 항목이 왔으면(순서 바꾸기·앞에 추가 — `anchor`) 409 + 바뀐 칸 목록, 아무것도 바꾸지 않는다 |
| `item-add` | 사용자가 새 프로젝트·경력 추가를 요청했을 때 | 전체 모드만 | 제안한 자리(0~길이, 넘으면 맨 뒤)에 넣는다. 같은 항목(같은 이름 — 경력은 회사+직무)이 있거나 이미 적용 기록(`data.applied`)이 있으면 409(추가한 항목을 고친 뒤에도 중복 추가하지 않는다), 섹션 상한(20)을 넘으면 400 |

- **LLM 출력**: 칸 모드 `ResumePolishOutputSchema.itemChanges[{field, value}]`·`itemReason`, 전체 모드 `ResumePolishDocOutputSchema.items[{kind, section, index, changes, reason}]`.
  목록 칸(bullets·techs)은 value 한 줄에 하나. 예전 출력(필드 없음)은 기본값 `[]`로 받는다.
- **대상은 서버가 정한다**: 칸 모드는 대상 경로(`projects[0].problem`)의 항목으로 고정한다. LLM의 kind·section·index는 무시하고, 추가도 받지 않는다.
  전체 모드는 지금 문서에 있는 항목만 고칠 수 있다(없는 index·허용 밖 섹션·칸은 버리고 `dropped`에 센다). before는 서버가 지금 값으로 채운다.
- **예산**: 항목 제안 최대 `MAX_DOC_ITEM_SUGGESTIONS`(3)을 먼저 받고, 남은 자리(6 − 항목 수)에 칸 제안을 받는다. 항목 고치기가 바꾸는 칸의 칸 제안은 뺀다(같은 칸을 두 번 고치지 않게). 같은 항목 고치기는 첫 제안만.
- **사실 검증**(같은 근거 — 이력서·JD·그래프·도구 결과·사용자 말, 고치기는 before 값 포함):
  - 글 칸·기여 줄: 근거 없는 숫자는 칸 모드와 같은 `[ADD: 수치 확인 — …]`.
  - 기간(startDate·endDate): 숫자 묶음이 근거에 없으면 그 변경을 버린다(20자 칸이라 감쌀 수 없다). `2023-01`과 `2023.01`은 같은 근거로 본다.
  - 기술·이름 근거(facts)는 JD와 JD 분석 도구(get_jd_analysis) 결과를 뺀 것이다(이력서·그래프·그래프 도구 결과·사용자 말). JD에 있다고 사용자가 해 본 것은 아니다.
  - 기술(techs): facts에 낱말로 없는 기술명은 뺀다(부분 문자열로 맞추지 않는다 — `Go`≠`google`, `Java`≠`JavaScript`. 표기 차이 `Node.js`/`NodeJS`는 같게 본다).
  - 이름·사실 칸(프로젝트 이름·회사, 경력 회사·부서·직무): 고치기·추가 모두 facts에 없으면 `[ADD: 이름 확인 — …]`/`[ADD: 사실 확인 — …]`. 프로젝트 역할·팀 구성은 값은 두고 '근거 확인 필요'로 표시한다.
  - 추가: 이름 칸(프로젝트 이름 또는 회사, 경력은 회사) 중 하나가 facts에 있어야 받는다 — 이름까지 자리표시인 새 항목(요약·문제·행동을 통째로 지어냈을 수 있다)은 버린다. 비어 있는 핵심 칸(프로젝트 문제·행동·결과·이름, 경력 회사·직무·담당 범위)은 `[ADD: …]` 자리표시. 새 항목은 문서 스키마로 다시 검증한다.
  - 칸 모드에서 대상이 목록 줄(`projects[0].bullets[3]`)이면 그 목록 칸은 항목 제안에서 받지 않는다(줄 수가 바뀌면 대화의 대상 줄이 사라지거나 다른 줄을 가리킨다).
  - 칸 글자·줄 수 상한은 `ResumeDocumentSchema`에서 읽어 자른다(`polishItemFieldLimit`).
- **프롬프트**: 전체 모드는 `<polish_items>`(섹션별 개수/상한, 칸별 상한, 항목마다 `- [projects[0]] name=…; role=…`)를 더 싣는다. 칸 모드는 대상 칸이 항목 안이면 그 항목 한 줄을 싣는다. `<polish_items>` 태그도 `safe`가 무력화한다.
  추가 요청이면 search_graph·get_node로 그 경험의 사실을 찾고 찾은 사실만 쓰라고 지시한다(규칙 8).
- **적용 API**(`POST /api/resumes/[id]/polish/apply`): 칸 모드 `{messageId, item: true, exclude?: string[]}`, 전체 모드 `{messageId, indices, exclude?: [{index, fields}]}`.
  exclude는 카드에서 체크를 푼 칸이다. 충돌 확인도 고른 칸만 한다. 항목 고치기와 항목 칸의 칸 제안은 제안 때 항목 정체(`anchor` — 바꾸지 않는 이름·회사·직무·기간, 모두 비면 고치지 않는 칸 전체)도 확인한다(anchor가 없는 예전 제안은 확인하지 않는다). 전체 모드는 칸·항목 고치기를 먼저(제안 때 자리), 추가는 마지막에 큰 자리부터 넣는다. 결과는 새 버전 하나(source ai)다.
- **저장 형식·호환**: 칸 모드 data에 `itemSuggestion?`·`appliedItem?`, 전체 모드 `suggestions[]`에 `kind: "item-edit" | "item-add"` 항목이 섞인다. 예전 메시지(칸 제안에 kind 없음)는 그대로 칸 카드로 보이고 적용된다.
  `polishContinuationStart`는 적용한 항목 제안의 대상 칸 새 값으로 이어진다.
- **화면**: `PolishItemCard`가 칸마다 전/후(체크로 빼기)와 적용 버튼 하나, 추가는 새 항목 미리보기와 추가 버튼을 보인다. 상태는 `polishItemState`(live·applied·stale·full)다.
  상태를 보려고 전체 모드 조회는 `sections`(프로젝트·경력), 칸 모드 조회는 `item`(대상 항목의 지금 값)을 더 돌려준다.
  적용하면 편집기는 서버가 돌려준 문서로 바뀌고, 새 항목 객체는 `reorder.ts`의 새 key를 받는다(순서 바꾸기 상태가 엉뚱한 항목에 남지 않는다).

## 6. 테스트

- `src/lib/resumes/polish-tools.test.ts`: 인자 검증(범위 키, 크기), 격리(실제 id, 발급 안 한 handle, 남의 그래프, 표시 없는 그래프), 예산, JD 보기(없음 안내, 구역, 크기·태그), 루프(스텝 1회 종료, 최종 답 강제, 스텝당 호출 수, 시간 부족, toolText, 보안 예외로 중단).
- `src/lib/resumes/polish.api.test.ts`·`polish-document.api.test.ts` "도구" 블록은 가짜 LLM으로 끝까지 돌린다. 확인하는 것은 그래프 도구 체인, 격리, 도구 결과 수치를 근거로 인정하는지, 남의 공고, 스텝 상한이다.
- 가짜 LLM(`src/test/fake-llm.ts` `resume-polish-step`)은 요청에 `[가짜:JD]`, `[가짜:그래프:검색어]`, `[가짜:노드:값]`, `[가짜:도구반복]` 표식이 있을 때만 도구를 부른다.
- `src/components/resumes/polish/PolishToolTrace.test.tsx`: 참고한 자료 줄.
- `src/lib/resumes/polish-items.test.ts`: 항목 제안 검증(없는 항목·칸·상한 넘침, 칸 글자·줄 수, 숫자·기술·기간·이름 검증, 추가 자리표시·중복), 적용 순서, 상태, 예전 메시지 호환.
- `src/lib/resumes/polish-items.api.test.ts`: 가짜 LLM으로 두 모드 끝까지(`[가짜:묶음]`·"한번에 채워" → 묶음, `[가짜:추가]`·"프로젝트 추가" → 그래프에서 찾아 추가). 원자 적용·409·exclude·상한 400·예산 6·예전 메시지 적용.
- `src/components/resumes/polish/PolishItemCard.test.tsx`: 카드(고치기·추가·상태 배지), 답변 안 카드, 예전 메시지 화면.
