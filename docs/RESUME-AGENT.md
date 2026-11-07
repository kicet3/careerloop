# 그래프 기반 이력서 작성 에이전트 — 기획서

> 상태: 기획(미구현), **검토 반영 v2**. 대상 저장소: CareerLoop(`resume-analysis`). 작성 기준 코드: `9378ba3`.
> 한 줄 요약: **JD 요건 → 경험 그래프 근거 검색 → 근거 매핑 전략 → 근거 인용 초안(+결정적 사실 검증) → 심사위원 패널 심사 → 근거 안에서만 수정**을 반복해, "JD가 요구하는 것에 맞춰, 그래프에 있는 사실로만, 심사위원 기준을 통과하도록" 이력서를 쓴다.

### 검토 반영 요약(v1 → v2)
| 영역 | v1 | v2(이 문서) | 이유 |
|---|---|---|---|
| 심사 패널 | 매 라운드 7명+fit = 8회 호출 | 매 라운드 **핵심 4회**(ats·gatekeeper·manager·fit), 최종본에만 나머지 독자 4명(§2.7) | 라운드 비교·종료 판정은 같은 4명으로 일관되게, 비용 ≈ 30% 절감, 라운드 지연 ↓ |
| 단계 수 | 10종(verify·expand 별도) | **9종**(final_panel 추가, verify·expand 흡수) — `verify`는 `write_top`·`revise` 안의 결정적 후처리, `expand`는 `revise`의 결정적 전처리 | 단계 행·리스·연쇄 경계가 줄어 호출 수·실패 지점 감소 |
| 인용 단위 | 줄(path)마다 citation(최대 280개) | **항목 단위 refs**(경력·프로젝트·핵심 성과 1개당) + 요약·기술만 path 인용(§2.1) | citation 출력만 1만 토큰을 넘을 수 있어 시간 상한(230s)을 위협 |
| 인용 없는 줄 | 조용히 제거 | 제거 비율이 25% 넘으면 **같은 단계 1회 재작성 요청**, 그래도 넘으면 제거 + 리포트 표시(§2.6) | 모델이 인용을 빠뜨리면 이력서가 비어 버리는 실패 |
| 선택적 LLM 검증·LLM 재순위·연결 진단 JD 재사용 | 포함 | **v1 범위 제외**(플래그 뒤 후속) | 효과 대비 복잡도. JD 해시 컬럼도 없다 |
| 작업 테이블 | 독립 job + 독립 목록·띠·슬롯 로직 | 독립 job·step 테이블은 유지하되 **목록·슬롯·띠·보존 정리는 기존 초안 작업과 한 함수로 합침**(§4.1) | 상태 기계는 다르지만 화면·한도 로직 중복 제거 |
| 라우트 | 9개 | **6개** — `fallback`은 `retry?mode=single`, 리포트 조회는 이력서 페이지 서버 컴포넌트에서 직접(§4.3) | 표면 축소 |
| 연쇄 origin | `VERCEL_PROJECT_PRODUCTION_URL` 고정 | 운영은 운영 도메인, 미리보기는 `VERCEL_URL`+우회 비밀, **배포 id 기록**(§3.2) | 미리보기가 같은 DB를 쓰면 운영 코드가 미리보기 작업을 이어 실행하는 문제 |
| 멈춤 판정 | waiting 15분 → failed | waiting은 **실패시키지 않고 다음 접속 때 이어감**, 24시간 지나면 failed. 리스 만료만 회수(§3.5) | 연쇄 비밀이 없거나 자기 호출이 막히면 사용자가 화면을 닫는 순간 정상 작업이 실패로 처리됨 |
| 알림 sweep | sweep에서 kick | sweep은 **서명 fetch만** 보내고 단계는 실행하지 않음 | 알림 스트림 함수 수명 안에서 LLM 단계를 돌리면 스트림이 끊김 |
| 한도·비용 | 하루 10회, 약 $2.1~3.1 | 하루 **5회**, 약 **$1.7~2.4**(§3.6) | Hobby 운영 비용 |
| 소요 시간 안내 | 5~10분 | **8~15분**(실측 전 추정, §3.3) | 단계 추정치 합산 결과와 일치시킴 |
| 출시 | 이메일 해시 allowlist | 기존 `ADMIN_EMAILS`(`isAdminEmail`) 재사용 | 새 비밀·해시 관리 불필요 |
| UX 상태 | 진행·완료·실패 | + `waiting`·취소·예산 중단·심사 미완료·동시 작업 있음·한도 초과·진행 중 최선 초안 미리 보기(§4.4) | 누락 상태 보완 |

---

## 0. 왜 만드는가 — 지금과 무엇이 다른가

지금의 AI 초안(`src/lib/resumes/draft.ts` `generateResumeDraft`)은 **LLM 1회 호출**이다. 그래프 전체 텍스트(최대 16,000자, `GRAPH_TEXT_MAX`)와 JD를 한 프롬프트에 넣고, "JD 요건을 항목별로 뽑아 대응시켜라"는 규칙(규칙 2)을 준다. 그래서 다음을 **보장하지 못한다**.

| 질문 | 지금(단일 호출) | 에이전트 |
|---|---|---|
| JD 요건을 실제로 분석했나 | 모델이 머릿속으로 했다고 믿을 뿐 | 패널 JD 단계(`buildJdPrompt`)로 `JdAnalysis`(R1… 요건 ID) 생성·저장 |
| 요건마다 근거를 찾았나 | 그래프가 16K자에서 잘리면 근거 누락 | 요건마다 결정적 검색(`retrieve`/`rerank`)으로 근거 노드 선별 |
| 각 문장의 출처가 있나 | 없음 | 모든 불릿에 근거 노드 ref(E1…) 인용, 인용 없는 주장은 제거 |
| 지어낸 숫자를 막나 | 프롬프트 규칙뿐 | 인용 근거에 없는 숫자 → `[ADD: 수치 확인 — …]`(포트폴리오 `unverifiedNumbers` 방식) |
| 심사위원 기준을 통과하나 | 확인 안 함 | 핵심 심사(ATS·서류 담당·팀장) + 적합도(`computeMatchScore`)로 라운드마다 심사, 통과 기준까지 수정 반복, 최종본은 7명 전원 심사 |
| 부족한 요건을 알려 주나 | `missingInfo` 문장 | 요건별 충족/부분/공백 표 + 그래프 채팅 질문 링크 |

사용자의 질문 "지금 JD 기반으로 분석해서 해당 JD에서 요구하는 사항으로 이력서 작성 되는거 맞아?"에 대한 답을, 에이전트 도입 뒤에는 **"예 — 요건별 근거·충족 여부·심사 점수를 리포트로 보여 준다"**로 만든다.

### 0.1 "예"라고 말할 수 있는 근거(검증 가능한 연결 고리)
1. JD 요건 목록은 모델의 머릿속이 아니라 **저장된 `JdAnalysis`(R1…)** 다(§2.2). 리포트의 요건 표 행 수 = `mustHave + niceToHave` 수.
2. 요건마다 **결정적 검색 결과**(`byRequirement`)와 **plan의 strong/partial/gap 판정**이 저장된다(§2.3–2.4). gap은 지어내지 않고 질문으로 남는다.
3. 최종본의 요건 충족 여부는 작성 모델이 아니라 **별도 심사 단계 `fit`** 이 이력서 텍스트만 보고 판정하고, 점수는 코드(`scoreFit`)가 다시 계산한다(§2.7). 즉 "JD대로 썼다"는 주장을 쓴 쪽이 아닌 제3자가 채점한다.
4. 테스트로 고정한다: 가짜 LLM 통합 테스트에서 "모든 must 요건이 리포트 `requirements`에 정확히 한 번 나오고, status가 `met`/`partial`이면 `resumeLine`이 최종 문서에 실제로 있는 줄"임을 확인한다(§6.1).

---

## 1. 목표와 사용자 흐름

### 1.1 목표
1. JD(없으면 직무명으로 추정한 요건)의 **모든 필수·우대 요건을 명시적으로 다룬다**: 근거가 있으면 이력서 앞쪽에 배치하고 JD 용어로 쓰고, 근거가 없으면 지어내지 않고 공백 질문으로 남긴다.
2. **그래프에 있는 사실만 쓴다**: 모든 서술 줄은 근거 노드를 인용하고, 서버가 검증한다.
3. **심사위원 패널을 통과하도록 다듬는다**: 기존 진단 패널의 핵심 심사(ATS·서류 담당·팀장 + 적합도)가 라운드마다 초안을 심사하고 수정자가 지적을 반영한다. 최종본은 7명 전원(경쟁 지원자·대표·리크루터·동료 추가)이 심사해 진단과 같은 "7명 중 n명 통과"로 보여 준다.
4. **과정을 보여 준다**: 단계별 진행, 라운드별 심사 점수, 바뀐 점, 남은 공백.
5. **Vercel Hobby(함수 1회 최대 300초)에서 끊기지 않게** 단계별로 저장하고 이어서 실행한다.

### 1.2 비목표
- 그래프를 수정하지 않는다(읽기 전용). 공백 보완은 그래프 채팅 후속 질문으로 사용자에게 넘긴다.
- 진단 재작성본(`source.kind === "diagnosis"`) 경로는 에이전트 대상이 아니다(기존 단일 초안 유지).
- 별도 작업 서버·큐(장기 실행 워커)를 두지 않는다.

### 1.3 사용자 흐름

```
/app/resumes/new (NewResumeForm)
  출처: [경험 그래프에서] ─ 작성 방식: (●) AI 에이전트로 작성 (권장)   ( ) 빠른 초안(1회)
                                    └ 그래프에 노드가 있고 RESUME_AGENT 켜짐이면 기본값
  [초안 만들기] → POST /api/resumes { …, source:{kind:"graph"}, mode:"agent" } → 202 { agentJob }
        │
        ▼
/app/resumes/agent/[id] (AgentProgress)
  ① JD 분석 ✓  필수 7 · 우대 4 · 키워드 18
  ② 경험 검색 ✓  근거 찾은 요건 9/11 (필수 6/7)
  ③ 전략 ✓  포지셔닝: "결제 지연을 줄여 온 백엔드 개발자" · 프로젝트 3개 선택, 2개 제외
  ④ 초안 작성 ✓  사실 검증: 수치 확인 2건 · 근거 없는 줄 1개 제외
  ⑤ 심사 1회차 ✓  핵심 심사 1/3 통과 · 적합도 62 · ATS REJECT(키워드 누락 4)
  ⑥ 수정 1회차 … (진행 중, 42초)
  ⑦ 최종 심사(심사위원 7명 — 최종본만)  ⑧ 저장
  ── 라운드 점수표 ──  1회차 1/3·62 → 2회차 3/3·78 (목표 달성)
  [지금까지 가장 좋은 초안 미리 보기 ▸]   [취소]
  (다음 단계 대기 중일 때) "다음 단계를 준비하고 있습니다. 화면을 닫아도 이어서 진행합니다."
        │ 완료(알림 resume-agent-completed)
        ▼
/app/resumes/[id] (ResumeEditor) + [심사 리포트] 카드(AgentReport)
  - 최종 심사: 심사위원 7명 판정·한 줄 평(진단과 같은 "7명 중 n명 통과")
  - 라운드별: 핵심 심사 3명 판정·적합도·바뀐 점(전/후)
  - 요건 표: R1 Kafka 운영 경험 — 충족 — "주문 이벤트 파이프라인…" ← 프로젝트 '주문 시스템 개편'
  - 남은 공백: R5 "AWS 비용 최적화 경험" → [그래프 채팅에서 답하기] (/app/graph?ask=…#graph-chat)
  - 수치 확인 필요: [ADD: 수치 확인 — …] 2건
```

- 진행 화면을 떠나도 계속된다(단계 연쇄는 서버가 한다, §3). 끝나면 상단 알림. 연쇄가 막힌 환경(비밀 미설정·배포 보호)에서는 다음에 앱을 열 때 이어서 진행한다(§3.5).
- 실패하면 "실패한 단계부터 다시 시도" 버튼. 초안까지 만든 뒤 심사·수정 단계에서 실패하면 **가장 좋은 검증 초안을 저장**하고 리포트에 "심사 미완료"로 표시(§6.3).
- 그래프가 비었거나 에이전트가 꺼져 있으면 폼은 기존 단일 초안만 보여 준다.
- 화면 상태 전체 목록은 §4.4 "UX 상태 표"에 둔다.

---

## 2. 에이전트 파이프라인

### 2.0 전체 구조

```
round 0:  jd ─► retrieve ─► plan ─► write_body ─► write_top(+verify) ─► review
round k:  (stop 판정) ─► revise(expand+patch+verify) ─► review          (k = 1..MAX_REVISIONS)
끝:       final_panel(최종본에 독자 4명 추가 심사) ─► finalize(저장·리포트·알림)
```

| 단계 키 | 종류 | LLM | effort | maxTokens | 단계 시간 상한 | STEP_ESTIMATE | 비고 |
|---|---|---|---|---|---|---|---|
| `jd` | 패널 JD 재사용 | 1회 | medium | 32,000 | 120s | 60s | `buildJdPrompt` 그대로 |
| `retrieve` | 결정적 검색 | 0회 | – | – | 30s | 10s | Neo4j 읽기 1회 + 메모리 계산 |
| `plan` | 근거 매핑·전략 | 1회 | medium | 24,000 | 150s | 90s | task `resume-agent-plan` |
| `write_body` | 초안(경력·프로젝트·학력·자격·기타) | 1회 | medium | 32,000 | 230s | 180s | task `resume-agent-write` |
| `write_top` | 초안(헤드라인·요약·핵심 성과·기술) + 결정적 `verifyDraft` | 1회 | low | 16,000 | 150s | 90s | task `resume-agent-write` |
| `review` | 핵심 심사 | 4회 병렬 | medium | 32,000×4 | 200s | 120s | ats·gatekeeper·manager·fit |
| `revise` | 결정적 재검색 → 지적 반영(패치) → 결정적 `verifyDraft` | 1회 | medium | 24,000 | 200s | 150s | task `resume-agent-revise` |
| `final_panel` | 최종본 추가 심사 | 4회 병렬 | low(`RESUME_AGENT_READER_EFFORT`) | 32,000×4 | 200s | 120s | rival·ceo·recruiter·teammate. 핵심 4명 출력은 선택 라운드 것을 재사용 |
| `finalize` | 저장·리포트·알림 | 0회 | – | – | 30s | 15s | |

- 작성 단계를 `write_body`/`write_top` 두 번으로 나눈 이유: 한 번에 전체 문서(+사고 토큰)를 쓰면 출력 1.5~2만 토큰 이상이 나와 230초 안에 못 끝날 수 있다. 나누면 호출당 출력이 6~10K 토큰 안팎이다.
- 사실 검증(`verifyDraft`)과 공백 재검색(`expand`)은 LLM이 없는 수 밀리초~수백 밀리초 계산이라 **독립 단계로 두지 않는다**. 각각 앞뒤 LLM 단계 출력에 결과를 함께 저장한다(`write_top.output.verify`, `revise.output.expand`/`verify`). 단계 행·리스 획득·연쇄 경계가 줄어 실패 지점이 감소한다. 순수 함수 단위 테스트는 그대로 둔다.
- 수정은 전체 문서를 다시 쓰지 않고 **경로 단위 패치**로 받는다(출력이 작고, "바뀐 점"이 그대로 diff가 된다).
- 모든 LLM 호출은 `createLlmClient(provider, { userId, referenceId: jobId })` 하나의 클라이언트로(사용량은 작업 id로 묶인다), `withLlmDeadline`(`src/lib/llm/deadline.ts`)으로 단계 시간 상한을 건다. `withLlmDeadline`은 상한에 걸리면 `FeatureError(504)`를 던지므로 단계 러너는 이를 "시간 초과(재시도 가능)"로 분류한다.
- **v1 범위 밖**(플래그·후속 과제): 선택적 LLM 사실 검증(`resume-agent-verify`), LLM 재순위(`graph-qa-rerank` 재사용), 연결 진단의 JD 분석 재사용(JD 해시 컬럼이 없어 마이그레이션이 더 필요).
- 새 코드 위치: `src/lib/resume-agent/`
  - `schemas.ts`(zod 계약, 클라이언트·서버 공용 순수) · `job-types.ts`(화면용 타입·단계 라벨)
  - `steps/jd.ts` · `steps/retrieve.ts` · `steps/plan.ts` · `steps/write.ts` · `steps/review.ts`(review·final_panel 공용) · `steps/revise.ts` · `steps/finalize.ts`
  - 순수 모듈: `evidence.ts`(근거 묶음 만들기·직렬화·expand) · `citations.ts`(경로·인용 검증) · `verify.ts`(`verifyDraft`) · `patch.ts`(수정 패치 적용) · `stop.ts`(종료 판정) · `next-step.ts` · `report.ts`(리포트 모델)
  - `prompts.ts`(plan·write·revise 프롬프트) · `jobs.ts`(작업 행·리스·연쇄) · `chain.ts`(내부 호출 서명·origin) · `http.ts`(라우트 공용: 레이트 리밋, 예약)

### 2.1 공통 계약(`src/lib/resume-agent/schemas.ts`)

```ts
/** 근거 ref: 프롬프트에서는 E1, E2 … 짧은 ID만 쓴다. 실제 Neo4j id는 서버의 evidence pack에만 있다. */
export const EvidenceRefSchema = z.string().regex(/^E\d{1,3}$/);

/** 문서 경로(줄 단위): JSON 포인터 비슷한 고정 문법. citations.ts가 문서에 실제로 있는 경로인지 확인한다.
 *  심사 지적의 위치(locateQuote)·수정 패치(revise)·변경 기록에 쓴다. */
export const DocPathSchema = z.string().regex(
  /^(summary|basics\.(tagline|totalExperience)|highlights\[\d+\]\.(title|context)|experience\[\d+\]\.(scope|bullets\[\d+\])|projects\[\d+\]\.(summary|problem|action|result|evidence|bullets\[\d+\])|skills\[\d+\]\.detail|extras\[\d+\]\.items\[\d+\]|education\[\d+\]\.note)$/,
);

/** 인용 경로(항목 단위): 항목의 모든 줄이 이 인용을 물려받는다. 줄 경로(DocPath)도 허용해 더 좁게 달 수 있다. */
export const CitePathSchema = z.union([
  DocPathSchema,
  z.string().regex(/^(summary|highlights\[\d+\]|experience\[\d+\]|projects\[\d+\]|skills\[\d+\]|extras\[\d+\]\.items\[\d+\]|education\[\d+\]|certifications\[\d+\])$/),
]);

export const CitationSchema = z.object({
  path: CitePathSchema,
  refs: z.array(EvidenceRefSchema).min(1).max(8),
  /** 이 항목이 대응하는 JD 요건 ID(R1…). 없으면 빈 배열. */
  requirementIds: z.array(z.string().max(8)).max(6),
});
```

- **인용 단위는 항목**이다. v1은 줄마다 citation을 달게 했는데, 경력 3개×불릿 5개 + 프로젝트 4개×7칸 + 핵심 성과·요약·기술이면 100~200개, 출력 토큰만 8~12K가 되어 `write_body` 시간 상한(230s)을 위협한다. 항목 단위면 보통 15~30개다.
- 줄의 근거 = 그 줄 경로의 인용 ∪ 가장 가까운 상위 항목 인용(`citations.ts` `refsForLine(path)`). 수치·기술명 검증(§2.6)은 이 합집합의 근거 텍스트로 한다.
- 라운드가 진행되며 `revise`의 replace/insert는 줄 경로 인용(`refs`)을 붙이므로 수정된 줄은 더 좁은 근거를 가진다.

### 2.2 a) JD 분석 — 단계 `jd`

- **입력**: `CreateResumeInput`의 `roleTitle`, `company`, `jdText`(공고에서 시작했으면 `withResumePostingDefaults`로 채운 값), 지원 상황(`situation`: 기본 `general`, 그래프에 Role이 없으면 `new_grad`).
- **처리**: `buildJdPrompt(input: DiagnosisInput)`(`src/lib/panel/prompts.ts`)를 그대로 쓴다. JD는 이미 `neutralize` + `<job_posting>` 태그로 감싸진다.
  - JD가 없으면 같은 함수가 `source: "inferred"`로 직무명 기반 일반 요건을 추정한다(요건마다 jdQuote=null, 리포트에 "추정" 배지).
  - ~~연결 진단 재사용~~ → **v1 범위 밖.** 진단 행에 JD 텍스트 해시가 없어 "같은 JD"를 확인하려면 마이그레이션이 더 필요하다. 절약은 호출 1회(약 $0.09·40초)뿐이다. 후속 과제로 둘 때도 조회는 `diagnosis_stages`에서 `userId` 조건으로만 한다.
  - `buildJdPrompt`는 `infoSection`(지원 직무·상황·메모)과 JD만 쓰고 `resumeText`는 읽지 않는다(9378ba3 기준 확인). 그래서 `DiagnosisInput.resumeText = ""`로 넘긴다. `targetRole`에는 `"{company} {roleTitle}"`이 아니라 `roleTitle`만 넣고 회사명은 메모(`notes`)에 "지원 회사: …"로 넣는다(진단 경로와 같은 방식인지 구현 때 `src/lib/diagnoses`의 입력 구성과 맞춘다).
  - **JD 길이**: 패널 프롬프트(`buildJdPrompt`·심사 단계)는 `jdText`를 자르지 않고 그대로 넣는다. 에이전트는 모든 단계에 같은 JD를 넣어야 요건 ID·인용(`jdQuote`)이 일치하므로, 작업 시작 시 한 번 `neutralize` 전 원문을 `AGENT_JD_MAX_CHARS = 12_000`자로 잘라 `input.jdText`에 저장하고 이후 단계는 이 값만 쓴다.
- **출력**: `JdAnalysisSchema`(`src/lib/domain/schemas.ts`) — `mustHave`/`niceToHave`(R1…), `keywords`, `responsibilities`, `hiddenSignals`, `seniority`, `summary`.
- **후처리(결정적)**: `RequirementSignals` 계산 — 이후 단계가 쓰는 검색 질의 묶음.

```ts
export const RequirementSignalSchema = z.object({
  id: z.string(),                 // R1… 또는 K1…(요건에 안 묶인 키워드), T1…(주요 업무)
  kind: z.enum(["must", "nice", "keyword", "responsibility"]),
  text: z.string(),
  query: z.string(),              // text + jdQuote + 관련 keywords(retrieve 질의)
  skills: z.array(z.string()),    // skillKey로 정규화한 기술 키(extractKeywords)
  category: RequirementSchema.shape.category.optional(),
});
```

- 저장: 단계 출력 `{ jd: JdAnalysis, signals: RequirementSignal[] }`.
- 토큰 예산: 입력 ≈ 시스템 6K(캐시) + JD ≤ 8K, 출력 2~4K.

### 2.3 b) 그래프 검색 — 단계 `retrieve`(LLM 없음)

**소유자 격리가 최우선이다.** 이 단계가 에이전트에서 그래프를 읽는 유일한 정상 경로이며(`revise` 안의 공백 재검색 `expand`도 같은 함수 `loadAgentGraph(job)`를 쓴다), 다음 순서를 반드시 지킨다.

```ts
// src/lib/resume-agent/evidence.ts — 이 함수 하나만 getCareerGraph를 부른다.
export async function loadAgentGraph(job: { userId: string }): Promise<CareerGraph> {
  return assertGraphOwner(await getCareerGraph(job.userId, { personName: null }), job.userId);
}
```

- `job.userId`는 **작업 행에서 읽은 값**만 쓴다(요청 본문·내부 호출 본문의 userId는 받지 않는다). 작업 조회는 항상 `where: { id, userId }`.
- 그래프 크기 상한: `MAX_NODES_PER_USER = 1000`(`src/lib/domain/graph.ts`) — 전체를 메모리에서 다룬다(Cypher 추가 없음, `retrieve.ts`와 같은 방식).

**처리(결정적)** — 기존 그래프 QA 검색기를 재사용한다.
1. 요건마다 `retrieve(graph, signal.query, { nowYear, paths })`(`src/lib/graph/retrieve.ts`) → `scoreCandidates`/`mmr`(`src/lib/graph/rerank.ts`)로 후보 순위.
   - 주의: `retrieve`·`analyzeQuery`는 **질문 문장**(의도 분석·조사 제거)에 맞춰져 있다. 요건 질의는 "Kafka 운영 경험 3년 이상" 같은 명사구라 의도가 비어 나올 수 있다. 질의 앞에 의도를 고정하는 접두("~ 경험을 보여 주는 프로젝트")를 붙이는 대신, `RetrieveOptions`에 `intents?: QueryIntent[]` 선택 인자를 추가해 `["project", "achievement"]`처럼 명시한다(그래프 QA 경로는 인자를 안 넘기므로 동작 불변 — `retrieve.golden.test.ts`로 고정).
   - 비용: 요건·키워드·업무 신호 ≤ 40개 × 노드 ≤ 1000개. 질의마다 색인을 다시 만들지 않도록 `retrieve`에서 색인 구성(`nodeFields`/BM25F 통계)을 `buildIndex(graph)`로 빼 한 번만 만든다(순수 리팩터, 결과 동일). 신호: BM25F 어휘(`lexical`), 기술 일치(`skill`, USED_SKILL로 쓴 노드 0.7), 소재 태그(`tag`), 의도(`intent`), 그래프 전파(`propagated`), 수치 성과(`metric`), 최근성(`recency`), 중심성, STAR 완성도(`completeness`).
2. 에이전트용 가중 보정(`evidence.ts` `requirementScore`):
   `score = detScore(signals) + 0.15·mustBonus + 0.10·structureCompleteness(assessProjectStructure) + 0.10·hasMetric`
   요건당 상위 `K_PER_REQ = 5`, 같은 앵커(`anchorOf`) 최대 2개.
3. 기술 대조: `matchGraphToRequirements(graph, requirementsFromJd(jd, jdText).requirements)`(`src/lib/graph/match.ts`) → 요건별 `proven | claimed | missing` 사전 판정.
4. **기본 포함 집합**(요건과 무관하게 이력서 뼈대에 필요): 모든 `Company`·`Role`(경력 타임라인), `Education`, `Certification`, 완성도 상위 프로젝트 6개, 수치가 있는 `Achievement` 상위 10개.
5. 문맥 확장: 고른 `Achievement`·`Experience`·`Skill`은 그 앵커 `Project`/`Role`/`Company`를 함께 넣는다(`personPaths` 경로 텍스트로 "어느 회사의 어떤 프로젝트에서"를 붙인다).
6. 상한: `PACK_MAX_NODES = 80`, `PACK_MAX_CHARS = 28_000`(노드 텍스트는 `graphToText`의 `propCaps` 방식으로 속성 길이를 자른다: `[1000, 400, 200, 60, 0]`). 넘치면 nice/keyword 요건 근거 → 기본 포함 프로젝트 순으로 자른다.
7. **LLM 재순위는 v1에 넣지 않는다.** plan 단계의 모델이 pack 안에서 어차피 근거를 다시 고르므로(§2.4) 재순위 호출과 효용이 겹친다. 실측에서 "근거는 있었는데 pack에 못 들어간" 사례가 많으면 그때 `graph-qa-rerank`를 요건 묶음 1회로 붙인다.
8. `graphFingerprint` = sha256(노드 수 + 관계 수 + 최대 `updatedAt`). Person 속성은 넣지 않는다.

**출력 스키마**

```ts
export const EvidenceItemSchema = z.object({
  ref: EvidenceRefSchema,             // E1…
  nodeId: z.string(),                 // Neo4j id(서버 전용, 프롬프트에 넣지 않음)
  label: NodeLabelSchema,
  name: z.string(),
  path: z.string(),                   // "나 → 회사 A → 백엔드 개발자 → 주문 시스템 개편"
  text: z.string(),                   // 프롬프트에 들어가는 속성 텍스트(잘린 것)
  period: z.string(),                 // "2022.03 ~ 현재"
  skills: z.array(z.string()),        // 이 노드가 USED_SKILL로 쓴 기술 정식 명칭
  hasMetric: z.boolean(),
  completeness: z.number().min(0).max(1),
});

export const EvidencePackSchema = z.object({
  version: z.number().int(),          // retrieve=1, revise의 expand가 새 근거를 더할 때마다 +1
  graphFingerprint: z.string(),       // 노드 수 + 최대 updatedAt 해시(그래프가 실행 중 바뀌었는지)
  items: z.array(EvidenceItemSchema).max(120),
  byRequirement: z.array(z.object({
    requirementId: z.string(),
    refs: z.array(EvidenceRefSchema).max(8),
    skillStatus: z.enum(["proven", "claimed", "missing", "n/a"]),
    topScore: z.number(),
  })),
  coverage: z.object({ mustFound: z.number(), mustTotal: z.number(), niceFound: z.number(), niceTotal: z.number() }),
  truncated: z.boolean(),
});
```

- 진행 화면에는 `coverage`만 보인다("근거 찾은 요건 9/11").
- 이후 단계는 **저장된 evidence pack만 쓴다**(호출마다 그래프를 다시 읽지 않음 → 여러 함수 호출에 걸친 실행에서도 같은 자료를 본다). 그래프가 바뀌었는지는 `revise`의 expand가 fingerprint로 확인하고 리포트에 적는다. pack의 최신본은 "가장 최근 `revise.output.pack` 또는 `retrieve.output`"이다(`next-step.ts` `currentPack(steps)`).
- **pack이 너무 작을 때**(must 근거 0개이고 노드 < 5): 단계 요약에 경고("근거가 적어 대부분 질문으로 남습니다")를 남기고 그대로 진행한다(§6.3). must 요건 근거가 0개이고 그래프에 Project·Role이 모두 0이면 retrieve 단계에서 `insufficient_graph`로 실패시키고 진행 화면에 "그래프 채팅으로 경험부터 정리" 링크 + "빠른 초안으로 만들기"를 보인다(LLM 비용을 쓰기 전에 멈춘다).
- Person 노드의 이름·연락처·사진·링크는 pack에 넣지 않는다(§5.3).

### 2.4 c) 근거 매핑·전략 — 단계 `plan`

- **입력**: `JdAnalysis`, `RequirementSignal[]`, evidence pack(`<career_graph>` 태그 안에 `E1 [프로젝트] 주문 시스템 개편 (나 → 회사 A → …) 2022.03~2023.01 | situation: … | action: … | result: …` 형식), 양식(`RESUME_TEMPLATES[templateId]`), 지원 회사·직무.
- **프롬프트 요지**(system은 고정해 캐시):
  1. 요건마다 근거 ref를 고르고 `strong | partial | gap`으로 판정한다. 근거 텍스트에 없는 것은 gap이다(직무명·기술 보유만으로 strong 금지 — `claimed`는 최대 partial).
  2. 포지셔닝 한 문장과 headline(직무명만), 섹션 강조 순서를 정한다.
  3. 포함할 경력·프로젝트(대표 2~4개)와 **뺄 항목과 이유**(직무 무관, 중복, 사소한 일화 — draft.ts 규칙 9의 수상·기타 기준을 그대로 적용). 규칙 9는 공유 작성 기준 `src/lib/resumes/extras-guide.ts`(카테고리별 한 줄 형식·뺄 것·경력자/신입 순서·묶음 규칙)에서 만들고, verify가 사소한 일화·경력/프로젝트 중복 기타 줄을 결정적으로 지우며(`trivial_extra`·`duplicate_extra`), finalize가 묶음 규칙(빈 묶음 생략, 2개 이하면 '수상·기타' 하나, 묶음 안 최신순)을 적용한다. 지원 동기(`motivation`)는 에이전트가 쓰지 않는다(빈 문자열).
  4. JD 키워드마다 "어느 섹션에서, 어느 근거로" 쓸지(근거 없는 키워드는 쓰지 않음).
  5. gap 요건마다 사용자에게 물을 질문 한 개(그래프 채팅으로 보낼 문장).
- **출력 스키마**

```ts
export const ResumeAgentPlanSchema = z.object({
  positioning: z.string().max(300),
  headline: z.string().max(60),
  requirementMap: z.array(z.object({
    requirementId: z.string(),
    status: z.enum(["strong", "partial", "gap"]),
    refs: z.array(EvidenceRefSchema).max(6),
    angle: z.string().max(200),            // 이 근거를 어떤 표현·JD 용어로 쓸지
  })),
  include: z.object({
    experience: z.array(z.object({ ref: EvidenceRefSchema, emphasis: z.enum(["high", "medium", "low"]) })).max(12),
    projects: z.array(z.object({ ref: EvidenceRefSchema, why: z.string().max(160), requirementIds: z.array(z.string()) })).max(6),
    extras: z.array(z.object({ ref: EvidenceRefSchema, reason: z.string().max(120) })).max(8),
  }),
  exclude: z.array(z.object({ ref: EvidenceRefSchema, reason: z.string().max(120) })).max(40),
  keywordPlan: z.array(z.object({ keyword: z.string(), section: z.string(), ref: EvidenceRefSchema })).max(30),
  sectionEmphasis: z.array(z.string().max(160)).max(8),
  gapQuestions: z.array(z.object({ requirementId: z.string(), question: z.string().max(200) })).max(12),
});
```

- **결정적 검증**(`steps/plan.ts`): ref가 pack에 없으면 버림, requirementId가 JD에 없으면 버림, 모든 must 요건이 requirementMap에 없으면 `gap`으로 채움, `skillStatus === "missing"`인데 `strong`이면 `partial`로 내림(증거 강도 상한).
- 토큰 예산: 입력 ≈ 6K(시스템) + pack ≤ 9K 토큰 + JD 분석 2K, 출력 3~6K. task `resume-agent-plan`.

### 2.5 d) 초안 작성 — 단계 `write_body`, `write_top`

- **입력**: plan, evidence pack(plan이 include·requirementMap에 쓴 ref와 그 앵커만 — 보통 30~50개), JD 분석 요약, 양식 메모(`buildResumeDraftPrompt`의 performance 양식 메모 재사용), `RESUME_WRITING_CRITERIA_PROMPT`(`src/lib/resumes/writing-guide.ts`).
- **규칙**(draft.ts SYSTEM 규칙 1~9를 공유 모듈로 빼서 재사용: `src/lib/resumes/draft-rules.ts`의 `RESUME_FACT_RULES`. 단일 초안 `buildResumeDraftPrompt`도 같은 상수를 import해 **두 경로의 사실 규칙이 갈라지지 않게** 한다 — 기존 draft 프롬프트 스냅샷이 바뀌지 않음을 테스트로 확인):
  - 경력·프로젝트·핵심 성과·학력·자격 항목마다, 그리고 요약·기술 칸마다 `citations`에 항목 경로와 ref를 단다(§2.1). 근거가 없는 항목·줄은 쓰지 않는다.
  - 수치·기간·회사명·기술명은 인용한 근거 텍스트에 있는 것만. 모르면 `[ADD: …]`.
  - requirementMap의 strong/partial 요건을 앞쪽(최근 경력 첫 불릿, 대표 프로젝트)에, JD 용어로.
  - 연락처·이름은 쓰지 않는다(서버가 채운다). `basics.email/phone/name`은 빈 문자열.
- **출력 스키마**

```ts
const Doc = ResumeDocumentSchema; // src/lib/domain/resumes.ts
export const AgentBodyDraftSchema = z.object({
  experience: Doc.shape.experience,
  projects: Doc.shape.projects,
  education: Doc.shape.education,
  certifications: Doc.shape.certifications,
  extras: Doc.shape.extras,
  citations: z.array(CitationSchema).max(60),
  notes: z.array(z.string()).max(10),
});
export const AgentTopDraftSchema = z.object({
  basics: Doc.shape.basics.pick({ headline: true, tagline: true, totalExperience: true, portfolioUrl: true }),
  summary: Doc.shape.summary,
  headings: Doc.shape.headings,
  highlights: Doc.shape.highlights,
  skills: Doc.shape.skills,
  citations: z.array(CitationSchema).max(30),
  missingInfo: z.array(z.string()).max(10),
});
```

- 구조화 출력 문법 크기: `ResumeDocumentSchema` 일부 + citations 정규식이면 Anthropic 문법 상한에 걸릴 수 있다. 이미 있는 "grammar-too-large 대체 경로"(스키마 없이 JSON 지시 → zod 파싱)를 그대로 타며, `CitePathSchema` 정규식은 구조화 출력용 스키마에서는 `z.string().max(40)`로 느슨하게 두고 **서버 파싱 때만** 정규식을 건다(`citations.ts`).

- `write_top`은 `write_body` 결과(본문 텍스트 + citations)를 입력으로 받아 요약·핵심 성과가 본문과 어긋나지 않게 한다.
- 서버가 둘을 합쳐 `AgentDraft = { document: ResumeDocument, citations: Citation[], notes, missingInfo }`를 만든다. **citations는 내부 필드**로 단계 출력에만 남고 이력서 저장 시 제거된다.
- 문서 경로는 `citations.ts` `resolvePath(doc, path)`로 실제 존재하는지 확인하고, 없는 경로의 인용은 버린다.
- 토큰 예산: body 입력 ≈ 6K + 근거 6~8K, 출력 6~10K / top 입력 ≈ 6K + 본문 4K, 출력 2~4K.
- `basics.portfolioUrl`·`links`는 모델이 쓰지 않는다 — 그래프 `Project.url`·연결된 공개 GitHub 저장소 주소에서 서버가 붙인다(포트폴리오 `graph-material.ts`와 같은 원칙).

### 2.6 e) 사실 검증 — `verifyDraft`(결정적, `write_top`·`revise` 끝에서 실행)

입력: `AgentDraft`, evidence pack. 출력: 검증된 `AgentDraft`와 `VerifyReport`(해당 단계 출력에 함께 저장).

결정적 검사(`src/lib/resume-agent/verify.ts`, 순수 함수 `verifyDraft(draft, pack)` — 단위 테스트 대상):
1. **인용 없는 줄**: 서술 경로(§2.1 `DocPathSchema`에 해당하는 칸)의 비어 있지 않은 값에 `refsForLine`이 빈 배열이면 → 제거하고 `dropped`에 기록. 단, `[ADD: …]`만 있는 줄은 유지.
   - **대량 제거 방지**: 서술 줄 중 제거 비율이 `MAX_DROP_RATIO = 0.25`를 넘으면 제거하지 않고 단계를 `citation_missing`으로 1회 재시도한다(같은 단계 안, 프롬프트에 "인용 없는 항목: …" 목록을 덧붙임). 재시도 뒤에도 넘으면 제거하고 리포트 `notes`에 "근거를 찾지 못해 n줄을 뺐습니다"를 남긴다. 제거 후 경력·프로젝트가 모두 비면 단계 실패(재시도 대상).
2. **수치**: `unverifiedNumbers(stripPlaceholders(line), citedSourceText)`(`src/lib/portfolios/graph-material.ts`에서 `src/lib/text/numbers.ts`로 옮겨 공유, 포트폴리오는 re-export로 동작 불변) — 인용 근거 텍스트(노드 text + period)에 없는 숫자가 있으면 `[ADD: 수치 확인 — 원문]`으로 바꾸고 missingInfo에 "그래프에도 적어 주세요" 문장을 더한다. 날짜 칸(`startDate`/`endDate`)과 `basics.totalExperience`는 4번 규칙·서버 계산으로 다루므로 이 검사에서 뺀다.
3. **기술명**: `projects[].techs`, `skills[].items`의 각 항목은 `skillKey`가 pack의 Skill 노드 또는 인용 노드의 `skills`/텍스트에 있어야 한다. 없으면 제거.
4. **경력 뼈대**: `experience[].company`/`title`/`startDate`/`endDate`는 인용한 Role·Company 노드 값과 같아야 한다(날짜는 `YYYY.MM` 정규화 비교). 다르면 그래프 값으로 고친다(사실 원천은 그래프).
5. **인용 ref 유효성**: pack에 없는 ref는 버리고, 남은 ref가 없으면 1번 규칙으로.
6. **requirementIds 정합성**: plan이 gap으로 둔 요건을 "충족"처럼 인용한 줄은 `riskyClaims`로 표시.

7. **리더십·최상급 표현**(결정적): "주도", "리드", "총괄", "단독", "최초", "유일"이 있는 줄인데 인용 근거 텍스트에 같은 어간(또는 `role`/`ownership` 속성)이 없으면 `riskyClaims`에 넣는다. 고치지는 않고 **review 단계의 지적과 함께 revise에 넘긴다**(심사위원 지적과 같은 경로로 처리, 별도 LLM 호출 없음).

~~선택적 LLM 검사~~ → **v1 범위 밖.** 위 7번 + 심사위원(teammate·manager)이 과장 표현을 이미 지적하므로 v1에서는 별도 `resume-agent-verify` 호출을 두지 않는다. 실측에서 근거 밖 주장이 남으면 그때 effort low 1회 호출(대상 ≤ 30줄, `{ path, supported, fix }`)을 붙인다.

```ts
export const VerifyReportSchema = z.object({
  numbersFlagged: z.array(z.object({ path: DocPathSchema, numbers: z.array(z.string()) })),
  dropped: z.array(z.object({ path: DocPathSchema, text: z.string(), reason: z.enum(["uncited", "invalid_ref", "unknown_skill"]) })),
  corrected: z.array(z.object({ path: z.string(), before: z.string(), after: z.string() })),
  riskyClaims: z.array(z.object({ path: DocPathSchema, text: z.string(), reason: z.enum(["gap_requirement", "ownership", "superlative"]) })),
  retriedForCitations: z.boolean(),
});
```

### 2.7 f) 심사위원 패널 리뷰 — 단계 `review`(라운드마다) · `final_panel`(최종본 1회)

- **심사 대상 텍스트**: `resumeToText(document, templateId)`(`src/lib/resumes/layout.ts`). 연락처는 아직 비어 있으므로 심사용 렌더에서만 `basics.email = "[계정 메일 — 저장 시 채움]"`(계정 메일이 있을 때), 이름은 "지원자"로 넣는다(실제 값은 LLM에 보내지 않는다).
- **재사용**: `buildAtsPrompt`, `buildGatekeeperPrompt`, `buildReaderPrompt(reader)`, `buildFitPrompt`, `STAGE_SCHEMAS`, `normalizeStageOutput`(fit 점수 재계산) — 입력 `PanelInput = { resumeText, resumeFileName: null, targetRole, jdText, situation, notes }`, `outputs = { jd }`. 패널 코드를 복사하지 않고 `steps/review.ts`가 `buildStagePrompt(stage, input, outputs)` → `llm.generate({ stage, schema: STAGE_SCHEMAS[stage], … })` → `normalizeStageOutput`를 그대로 부른다(`runPipeline`의 단계 하나 실행부를 `runPanelStage(stage, input, outputs, llm, signal)`로 export해 진단 파이프라인과 공유).
- **패널 구성(v2)**:
  - `review`(매 라운드): **핵심 4회** — `ats`·`gatekeeper`·`manager`·`fit`. 서류 통과를 실제로 가르는 심사(자동 필터 → 서류 담당 → 팀장)와 요건 적합도다. 라운드 비교·종료 판정은 늘 같은 4개로 하므로 점수가 일관된다.
  - `final_panel`(선택된 최종본 1회): 나머지 독자 4명 — `rival`·`ceo`·`recruiter`·`teammate`. 선택 라운드의 핵심 4명 출력과 합쳐 **"7명 중 n명 통과"**를 만든다(진단 화면과 같은 기준). 최종본이 바뀌지 않으므로 이 지적은 수정에 쓰지 않고 리포트에만 싣는다.
  - `RESUME_AGENT_PANEL=full`이면 매 라운드 7명+fit(v1 방식, 비교용). 기본값은 `core`.
- **패널 프롬프트 확장(작은 변경)**: `PanelInput`에 `draftMode?: boolean` 추가 → 심사 단계(ats·gatekeeper·readers·fit) task 문장 끝에 rescreen과 같은 안내("`[ADD: …]`는 지원자가 아직 채우지 않은 자리표시다… `[계정 메일 — 저장 시 채움]`이 있으면 연락처는 있는 것으로 본다")를 붙인다. 진단 경로는 `draftMode` 없음 → 출력 변화 없음(진단 프롬프트 문자열 스냅샷 테스트로 고정).
- **실행**: 4개 호출을 `Promise.allSettled`로 병렬. 사용량 기록은 task `resume-agent-review` + stage(예: `manager`)로 남긴다 — `GenerateRequest`(현재 `task?: undefined`)에 `usageTask?: LlmTask` 선택 필드를 추가하고 `usage.ts`의 `task: req.task !== undefined ? req.task : (req.usageTask ?? "diagnosis")`로 기록(가짜 LLM·프롬프트 분기는 stage 기준 그대로). jd 단계도 같은 방식으로 `resume-agent-jd`를 기록한다.
- **프롬프트 캐시**: 패널 system 프롬프트(`SYSTEM_PROMPT`)는 진단과 같아 캐시 적중이 기대되지만, 같은 라운드의 병렬 호출은 서로의 캐시 쓰기를 기다리지 않으므로 이력서 부분(user 앞부분) 캐시는 라운드 간에도 적중하지 않는다(문서가 바뀜). 그래서 review 호출은 `cacheUser: false`로 보내 캐시 쓰기 할증을 피한다.
- **후처리(결정적)**:
  - `fit.matchScore`는 `scoreFit(jd, fit)`(`src/lib/panel/fit-score.ts`, 내부 `computeMatchScore`)로 다시 계산.
  - 모든 quote(`reasons[].quote`, `weakestLines[].quote`, `worstLine.quote`, `fit.items[].evidenceQuote`)를 `verifyQuote(resumeText, quote)`로 확인. 실패한 quote의 지적은 `quoteVerified: false`로 남기되 **수정 대상 경로를 특정하지 못하므로** "전체 지적"으로만 reviser에 넘긴다.
  - quote → 문서 경로 역매핑(`citations.ts` `locateQuote(doc, quote)`: 정규화(`normalizeForQuote`) 후 각 경로 값과 부분 일치) → 지적마다 `paths`.
  - 판정 집계: `isPositiveVerdict(reviewer, verdict)`(`src/lib/domain/reviewers.ts`)로 통과 수, ATS `keywordsMissing`.
  - 심사위원별 점수(화면용 0~100): 긍정 100 / 중립(MAYBE) 50 / 부정 0, fit은 matchScore. 라운드 점수 = `panelScore = round(0.6·핵심통과수/3·100 + 0.4·matchScore)`(핵심 = ats·gatekeeper·manager). `RESUME_AGENT_PANEL=full`이면 분모 7.
  - 주의: 리더의 `PASS`는 거절이다. 통과 판정은 반드시 `isPositiveVerdict(reviewer, verdict)`로만 한다(문자열 비교 금지 — 단위 테스트로 고정).
- 일부 호출이 실패하면: `review`는 **ats와 fit 둘 다 성공해야** 집계한다(종료 판정에 필수). gatekeeper·manager 중 하나가 실패하면 성공한 것으로 집계하고 `incomplete: true`, 그 라운드 panelScore는 실패한 심사위원을 중립(50)으로 계산한다. 단계 안에서 실패한 호출만 1회 다시 보낸다(성공한 출력은 단계 행 `output.partial`에 저장해 재시도 때 다시 부르지 않는다). `final_panel`은 실패한 독자를 리포트에 "심사 못 함"으로 표시하고 단계는 성공으로 둔다.
- **출력 스키마**

```ts
export const ReviewIssueSchema = z.object({
  id: z.string(),                         // "r1-manager-1"
  reviewer: ReviewerIdSchema.or(z.literal("fit")),
  severity: z.enum(["critical", "major", "minor"]),
  quote: z.string().nullable(),
  quoteVerified: z.boolean(),
  paths: z.array(DocPathSchema),
  issue: z.string(),
  requirementId: z.string().nullable(),
  /** 근거가 그래프에 없어 문장으로 못 고치는 지적(→ 질문). */
  needsUserInfo: z.boolean(),
});
export const ReviewRoundSchema = z.object({
  round: z.number().int(),
  verdicts: z.array(z.object({ reviewer: ReviewerIdSchema, verdict: z.string(), positive: z.boolean(), oneLiner: z.string() })),
  passCount: z.number().int(),
  matchScore: z.number().int(),
  fitItems: z.array(FitItemSchema),
  atsKeywordsMissing: z.array(z.string()),
  issues: z.array(ReviewIssueSchema).max(60),
  panelScore: z.number().int(),
  atsPass: z.boolean(),
  incomplete: z.boolean(),
  raw: z.record(z.string(), z.unknown()),  // 각 심사위원 원출력(StageOutputs 형태) — 리포트 상세용, 7일 뒤 삭제
});
```

- `needsUserInfo` 판정(결정적): fit에서 `missing`인 요건이고 evidence pack `byRequirement`에 ref가 없거나 plan이 `gap`이면 true.
- `verifyDraft`의 `riskyClaims`는 `reviewer: "fit"`이 아닌 별도 출처 `"verify"`의 minor 지적으로 issues에 합친다(`ReviewIssueSchema.reviewer`에 `z.literal("verify")` 추가).

### 2.8 g) 수정 루프 — 단계 `revise`(expand → patch → verify) → `review`

**종료 판정(`stop.ts`, 순수)** — 각 `review` 뒤에 평가한다.

```ts
export const STOP_RULES = {
  atsMustPass: true,     // ATS PASS 필수
  minCorePass: 2,        // 핵심 3명(ats·gatekeeper·manager) 중 통과 수. ATS 포함 → 실질적으로 gatekeeper·manager 중 1명 이상
  minMatchScore: 75,     // jd.source === "jd"일 때. "inferred"면 70
  maxRevisions: 2,       // 심사는 최대 3회(초안 1 + 수정 2)
  minGain: 3,            // panelScore 개선이 이보다 작으면 멈춤
} as const;
// RESUME_AGENT_PANEL=full이면 minCorePass 대신 minPass: 5(7명 중)
```

- 멈춤 사유: `passed`(목표 달성) | `plateau`(개선 < minGain 또는 점수 하락) | `max_rounds` | `only_user_gaps`(남은 critical/major 지적이 모두 `needsUserInfo`) | `budget`(작업 토큰 상한 초과 또는 다음 단계 시작 전 남은 작업 시간 부족) | `canceled`는 멈춤 사유가 아니라 작업 상태다.
- `only_user_gaps`는 **round 0에도** 적용한다. 고칠 수 있는 지적이 없는데 수정 라운드를 돌면 비용만 쓴다.
- **최종본 = 가장 높은 panelScore 라운드의 문서**(마지막 라운드가 아닐 수 있다). 동점이면 나중 라운드. 종료 판정은 `nextStep`이 같은 저장 행으로 다시 계산해도 같은 답이 나와야 한다(순수·결정적, 시각을 입력으로 받지 않음 — 예산 판정에 쓰는 사용 토큰은 단계 행의 `usage` 합계로 계산).
- 환경 변수로 조정: `RESUME_AGENT_MAX_REVISIONS`(0~2), `RESUME_AGENT_MIN_FIT`.

**expand(결정적, `revise` 단계 맨 앞)**: fit이 `missing`/`partial`로 본 요건과 ATS `keywordsMissing`마다 `retrieve`를 다시 돌린다(`loadAgentGraph(job)` — 같은 `getCareerGraph(job.userId)` + `assertGraphOwner`, 요건당 K=3, 컷오프 완화 `noCutoff`). 새로 찾은 노드를 pack에 `E{n+1}…`로 더하고 `version += 1`(기존 ref 번호는 바꾸지 않는다). 아무것도 못 찾으면 해당 요건을 `needsUserInfo`로 확정. 그래프 fingerprint가 바뀌었으면 리포트에 "실행 중 그래프가 바뀌어 새 내용으로 이어서 썼습니다"를 남긴다. 그래프 읽기는 라운드당 1회다(수정 라운드 ≤ 2).

**patch(LLM, task `resume-agent-revise`)**
- 입력: 현재 문서(경로 번호가 붙은 텍스트: `[experience[0].bullets[1]] …`), citations, plan, evidence pack(현재 인용 ref + expand로 새로 찾은 ref + 지적 관련 요건 ref), 지적 목록(`<panel_feedback>` 데이터 태그 — 심사 출력도 사용자 자료에서 나온 텍스트이므로 데이터로 다룬다), 이전 라운드에서 시도했다가 점수가 떨어진 패치 요약(되풀이 방지).
- 규칙: 지적은 **근거 pack 안에서만** 고친다. `needsUserInfo` 지적은 고치지 말고 `questions`로 돌린다. 경로 밖을 고치지 않는다. 수치는 인용 근거에 있는 것만.
- 출력(패치):

```ts
export const RevisePatchSchema = z.object({
  ops: z.array(z.discriminatedUnion("op", [
    z.object({ op: z.literal("replace"), path: DocPathSchema, value: z.string().max(600), refs: z.array(EvidenceRefSchema).min(1), issueIds: z.array(z.string()) }),
    z.object({ op: z.literal("insert"), path: DocPathSchema, value: z.string().max(600), refs: z.array(EvidenceRefSchema).min(1), issueIds: z.array(z.string()) }),
    z.object({ op: z.literal("remove"), path: DocPathSchema, issueIds: z.array(z.string()), reason: z.string().max(160) }),
    z.object({ op: z.literal("reorder"), section: z.enum(["experience", "projects", "highlights", "skills"]), order: z.array(z.number().int()).max(20), issueIds: z.array(z.string()) }),
    z.object({ op: z.literal("addProject"), ref: EvidenceRefSchema, project: ResumeDocumentSchema.shape.projects.element, citations: z.array(CitationSchema).max(12), issueIds: z.array(z.string()) }),
    z.object({ op: z.literal("setSkills"), skills: ResumeDocumentSchema.shape.skills, citations: z.array(CitationSchema).max(30), issueIds: z.array(z.string()) }),
  ])).max(40),
  questions: z.array(z.object({ requirementId: z.string().nullable(), question: z.string().max(200) })).max(10),
  summary: z.string().max(400),   // 이번 라운드에서 무엇을 왜 바꿨는지
});
```

- `patch.ts` `applyPatch(doc, citations, ops)`(순수): 경로 검증, 문서 스키마 상한(`ResumeDocumentSchema`) 재검증, 적용한 op마다 `ChangeRecord` 생성 → 리포트의 "바뀐 점".
  - op 적용 순서: `remove`/`insert`는 배열 인덱스를 바꾸므로 **같은 배열 안에서는 인덱스 내림차순**으로 적용하고, `reorder`는 마지막에 적용한다. op의 경로는 모두 "패치 전 문서" 기준이다(모델에 그렇게 지시하고 테스트로 고정).
  - 잘못된 op(없는 경로·pack 밖 ref·스키마 상한 초과)는 그 op만 버리고 `rejectedOps`에 남긴다. 전부 버려지면 op 0개와 같다.

```ts
export const ChangeRecordSchema = z.object({
  round: z.number().int(),
  op: z.enum(["replace", "insert", "remove", "reorder", "addProject", "setSkills"]),
  path: z.string(),                       // reorder는 섹션 이름
  before: z.string().nullable(),          // insert/addProject는 null
  after: z.string().nullable(),           // remove는 null
  issueIds: z.array(z.string()),
  reviewers: z.array(z.string()),         // issueIds에서 역산
});
```

- 그 뒤 `verifyDraft` → 다음 라운드 `review`. 수정이 유효한 op를 하나도 내지 않으면 review를 건너뛰고 `plateau`로 멈춘다(심사 4회 비용 절약).
- 토큰 예산: 입력 ≈ 6K + 문서 4K + 근거 6K + 지적 3K, 출력 3~6K.

### 2.9 h) 저장·리포트·알림 — 단계 `finalize`

1. 최종 라운드 문서 선택(§2.8) → 서버 후처리:
   - `basics.name` ← 계정 이름(비었을 때), `basics.email` ← 로그인 메일(비었거나 `[ADD:…]`만 있을 때) — `generateResumeDraft`의 `personEmail` 처리와 같은 규칙. 이 값들은 어떤 LLM 호출에도 들어가지 않았다.
   - `includePhoto`는 기존 이력서 기본값 그대로(사진은 LLM에 안 감).
   - 링크: 그래프 `Project.url`·공개 GitHub 저장소에서.
   - citations 제거 → `StoredResumeDocumentSchema.parse`.
2. 저장: `saveNewResume(userId, input, document, material)`(`src/lib/resumes/create.ts`) — note "경험 그래프 에이전트로 만든 AI 초안", version source `ai`. 연결 공고가 지워졌으면 postingId=null(초안 작업과 같은 처리).
3. 저장 직전 소유 확인(`runId`·리스 조건부 update) — 버려진 실행이 이력서를 만들면 지운다(`discardResume`와 같은 처리).
4. 리포트(`report.ts` `buildAgentReport`) → `resume_agent_jobs.report`:

```ts
export const AgentReportSchema = z.object({
  version: z.literal(1),
  jd: z.object({ source: z.enum(["jd", "inferred"]), roleTitle: z.string(), company: z.string().nullable(), mustTotal: z.number(), niceTotal: z.number() }),
  rounds: z.array(z.object({ round: z.number(), passCount: z.number(), matchScore: z.number(), panelScore: z.number(),
    verdicts: ReviewRoundSchema.shape.verdicts, changes: z.array(ChangeRecordSchema).max(60), summary: z.string() })),
  chosenRound: z.number(),
  /** 최종본 7명 심사(핵심 3명 = 선택 라운드 재사용 + final_panel 4명). final_panel 실패 시 그 독자는 verdict=null. */
  finalPanel: z.object({
    passCount: z.number().int(), total: z.literal(7),
    verdicts: z.array(z.object({ reviewer: ReviewerIdSchema, verdict: z.string().nullable(), positive: z.boolean(), oneLiner: z.string() })),
  }).nullable(),
  stopReason: z.enum(["passed", "plateau", "max_rounds", "only_user_gaps", "budget", "review_failed"]),
  /** 작성 시점 기준임을 화면에 표시하기 위해 저장 시각을 둔다(사용자가 이후 문서를 고치면 줄 인용이 어긋날 수 있다). */
  generatedAt: z.string(),
  requirements: z.array(z.object({
    requirementId: z.string(), text: z.string(), must: z.boolean(),
    status: z.enum(["met", "partial", "missing"]),           // 최종 라운드 fit 기준
    resumeLine: z.string().nullable(),                        // 이 요건을 다룬 이력서 줄
    evidence: z.array(z.object({ name: z.string(), label: NodeLabelSchema, path: z.string() })).max(4), // nodeId 없음
  })),
  gaps: z.array(z.object({ requirementId: z.string().nullable(), question: z.string(), chatPrompt: z.string() })).max(15),
  factCheck: z.object({ numbersFlagged: z.number(), dropped: z.number(), corrected: z.number() }),
  excluded: z.array(z.object({ name: z.string(), reason: z.string() })).max(20),
  notes: z.array(z.string()).max(10),
  graphChanged: z.boolean(),
});
```

   - `gaps[].chatPrompt`: `graphChatPrompt(skill, { company, roleTitle })`(`src/lib/graph/match.ts`)와 같은 형식의 문장 → 화면에서 `graphChatHref(prompt)`(`src/components/graph/api.ts`, `/app/graph?ask=…#graph-chat`)로 연결. 그래프 채팅이 답을 받으면 기존 후속 질문 흐름(`src/lib/chat/followups.ts`, 주제 기반 중복 제거)이 그대로 동작한다.
   - `missingInfo`(이력서 편집 화면 기존 표시)에는 gaps 질문 + 수치 확인 문장을 합쳐 최대 10개.
5. 알림: `notify(userId, { kind: "resume-agent-completed", title: "AI 에이전트 이력서가 완성됐습니다", body: "회사 · 직무 — 심사 5/7 통과 · 적합도 78 · 채울 정보 3개", link: "/app/resumes/{resumeId}?report=1" })`. 실패는 `resume-agent-failed`, link는 진행 화면. 알림은 finalize의 소유 확인 update가 1행일 때만 보낸다(중복 알림 방지).
6. 정리: `input`(JD 포함)은 완료 시 지우고, 단계 출력(근거 텍스트·JD·심사 원출력)은 완료 7일 뒤 `output = null`(리포트만 남김). 정리는 별도 크론 없이 기존 초안 작업 보존 정리(`startResumeDraftJob` 안의 `deleteMany`)와 같은 자리 — 사용자가 새 작업을 시작할 때 그 사용자 행만 — 에서 한다.
7. **리포트 노출**: `report`는 `resume_agent_jobs`에 있고, 이력서 편집 페이지(`src/app/app/resumes/[id]/page.tsx`, 서버 컴포넌트)가 `findFirst({ where: { resumeId, userId, status: "completed" }, orderBy: { completedAt: "desc" } })`로 직접 읽어 `AgentReport`에 넘긴다(별도 API 라우트 없음). 이력서를 지우면 `resumeId`가 null이 되어 리포트도 보이지 않는다.

---

## 3. 실행 모델(Vercel Hobby)

### 3.1 제약
- 함수 1회 최대 300초(`maxDuration = 300`, 리터럴). `after()`도 같은 시간 안에서만 돈다(`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md`: after는 라우트의 maxDuration까지 실행, Vercel은 `waitUntil`로 연장).
- 장기 워커·큐 없음. 전체 에이전트는 8~15분 걸릴 수 있으므로 **여러 함수 호출에 나눠** 실행해야 한다.
- `after()`의 시간은 **요청 시작 시각부터** 센다. 그래서 `deadlineAt = 요청 시작 + 270s`를 라우트 첫 줄에서 계산해 넘긴다(`runDeadline(startedAt, 300)` 재사용).
- 진단 파이프라인도 같은 제약을 이미 겪는다: `runner.ts`는 시간 예산에 걸리면 멈추고 진행 화면이 `?continue=1`로 이어 간다. 에이전트는 이 방식을 기본 안전망으로 그대로 쓰고, 화면이 없어도 이어 가도록 자기 호출을 더한다.

### 3.2 선택한 방식: "한 호출 안에서는 시간이 허락하는 만큼 단계 진행 + 경계에서 서명된 내부 자기 호출로 연쇄 + 진행 화면·알림 폴링이 안전망"

```
POST /api/resumes (mode=agent)
  └ startResumeAgentJob → 202 → after(() => advanceAgentJob(jobId, {deadlineAt}))
advanceAgentJob(jobId):
  loop:
    next = nextStep(job)                       # 단계 행에서 계산(멱등)
    if !next: break
    if remaining(deadlineAt) < STEP_ESTIMATE[next.kind] + 15s:
        release lease; job.state = "waiting"; chainNext(job); return
    claim lease(step) → run step with deadline = min(stepCap, remaining - 15s)
    persist output (조건: runId·leaseId 일치) → release
  finalize 끝나면 completed
chainNext(job):
  continuations += 1 (조건부 update, MAX_CONTINUATIONS 넘으면 failed)
  RESUME_AGENT_CHAIN_SECRET 있고 chainOrigin() != null이면
    fetch(`${chainOrigin()}/api/internal/resume-agent/advance`, { body: {jobId, runId, exp}, headers: { x-agent-signature: HMAC, [x-vercel-protection-bypass] } })
    → 202만 기다린다(AbortSignal.timeout(5s)). 실패하면 job.chainError에 남기고 끝(안전망이 이어 간다).
안전망(모두 "이어서 실행해 달라"는 신호만 보내고, 실제 단계 실행은 advance 라우트의 after()에서만):
  1) 진행 화면 폴링(GET /api/resumes/agent-jobs/[id]) — 응답에 needsKick=true면 화면이 POST …/advance
  2) 이력서 목록·새 이력서 화면 서버 렌더 — 내 waiting 작업이 IDLE_KICK_MS(30초) 넘게 머물면 chainNext 1회
  3) 알림 sweep(`src/lib/notifications/sweep.ts`) — 2)와 같은 조건으로 chainNext 1회. 알림 스트림 함수 안에서 단계를
     직접 돌리지 않는다(스트림 수명·응답이 LLM 시간에 묶이면 안 됨). 비밀이 없으면 sweep은 아무것도 하지 않는다.
```

- **호출 수 추정**: 단계 시작 조건(`remaining ≥ STEP_ESTIMATE + 15s`)과 270s 예산으로 묶으면, 전형적 실행(수정 1회)은 `[jd·retrieve·plan] → [write_body] → [write_top] → [review·revise] → [review] → [final_panel·finalize]` 약 6회 호출, 최대(수정 2회) 약 8회다. 한 호출 끝에서 다음 호출까지의 공백(콜드 스타트 + fetch)은 1~3초다.
- **최악의 경우**(비밀 없음·자기 호출 차단): 화면이 열려 있으면 진단과 같은 속도로 진행하고, 닫혀 있으면 `waiting`으로 멈춰 있다가 사용자가 앱을 다시 열 때 이어 간다. 이것을 실패로 처리하지 않는다(§3.5).

**대안과 비교**
| 방식 | 장점 | 단점 | 판단 |
|---|---|---|---|
| 진행 화면 폴링만으로 진행 | 단순, 인증 문제 없음 | 화면을 닫으면 멈춤(진단의 `?continue=1`이 이 방식) | 안전망으로만 |
| 단계 끝날 때마다 자기 호출 | 화면 없이 진행 | 호출 수 많음, 미리보기 배포 보호(Deployment Protection)에 막힐 수 있음 | 경계에서만 호출 |
| Vercel Cron | 독립적 | Hobby는 하루 1회 수준 → 부적합 | 사용 안 함 |
| Supabase pg_cron/queue에서 HTTP 호출 | 독립적 | 새 인프라 의존 | 이후 확장 후보 |

- **내부 자기 호출 인증**: `x-agent-signature = HMAC-SHA256(RESUME_AGENT_CHAIN_SECRET, "resume-agent.v1." + jobId + "." + runId + "." + exp)`, `exp`는 2분, 길이 확인 후 `timingSafeEqual` 비교. 라우트는 서명 확인 → `exp` 확인 → `where: { id: jobId, runId, status: in(running, waiting) }`로 행을 찾고 **그 행의 userId로만** 실행(본문에 userId는 없다). 같은 출처 검사(`assertSameOrigin`)는 이 라우트에서 서명으로 대신한다. 재전송(같은 서명을 2분 안에 다시 보냄)은 리스 획득이 막으므로 LLM 호출을 늘리지 못한다. 응답은 항상 202/401/404 중 하나이고 본문에 작업 정보를 싣지 않는다.
- **origin 결정(`chain.ts` `chainOrigin()`)** — 요청 Host 헤더를 신뢰하지 않는다.
  - `APP_ORIGIN`이 있으면 그것(자체 호스팅·커스텀 도메인).
  - `VERCEL_ENV === "production"`이면 `https://${VERCEL_PROJECT_PRODUCTION_URL}`.
  - `VERCEL_ENV === "preview"`이면 `https://${VERCEL_URL}`(**배포 고유 주소** — 미리보기가 운영과 같은 DB를 쓰더라도 운영 코드가 미리보기의 작업을 이어 실행하지 않게). 미리보기는 배포 보호가 켜져 있으므로 `VERCEL_AUTOMATION_BYPASS_SECRET`이 있을 때만 `x-vercel-protection-bypass` 헤더로 연쇄하고, 없으면 `null`(폴링 안전망만).
- **배포 버전 어긋남**: 작업 행에 시작한 배포 id(`VERCEL_DEPLOYMENT_ID`)를 남긴다. 운영 도메인으로 연쇄하면 실행 중 새 배포가 이어받을 수 있다. 단계 출력은 모두 zod 스키마로 저장·읽으므로, 이어받은 쪽이 이전 단계 출력을 **파싱하지 못하면 그 단계부터 다시 실행**한다(`next-step.ts`가 파싱 실패 행을 pending으로 본다). 스키마를 깨는 변경은 `schemas.ts`의 `AGENT_SCHEMA_VERSION`을 올리고, 버전이 다른 진행 중 작업은 "업데이트로 다시 시작이 필요합니다" 실패(재시도 가능)로 닫는다.
- 비밀이 없으면(`RESUME_AGENT_CHAIN_SECRET` 미설정) 자기 호출을 끄고 진행 화면/목록 렌더로만 이어 간다(로컬 개발·자체 호스팅은 시간 제한이 없어 한 호출에 끝난다 — `SELF_HOSTED` 예산 20분, 기존 `SELF_HOSTED_DRAFT_TIME_LIMIT_MS`와 같은 판정 함수 재사용).

### 3.3 멱등성·리스
- 작업 실행 식별: `runId`(다시 시도마다 새로). 모든 쓰기는 `where: { id, userId, runId, status in (running, waiting) }`.
- 단계 리스: `resume_agent_jobs.lease_id`, `lease_expires_at`. 획득은 조건부 update 하나:

```sql
UPDATE resume_agent_jobs
   SET lease_id = $new, lease_expires_at = now() + interval '60 seconds', status = 'running', updated_at = now()
 WHERE id = $job AND run_id = $run AND status IN ('running','waiting')
   AND (lease_id IS NULL OR lease_expires_at < now())
RETURNING *;
```
  (Prisma `updateManyAndReturn`, `draft-jobs.ts`의 `restartDraftJob`과 같은 방식. READ COMMITTED에서 경쟁하는 두 호출 중 하나만 성공.)
- 하트비트: 단계 실행 중 20초마다 `lease_expires_at = now() + 60s`로 연장(조건: lease_id 일치). 0행이면 `AbortController.abort(lost_ownership)`(panel `runner.ts`의 하트비트와 같음). 리스를 단계 상한만큼 길게 잡지 않는 이유: 함수가 강제 종료되면 하트비트가 멈추고 **60초 안에** 다른 호출이 이어받을 수 있어야 하기 때문이다(v1의 `cap + 60s`면 최대 약 5분 동안 아무도 못 이어받는다).
- 단계 완료 쓰기: `resume_agent_steps`의 `(job_id, key)` 고유 행을 `status='done'`으로 — 조건 `job.lease_id = 내 leaseId`(관계 필터 EXISTS). 이미 done이면 덮지 않는다 → 같은 단계가 두 번 돌아도 결과는 하나.
- 다음 단계 계산은 **저장된 단계 행만으로** 한다(`nextStep(steps, stopDecision)` 순수 함수) → 어느 호출이 이어받아도 같은 결정.
- 단계 시간 상한은 모두 **≤ 230초**(호출 예산 270초 = 300 − 30, `runDeadline` 재사용). 단계 시작 조건: `remaining ≥ STEP_ESTIMATE + 15초`. `STEP_ESTIMATE`는 §2.0 표의 값. 단계 실제 시간 상한 = `min(stepCap, remaining − 15s)`라서 추정이 빗나가도 함수가 강제 종료되기 전에 단계가 스스로 끊긴다(그 단계는 시간 초과 재시도).
  - 새 호출의 첫 단계는 `remaining ≈ 270s`이므로 모든 단계가 시작 조건을 만족한다(가장 큰 추정치 write_body 180s + 15s < 270s). 즉 **어떤 단계도 영원히 시작 못 하는 경우는 없다**.
  - 실제 소요를 단계 행 `startedAt`/`finishedAt`에 남기고, 관리자 사용량 화면에 단계별 p50/p95를 보여 추정치 조정 근거로 쓴다.
- **예상 소요 시간**(추정치 합, 대기 공백 제외): 수정 0회 ≈ 7분, 수정 1회 ≈ 11분, 수정 2회 ≈ 15분. 화면 안내 문구는 "보통 8~15분"으로 한다.
- LLM 시간 초과·`max_tokens`: 같은 단계 1회 자동 재시도(같은 호출 안에서 시간이 남으면, 아니면 다음 호출에서). 단계 행 `attempt`가 3에 이르면 그 단계를 실패로 확정(작업 failed, `failedStep`). `write_body`가 두 번 실패하면 세 번째 시도는 섹션을 더 잘게(`experience`만 / `projects`+나머지) 나눠 두 호출로 쓰는 대체 경로다.
- 영구 오류(`LlmPermanentError`: 인증·스키마 거부 등)는 재시도하지 않고 바로 실패로 확정한다.

### 3.4 다시 시도·취소
- `POST /api/resumes/agent-jobs/[id]/retry`: failed 작업을 새 runId로 — **완료된 단계는 건너뛰고 실패한 단계부터**(진단 `prepareRetry`와 같은 의미). 실패 단계 행만 `pending`·`attempt=0`으로 되돌린다. `?from=jd`(처음부터)는 입력이 남아 있을 때만. `?mode=single`은 같은 입력으로 기존 단일 초안 작업(`startResumeDraftJob`)을 시작하고 이 작업을 `canceled`로 닫는다(v1의 `fallback` 라우트 대체, §6.3).
- `POST …/cancel`: status `canceled`, 리스 해제. 진행 중 LLM 호출은 하트비트가 0행을 보고 중단. 이미 `finalize`가 이력서를 저장했으면 409("이미 완성됐습니다").

### 3.5 멈춤 판정
- `running`이면서 `lease_expires_at < now()` → 리스만 회수하고 `waiting`으로 바꾼다(그 단계는 `attempt`가 오른 채 다음 kick이 다시 시작). 함수가 300초에 강제 종료된 경우가 여기에 해당한다.
- `waiting`은 **시간이 지나도 실패로 만들지 않는다.** 연쇄가 막혀 있으면 사용자가 앱을 열 때(진행 화면·목록·알림 sweep) 이어 간다. 단, 마지막 진행(`updated_at`)에서 `AGENT_IDLE_FAIL_MS = 24시간`이 지나면 `failed`("오래 멈춰 있던 작업을 닫았습니다. 다시 시도하면 끝난 단계는 건너뜁니다.") + 실패 알림.
- 판정 지점: 진행 화면 GET, 이력서 목록(`listVisibleDraftJobs`가 에이전트 작업도 함께 반환, §4.1), 알림 sweep(`sweepStaleAgentJobs`). 모두 `userId` 조건의 조건부 update라서 여러 곳에서 동시에 판정해도 한 번만 바뀐다.
- 작업 전체 상한: 함수 호출 횟수 `MAX_CONTINUATIONS = 20`(전형 6~8회의 2.5배), 단계 `attempt` 3회. 넘으면 failed(무한 연쇄 방지). 벽시계 상한(v1의 45분)은 두지 않는다 — 화면을 닫은 정상 작업을 잘못 실패시키기 때문이다.

### 3.6 동시성·한도·비용
- 사용자당 동시 진행 에이전트 작업 `MAX_ACTIVE_AGENT_JOBS = 1`(running·waiting 모두 셈, AI 초안 작업 3개와 별도). 이미 있으면 409 + 기존 작업 id를 돌려주고 폼은 "진행 중인 에이전트 작업 보기"로 안내한다. 이력서 수 상한 확인(`assertResumeSlots`)은 에이전트 진행 작업(running·waiting)도 센다.
- 시작 예약은 트랜잭션 하나로: 레이트 리밋 소비 → 동시 작업 확인 → 슬롯 확인 → 작업 행·첫 단계 행 생성. 동시 요청 두 개가 둘 다 통과하지 않도록 `pg_advisory_xact_lock(hashtext('resume-agent:' || userId))`를 먼저 잡는다(기존 초안 작업 예약이 쓰는 방식이 있으면 그것을 재사용).
- 레이트 리밋(`src/lib/auth/db-rate-limit.ts`): `RESUME_AGENT_LIMIT = { bucket: "resume-agent", limit: 5, windowMs: 24h }` — 시작·사용자 재시도만 센다(자동 이어하기·kick·`retry?mode=single`은 세지 않음 — 단일 초안은 기존 `RESUME_DRAFT_LIMIT`(30/일)으로 센다). 한도 초과 시 429 + "오늘은 빠른 초안으로 만들 수 있어요" 안내.
- 작업당 토큰 상한: `AGENT_JOB_TOKEN_BUDGET = 500_000`(입력+출력, 캐시 읽기 제외). 다음 단계 추정치(`STEP_TOKEN_ESTIMATE`)가 남은 예산을 넘으면 `budget`으로 멈추고 가장 좋은 라운드로 마무리(final_panel은 예산이 남을 때만, 아니면 리포트 `finalPanel = null`).
- 비용 추정(기본 모델 `claude-opus-5-5`, `pricing.ts`: 입력 $4 / 출력 $20 / 캐시 읽기 $0.2 per MTok, 패널·plan·write system 프롬프트 캐시 적중 가정, 출력에는 effort에 따른 사고 토큰 포함):

| 단계 | 호출 | 입력(비캐시) | 출력 | 비용(대략) |
|---|---|---|---|---|
| jd | 1 | 8K | 3K | $0.09 |
| plan | 1 | 12K | 5K | $0.15 |
| write_body + write_top | 2 | 18K | 12K | $0.31 |
| review(1라운드, 핵심 4) | 4 | 8K×4 | 3K×4 | $0.37 |
| revise(1라운드) | 1 | 18K | 5K | $0.17 |
| final_panel(독자 4, effort low) | 4 | 8K×4 | 2K×4 | $0.29 |
| **전형: 심사 2라운드(수정 1)** | 17 | | | **약 $1.75** |
| **최대: 심사 3라운드(수정 2)** | 22 | | | **약 $2.3** |
| 참고: v1(매 라운드 8회, LLM 검증 포함) | 22~31 | | | 약 $2.1~3.1 |

  - 한도와 곱하면 사용자 1명 하루 최대 약 $12(5회 × $2.3). 관리자 사용량 화면에서 작업별 합계를 본다(§4.6).
  - 추가 절감 손잡이: `RESUME_AGENT_MAX_REVISIONS=1`, `RESUME_AGENT_READER_EFFORT=low`(기본), `RESUME_AGENT_PANEL=full`(정확도 비교용으로만, 비용 ↑).
  - CLI 엔진(provider ≠ anthropic)은 비용 null(기존 `usage.ts`와 같음), 시간이 더 걸리므로 `STEP_ESTIMATE` ×1.5. CLI 엔진은 Vercel에서 쓸 수 없으므로(자체 호스팅 전용) 연쇄 경로와 무관하다.

---

## 4. 데이터 모델·API·UI·알림·사용량

### 4.1 Prisma 모델(`prisma/schema.prisma`)

```prisma
model ResumeAgentJob {
  id              String    @id
  userId          String    @map("user_id")
  /// 실행 식별자(다시 시도마다 새로). 실행 중 쓰기는 run_id·status 조건으로.
  runId           String    @map("run_id")
  /// 'running' | 'waiting'(다음 호출 대기) | 'completed' | 'failed' | 'canceled'
  status          String    @default("running")
  /// 다음(또는 진행 중) 단계 키: "r0.jd", "r0.retrieve", …, "r2.review", "final_panel", "finalize"
  currentStep     String    @default("r0.jd") @map("current_step")
  round           Int       @default(0)
  label           String
  /// CreateResumeInput(+mode). 완료하면 null.
  input           Json?
  provider        String?
  error           String?
  /// 실패한 단계 키(다시 시도 시작점).
  failedStep      String?   @map("failed_step")
  resumeId        String?   @map("resume_id")
  /// AgentReport(완료 후에도 남김).
  report          Json?
  /// 진행 화면 요약: { coverage, rounds:[{round,passCount,matchScore,panelScore}], stopReason }
  progress        Json?
  usage           Json?     /// UsageTotals 누적
  leaseId         String?   @map("lease_id")
  leaseExpiresAt  DateTime? @map("lease_expires_at") @db.Timestamptz(3)
  graphFingerprint String?  @map("graph_fingerprint")
  /// 작업을 시작한 배포(VERCEL_DEPLOYMENT_ID)와 단계 출력 스키마 버전(§3.2 배포 버전 어긋남).
  deploymentId    String?   @map("deployment_id")
  schemaVersion   Int       @default(1) @map("schema_version")
  /// 마지막 자기 호출 실패 사유(관리자 진단용, 사용자에게 안 보임).
  chainError      String?   @map("chain_error")
  attempts        Int       @default(1)
  continuations   Int       @default(0)
  startedAt       DateTime  @default(now()) @map("started_at") @db.Timestamptz(3)
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime  @default(now()) @map("updated_at") @db.Timestamptz(3)
  completedAt     DateTime? @map("completed_at") @db.Timestamptz(3)
  user   User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  resume CompanyResume?    @relation(fields: [resumeId], references: [id], onDelete: SetNull)
  steps  ResumeAgentStep[]
  @@index([userId, status])
  @@index([userId, createdAt])
  @@index([resumeId])
  @@map("resume_agent_jobs")
}

model ResumeAgentStep {
  id         String    @id
  jobId      String    @map("job_id")
  key        String    /// "r0.jd" … (job 안에서 고유)
  kind       String    /// jd | retrieve | plan | write_body | write_top | review | revise | final_panel | finalize
  round      Int
  /// pending | running | done | failed | skipped
  status     String    @default("pending")
  /// 단계 출력(스키마 통과 JSON). 완료 7일 뒤 null로 비운다.
  output     Json?
  /// 화면용 작은 요약(예: { passCount, matchScore } / { coverage }).
  summary    Json?
  error      String?
  usage      Json?
  model      String?
  attempt    Int       @default(0)
  startedAt  DateTime? @map("started_at") @db.Timestamptz(3)
  finishedAt DateTime? @map("finished_at") @db.Timestamptz(3)
  job ResumeAgentJob @relation(fields: [jobId], references: [id], onDelete: Cascade)
  @@unique([jobId, key])
  @@map("resume_agent_steps")
}
```

- 마이그레이션: `prisma/migrations/20261122000000_resume_agent_jobs/migration.sql`(최신 `20261121000000_graph_followup_duplicate_reopened` 다음). `npx prisma generate`, 로컬 `npx prisma migrate deploy`(127.0.0.1:54330). Supabase는 RLS 사용 안 함(서버 전용 접근) — 기존 테이블과 같은 정책.
- 단계 출력 크기: evidence pack ≤ 약 60KB, review 원출력 ≤ 약 20KB/라운드(핵심 4명) → 작업당 ≤ 약 250KB jsonb.
- **기존 초안 작업과의 관계(중복 제거)**: 상태 기계(waiting·리스·단계 행)가 달라 `resume_draft_jobs`에 섞지 않고 테이블을 나눈다. 대신 화면·한도 로직은 한 곳에서 다룬다.
  - `src/lib/resumes/draft-jobs.ts`의 `listVisibleDraftJobs`는 두 테이블을 함께 읽어 `ResumeDraftJobView`(+ `mode: "single" | "agent"`, `href`) 하나의 배열로 돌려준다. `DraftJobsStrip.tsx`는 `href`만 쓰면 되므로 변경이 거의 없다.
  - `assertResumeSlots`는 초안 running + 에이전트 running·waiting을 합쳐 센다.
  - 보존 정리(`DRAFT_JOB_RETENTION_MS`)는 같은 상수로 두 테이블에 적용한다.
  - 기존 단일 초안 쿼리(`status: "running"` 기준 멈춤 판정 등)는 `resume_draft_jobs`에만 걸리므로 동작이 바뀌지 않는다.

### 4.2 입력 스키마 변경(`src/lib/resumes/types.ts`)
- `CreateResumeInputSchema`에 `mode: z.enum(["agent", "single"]).optional()` 추가. `source.kind === "graph"`이고 `mode`가 비었으면 서버 기본값 = `agentEnabled(user) ? "agent" : "single"`. `diagnosis` 출처는 항상 `single`. `mode=agent`인데 에이전트를 쓸 수 없으면(꺼짐·그래프 비어 있음) 조용히 `single`로 바꾸지 않고 응답에 `modeFallback: "agent_unavailable"`을 실어 폼이 "빠른 초안으로 만들었습니다" 안내를 띄우게 한다.

### 4.3 API 라우트

| 메서드·경로 | 파일 | 역할 | maxDuration |
|---|---|---|---|
| `POST /api/resumes` | `src/app/api/resumes/route.ts`(분기 추가) | `mode=agent`면 `startResumeAgentJob` → 202 `{ agentJob }`, after()로 `advanceAgentJob` | 300 |
| `GET /api/resumes/agent-jobs/[id]` | `…/[id]/route.ts` | 진행 상태(단계·라운드 점수·needsKick). 멈춤 판정 | – |
| `POST /api/resumes/agent-jobs/[id]/advance` | `…/[id]/advance/route.ts` | 사용자 세션 + same-origin. 리스가 비어 있으면 이어서 실행(레이트 리밋 없음, 하루 continuations 상한) | 300 |
| `POST /api/resumes/agent-jobs/[id]/retry` | `…/[id]/retry/route.ts` | 실패 단계부터 재시도(레이트 리밋 셈). `?from=jd` 처음부터, `?mode=single` 같은 입력으로 빠른 초안(§3.4) | 300 |
| `POST /api/resumes/agent-jobs/[id]/cancel` | `…/[id]/cancel/route.ts` | 취소 | – |
| `POST /api/internal/resume-agent/advance` | `src/app/api/internal/resume-agent/advance/route.ts` | HMAC 서명 내부 연쇄 | 300 |

- v1에서 뺀 라우트: 목록 GET(기존 `GET /api/resumes/drafts`가 에이전트 작업도 반환), `fallback`(→ `retry?mode=single`), `agent-report` GET(→ 이력서 페이지 서버 컴포넌트가 직접 조회, §2.9-7).
- `maxDuration = 300`은 **리터럴로** 각 라우트 파일에 쓴다(Next 정적 분석 요구 — 기존 라우트와 같음). `after()` 콜백 안에서는 요청 객체(`cookies()`/`headers()`)를 읽지 않는다: 필요한 값(userId, deadlineAt, origin)은 응답 전에 계산해 넘긴다.

- 모든 사용자 라우트: `requireApiUser`, 변경 메서드는 `assertSameOrigin`, 조회는 `where: { id, userId }`(남의 작업은 404). 응답은 `Cache-Control: no-store`.
- 화면용 뷰 타입(`src/lib/resume-agent/job-types.ts`): `ResumeAgentJobView { id, status, label, currentStep, steps: AgentStepView[], rounds: RoundScoreView[], coverage, stopReason, error, canRetry, needsKick, resumeId, startedAt, … }`. 뷰에는 근거 텍스트·JD 원문·노드 id를 싣지 않는다.

### 4.4 UI 컴포넌트
- `src/components/resumes/NewResumeForm.tsx`: 출처 `graph` 아래에 작성 방식 라디오(`AI 에이전트로 작성 — JD 요건별 근거를 찾고 심사위원 심사를 통과할 때까지 다듬습니다(보통 8~15분, 하루 5회)` / `빠른 초안 — 1~3분`). JD가 비어 있으면 "공고가 없으면 직무명으로 요건을 추정합니다" 보조 문구. 기본값: `graphAvailable && agentEnabled`. 202 응답의 `agentJob`이면 `/app/resumes/agent/[id]`로 이동.
- `src/app/app/resumes/agent/[id]/page.tsx` + `src/components/resumes/agent/AgentProgress.tsx`: 2초 폴링(30초 뒤 5초, 탭이 숨겨지면 폴링 중지 — `document.visibilityState`), `needsKick`이면 `POST …/advance`(한 번에 하나, 응답 전 재전송 없음). `DraftProgress.tsx`의 경과 시간·단계 표시(`formatElapsed`) 재사용.
  - **최선 초안 미리 보기**: round 0 `write_top`이 끝나면 뷰에 `previewText`(`resumeToText` 결과, 근거 텍스트·노드 id 없음)를 싣고 접힌 패널로 보여 준다. 사용자가 10분 넘게 빈 화면을 보지 않게 한다. 편집은 완료 후에만.
  - `AgentStepTimeline.tsx`: 단계별 상태·요약(근거 커버리지, 포지셔닝, 수치 확인 n건).
  - `AgentRoundScores.tsx`: 라운드 × 핵심 심사 3명 판정 칩 + 적합도 + panelScore, 목표선(ATS 통과·핵심 2/3·적합도 75). 최종 행에 7명 결과.
- `src/components/resumes/agent/AgentReport.tsx`: 이력서 편집 화면(`ResumeEditor.tsx`)의 "심사 리포트" 카드/탭(`?report=1`이면 펼침).
  - 요건 표(`RequirementCoverageTable.tsx`), 바뀐 점(`AgentChangeList.tsx`, 라운드별 전/후), 남은 공백(`AgentGapQuestions.tsx` — 각 질문에 `graphChatHref(chatPrompt)` 링크, "그래프를 채운 뒤 다시 실행" 버튼 → 같은 입력으로 새 작업. **새 이력서가 하나 더 생기고 하루 한도 1회를 쓴다**는 것을 버튼 옆에 적는다. 입력(JD)은 완료 때 지워지므로 이 버튼은 이력서의 `postingId`·회사·직무·현재 JD 칸 값으로 새 입력을 만든다), 제외 항목, 사실 검증 요약.
  - 심사위원 이름·판정 라벨은 `src/lib/domain/reviewers.ts`(`REVIEWERS`, `verdictLabel`) 재사용.
- `src/components/resumes/DraftJobsStrip.tsx`: 에이전트 작업도 띠에 표시(뷰의 `href`만 다름, §4.1).
- 리포트 상단에 "작성 시점(generatedAt) 기준 — 이후 편집한 내용은 반영되지 않습니다" 한 줄. 사용자가 문서를 고친 뒤에는 `resumeLine`이 문서에 더 없으면 그 줄을 흐리게 표시한다.

**UX 상태 표**(진행 화면·폼·리포트가 모두 처리해야 하는 상태)

| 상태 | 조건 | 화면 |
|---|---|---|
| 진행 중 | `running` | 단계 타임라인 + 경과 시간 + 취소 |
| 다음 단계 대기 | `waiting` | "다음 단계를 준비하고 있습니다. 화면을 닫아도 이어서 진행합니다." 연쇄 비밀이 없으면 "이 화면을 열어 두면 더 빨리 끝납니다" |
| 동시 작업 있음 | 시작 409 | 폼에 "진행 중인 에이전트 작업이 있습니다 — [보기]" |
| 한도 초과 | 시작 429 | "오늘 에이전트 작성 5회를 모두 썼습니다 — [빠른 초안으로 만들기]" |
| 이력서 수 상한 | `assertResumeSlots` 실패 | 기존 문구 그대로 |
| 그래프 부족 | retrieve `insufficient_graph` | "경험이 거의 없어 쓸 수 있는 내용이 적습니다 — [그래프 채팅으로 정리하기] [빠른 초안]" |
| 실패(재시도 가능) | `failed` + `input` 있음 | 실패 단계·사유 + [실패한 단계부터 다시] [빠른 초안으로 만들기] |
| 실패(입력 만료) | `failed` + `input` null | "작업 정보가 만료됐습니다 — 새로 만들어 주세요" |
| 취소됨 | `canceled` | "취소했습니다" + [새로 만들기] |
| 완료(목표 달성) | `stopReason = passed` | 이력서로 이동 + 리포트 펼침 |
| 완료(목표 미달) | `plateau`/`max_rounds`/`only_user_gaps` | 리포트 상단에 "목표 기준에는 못 미쳤습니다 — 채울 정보 n개를 답하면 올라갑니다" |
| 완료(예산 중단) | `budget` | "비용 상한에 걸려 n회차까지만 다듬었습니다" |
| 완료(심사 미완료) | `review_failed` 또는 `finalPanel = null` | "심사를 끝내지 못했습니다 — 진단에서 다시 심사할 수 있어요" + 진단 시작 링크 |
| 업데이트로 중단 | 스키마 버전 어긋남 | "서비스 업데이트로 다시 시작이 필요합니다" + [다시 시도] |

### 4.5 알림
- `src/lib/domain/notifications.ts` `NOTIFICATION_KINDS`에 `"resume-agent-completed"`, `"resume-agent-failed"` 추가. 실시간 전달은 기존 `notify()`(Supabase Realtime, `docs/REALTIME.md`) 그대로.
- 시간 예산으로 다음 호출을 기다리는 것(`waiting`)은 알리지 않는다. 진짜 실패·완료만.
- 알림 sweep(`sweepStaleJobs`)에 `sweepStaleAgentJobs(userId)`를 더한다: 리스 만료 회수, 24시간 멈춤 실패 처리, waiting 작업 kick(서명 fetch만, §3.2). 알림 스트림 수명 안에서 LLM을 기다리지 않는다.

### 4.6 사용량 추적·관리자
- `src/lib/llm/types.ts` `LLM_TASKS`에 `resume-agent-jd`, `resume-agent-plan`, `resume-agent-write`, `resume-agent-revise`, `resume-agent-review` 추가(`resume-agent-verify`는 v1 범위 밖). 패널 프롬프트 재사용 호출(jd·review)은 `GenerateRequest.usageTask`로 기록(§2.7) → 관리자 화면에서 진단 사용량과 섞이지 않는다.
- 모든 호출 `referenceId = jobId`. 단계 행 `usage`·`model`에도 남기고 작업 행 `usage`에 누적(`addUsage`).
- 관리자(`src/app/app/admin/usage/page.tsx`, `[userId]`): task 그룹에 "이력서 에이전트" 묶음 추가, 사용자 상세에서 referenceId별(작업별) 합계·라운드 수·stopReason 표(`src/lib/llm/usage-report.ts`에 `agentJobUsage(userId)` 추가). 사용자 화면에는 비용을 보이지 않는다.

---

## 5. 보안

### 5.1 사용자 간 격리(최우선)
1. 그래프 읽기는 `getCareerGraph(job.userId)` → 즉시 `assertGraphOwner(graph, job.userId)` → 그 다음에만 evidence pack을 만든다. 이 순서는 `evidence.ts` `loadAgentGraph(job)` **한 함수에만** 있고, `retrieve` 단계와 `revise`의 expand가 이 함수만 부른다. 소스 grep 테스트(`service.isolation.test.ts` 방식): `src/lib/resume-agent/**`에서 `getCareerGraph` 문자열이 `evidence.ts`의 `loadAgentGraph` 본문 밖에 나오면 실패, `loadAgentGraph` 본문에 `assertGraphOwner`가 없으면 실패.
2. `job.userId`는 DB 작업 행에서만. 라우트는 `where: { id, userId: session.user.id }`, 내부 호출은 서명된 jobId·runId로 행을 찾고 그 행의 userId를 쓴다.
3. 프롬프트에는 Neo4j id를 넣지 않고 `E1…` ref만. 모델이 낸 ref는 pack 사전으로만 해석(다른 노드에 닿을 방법 없음).
4. 연결 진단 JD 재사용, 공고 조회, GitHub 저장소 링크 조회 모두 `userId` 조건.
5. 리포트·뷰 응답에 노드 id·다른 작업 데이터 없음. 뷰 변환(`toAgentJobView`)은 허용 필드만 골라 담는 화이트리스트 방식이다(단계 `output`을 통째로 내보내지 않는다).
5-1. **심사 단계도 격리 대상이다.** 심사 프롬프트에 들어가는 것은 이 작업의 문서 텍스트 + 이 작업의 JD뿐이다. `review`가 `outputs`로 받는 `jd`는 같은 작업의 `r0.jd` 단계 행에서만 읽는다(진단 행 재사용은 v1 범위 밖이므로 다른 테이블을 읽지 않는다).
5-2. **로그**: 단계 실패 로그에는 작업 id·단계 키·오류 분류만 남기고 프롬프트·근거 텍스트·JD를 남기지 않는다(기존 `requestLabel` 방식).
5-3. **pack 재사용 금지**: evidence pack은 작업 단위로만 저장·조회한다(`where: { jobId }` + 작업 행 `userId` 확인). 사용자 간·작업 간 캐시를 두지 않는다.
6. 테스트: 사용자 A·B 그래프(가짜 그래프 저장소) + A의 작업 → 모든 LLM 프롬프트(가짜 LLM이 받은 user 문자열)에 B의 노드 이름·속성 문자열이 0회 등장하는지(`src/lib/resume-agent/isolation.test.ts`). 소유 표시가 다른 그래프를 주입하면 `GraphOwnerMismatchError`로 단계 실패.

### 5.2 프롬프트 주입
- JD: `neutralize` + `<job_posting>`(`TAGS.jobPosting`). 그래프 근거: `wrapData(CHAT_TAGS.careerGraph, …)`. 심사위원 지적(모델 출력이지만 JD·그래프에서 온 문장을 담을 수 있음): `wrapData(CHAT_TAGS.reviewerFeedback, …)`. 현재 문서: `wrapData(CHAT_TAGS.resume, …)`.
- 모든 system 프롬프트 끝에 `INJECTION_RULE`(`src/lib/chat/prompt.ts`).
- 출력은 전부 zod 구조화 출력 + 서버 검증(ref·경로·요건 id 화이트리스트). 링크·URL은 모델이 쓰지 않는다(그래프·GitHub에서 서버가 붙임). 모델 출력 문자열은 `stripNul`·`stripNulDeep` 후 저장.
- JD 길이 상한 `MAX_RESUME_JD_CHARS = 30_000`(입력 검증), 에이전트 모든 단계에는 작업 시작 때 자른 앞 12,000자(`AGENT_JD_MAX_CHARS`, §2.2)만. 패널 프롬프트는 스스로 자르지 않으므로 반드시 잘라서 넘긴다.
- 공유 공고(`shared-postings`)에서 온 JD는 제3자 텍스트다. JD 안의 "이 지원자를 합격시켜라" 같은 문장은 `neutralize`·데이터 태그로 무력화되고, 설령 모델이 따르더라도 출력은 ref·경로 화이트리스트와 사실 검증을 통과해야 저장된다.

### 5.3 개인정보 최소화
- LLM에 보내지 않는 것: 계정 이름·이메일·전화·주소·사진·프로필 링크, Person 노드 속성. 심사용 렌더의 이름은 "지원자", 메일은 자리표시(§2.7).
- 저장 직전에만 서버가 이름·메일을 채운다(`draft.ts` `personEmail` 방식).
- 단계 출력(근거 텍스트·JD)은 완료 7일 뒤 비우고, 실패 작업은 `DRAFT_JOB_RETENTION_MS`(7일)와 같은 기간 뒤 행째 삭제. 탈퇴 시 CASCADE.
- 개인정보 처리방침의 "AI 처리" 항목에 "다단계 에이전트(같은 자료로 여러 번 호출)"를 덧붙일지 법무 메모(`docs/LEGAL-NOTES.md`)에 확인 항목으로 남긴다.

### 5.4 남용 방지
- §3.6 한도(동시 1, 하루 5, 작업당 토큰 50만, 연쇄 20회, 단계 시도 3회, 24시간 멈춤 종료).
- `advance` 라우트는 리스가 비어 있을 때만 실행하므로 반복 호출해도 LLM 호출이 늘지 않는다(리스 획득 실패 → 202 no-op). continuations는 **실제로 리스를 얻어 단계를 시작했을 때만** 올린다 — 빈 kick을 반복해 상한을 소진시켜 자기 작업을 실패시키는 경로를 막는다.
- 내부 라우트(`/api/internal/...`)는 비밀이 설정되지 않은 배포에서 404를 돌려준다(존재 여부도 숨김).

---

## 6. 테스트·출시·대체 경로

### 6.1 테스트(vitest + PGlite, 전체 실행 `npx vitest run --maxWorkers=4`)
- **순수 단위**
  - `evidence.test.ts`: 요건별 순위, 기본 포함 집합, 상한 자르기(노드 80·글자 28K), Person 제외, ref 부여 안정성.
  - `citations.test.ts`: 경로 문법·해석, `locateQuote`(정규화 일치), 잘못된 경로 버림.
  - `verify.test.ts`: 인용 없는 줄 제거(항목 인용 상속 포함), 제거 비율 25% 초과 시 재시도 신호, 숫자 플래그(쉼표·`[ADD:]`·날짜 칸 무시), 기술명 검증(별칭 "리액트"↔"React"), 경력 뼈대 보정, riskyClaims.
  - `patch.test.ts`: op별 적용·같은 배열 안 인덱스 내림차순 적용·reorder 마지막·잘못된 op만 버림·스키마 상한·ChangeRecord.
  - `stop.test.ts`: passed / plateau / max_rounds / only_user_gaps(round 0 포함) / budget, 리더 `PASS`=거절 처리, 최종 라운드 선택(최고점·동점은 나중), op 0개면 review 없이 plateau.
  - `next-step.test.ts`: 단계 행 상태 → 다음 단계(재개·실패 단계부터·파싱 실패 행은 다시 실행·final_panel 예산 부족 시 건너뜀).
  - `chain.test.ts`: origin 결정(production/preview/APP_ORIGIN/없음), 서명 생성·검증(만료·위조·다른 runId·길이 다른 서명).
  - 패널 `draftMode` 스냅샷: 진단 경로 프롬프트가 바뀌지 않음. `runPanelStage` 추출 후 기존 `pipeline.test.ts`·`runner.test.ts` 통과.
  - `retrieve.golden.test.ts`: `intents` 인자 추가·`buildIndex` 추출 뒤에도 그래프 QA 결과 동일.
  - draft 프롬프트 스냅샷: `RESUME_FACT_RULES` 추출 뒤 단일 초안 프롬프트 동일.
- **가짜 LLM**(`src/test/fake-llm.ts`): 새 task(`resume-agent-*`) 처리 추가 — plan은 pack의 ref를 그대로 매핑, write는 근거 텍스트 줄을 그대로 불릿으로 + 의도적으로 지어낸 숫자 1개(검증이 잡는지), revise는 지적 경로에 replace op. 심사 단계는 기존 가짜 패널 재사용(1라운드 ATS REJECT → 2라운드 PASS 패턴으로 루프 검증).
- **통합(PGlite)** `src/lib/resume-agent/jobs.test.ts`
  - 시작 → advance를 여러 번(시간 예산을 작게 주입해 단계마다 끊기게) → 완료, 이력서 1개, 리포트 저장, 알림 1개.
  - 동시 advance 2개 → 리스 하나만, 단계 출력 하나만.
  - 실행 중 다시 시도(새 runId) → 예전 실행의 늦은 쓰기가 0행, 이력서 중복 없음(`discardResume`).
  - 멈춤 판정 → failed + 알림, 재시도는 실패 단계부터(이미 done인 jd·retrieve는 LLM 호출 0회).
  - 심사 실패 시 최고 검증 초안 저장 + `stopReason: "review_failed"`.
  - 레이트 리밋·동시 1개(동시 시작 요청 2개 → 1개만 성공)·이력서 상한(waiting 포함).
  - 리스 만료 회수: 단계 도중 "함수 강제 종료"(하트비트 중단 주입) → 60초 뒤 다른 advance가 이어받아 같은 단계를 다시 실행, 결과 하나.
  - waiting 장기 방치: 23시간은 그대로, 24시간 넘으면 failed + 알림 1개.
  - **JD 요건 반영 고정(§0.1)**: 모든 must 요건이 리포트 `requirements`에 정확히 한 번, `met`/`partial`이면 `resumeLine`이 최종 문서 텍스트에 실제로 있음, gap 요건에 대한 질문이 `gaps`에 있음.
  - 목록 통합: `listVisibleDraftJobs`가 단일 초안·에이전트 작업을 함께 돌려주고, 기존 단일 초안 테스트(`draft-jobs.test.ts`)가 그대로 통과.
- **격리** `isolation.test.ts`(§5.1-6), 내부 호출 서명(만료·위조·다른 runId 거부) `internal-advance.route.test.ts`.
- **UI**: `AgentProgress.test.tsx`(단계 상태·needsKick 시 advance 한 번만·waiting 문구·미리 보기·탭 숨김 시 폴링 중지·§4.4 상태 표의 각 상태 문구), `AgentReport.test.tsx`(공백 질문 링크가 `/app/graph?ask=…#graph-chat`), `NewResumeForm.test.tsx`(그래프 있으면 에이전트 기본 선택, 플래그 끄면 숨김).
- **실측(수동)**: 실제 Anthropic으로 대표 그래프 3종(신입·3년 차·전직) × JD 유/무 — 단계별 소요 p95, 토큰, 통과율, 지어낸 숫자 0건 확인. 결과를 이 문서 부록에 기록.

### 6.2 출시
- 환경 변수 `RESUME_AGENT`: `"0"` 끔 / `"admin"` 관리자만 / 그 밖(기본) 켬. 끄면 폼에서 옵션 숨김, `mode=agent` 요청은 `single`로 처리하고 `modeFallback`을 돌려준다(§4.2). `agentEnabled(user)`는 `graphEnabled()`도 요구.
- `RESUME_AGENT_CHAIN_SECRET`(32바이트 이상) 운영에 설정. 없으면 폴링 연쇄만(진행 화면을 열어 둘 것을 안내 문구로 표시).
- 단계적 공개: `RESUME_AGENT=admin`이면 기존 `ADMIN_EMAILS`(`isAdminEmail`, `src/lib/auth/admin-emails.ts`) 계정만 → 1주 실측 → `RESUME_AGENT=1`(전체). 실측에서 단계 p95가 상한의 80%를 넘으면 `STEP_ESTIMATE`·단계 분할 조정 후 공개. 그래서 `agentEnabled(user)`는 사용자를 인자로 받는다. 새 allowlist 비밀은 두지 않는다.
- 운영 체크리스트: `RESUME_AGENT_CHAIN_SECRET` 설정 → 운영 도메인에서 연쇄 1회 확인(관리자 화면의 `chainError`가 비어 있는지) → 미리보기는 `VERCEL_AUTOMATION_BYPASS_SECRET` 유무 확인.
- 지표: 완료율, 평균 라운드, stopReason 분포, 최종 통과 수·적합도 분포, 작업당 비용, 수치 플래그·제거 줄 수, 리포트 공백 질문 클릭률.

### 6.3 대체 경로(fallback)
- 그래프가 비었거나(노드 0) 저장소 미설정 → 에이전트 옵션 비활성, 기존 단일 초안(진단 출처) 또는 빈 문서.
- `jd`·`retrieve`·`plan`·`write_*` 실패(재시도 후) → 진행 화면에 "빠른 초안으로 만들기" 버튼(`POST …/retry?mode=single` → 같은 입력으로 `startResumeDraftJob`, §3.4).
- `write_top`(검증 포함)까지 성공했는데 `review`/`revise`가 실패 → 가장 좋은 검증 초안을 저장하고 완료로 처리(리포트 `stopReason: "review_failed"`, "심사를 끝내지 못했습니다 — 진단에서 다시 심사할 수 있어요" 안내 + 진단 시작 링크). 이 전환은 자동이다: 해당 단계가 `attempt` 3회에 이르면 `nextStep`이 바로 `finalize`를 고른다.
- `final_panel`만 실패 → 완료로 처리하고 리포트 `finalPanel = null`(핵심 심사 결과는 그대로).
- evidence pack이 너무 작다(필수 요건 근거 0개이고 노드 < 5) → plan 전에 경고 단계 요약("근거가 적어 대부분 질문으로 남습니다")을 보이고 그대로 진행(지어내지 않음). Project·Role이 모두 0이면 `insufficient_graph`로 LLM 호출 전에 멈춘다(§2.3).

---

## 7. 구현 순서(제안)

1. 공유 추출(동작 불변 리팩터): `RESUME_FACT_RULES`(draft.ts 규칙), `unverifiedNumbers` → `src/lib/text/numbers.ts`, `runPanelStage`(pipeline.ts), `retrieve`의 `buildIndex`·`intents` 인자, `PanelInput.draftMode`, `GenerateRequest.usageTask`. 기존 테스트·스냅샷 통과 확인.
2. 순수 모듈: `schemas.ts`, `evidence.ts`, `citations.ts`, `verify.ts`, `patch.ts`, `stop.ts`, `next-step.ts`, `chain.ts` + 단위 테스트.
3. 마이그레이션·`jobs.ts`(시작 예약·리스·advance 루프·멈춤·재시도·취소)와 `listVisibleDraftJobs`/`assertResumeSlots` 통합 + PGlite 통합 테스트(가짜 LLM).
4. 단계 구현(jd → retrieve → plan → write_body → write_top → review → revise → final_panel → finalize)과 프롬프트, 가짜 LLM 확장.
5. 라우트·내부 연쇄(서명·origin)·알림 종류·sweep·사용량 task.
6. UI(폼 옵션, 진행 화면, 리포트 카드, 목록 띠), 관리자 사용량.
7. 격리 테스트·실측·플래그 공개.

## 8. 열린 질문
- 핵심 패널(ats·gatekeeper·manager·fit)의 라운드 점수가 최종 7명 결과와 얼마나 맞는지 — 실측에서 `RESUME_AGENT_PANEL=full`과 비교해 상관이 낮으면 핵심 구성에 recruiter를 더한다(라운드당 +$0.09).
- 통과 기준(ATS PASS·핵심 2/3·적합도 75)이 실제 그래프 품질에서 달성 가능한지 — 실측 후 조정. 달성 불가 사례가 많으면 기준보다 "개선 폭"을 리포트의 주 지표로.
- 연쇄 신뢰성: 운영에서 자기 호출 실패율(`chainError` 비율)이 높으면 Supabase `pg_net`/`pg_cron`으로 waiting 작업을 1분마다 kick하는 방식을 추가한다(새 인프라 의존이라 v1에서는 보류).
- 공용 이력서(kind `general`, JD 없음)에도 에이전트를 기본으로 할지 — 추정 요건 기반이라 심사 효용이 낮을 수 있음.
- 진단 경로(재작성본 출처)를 에이전트의 심사·수정 루프에만 태우는 변형(그래프 근거 대신 재작성본 줄을 근거로)은 후속 과제.
