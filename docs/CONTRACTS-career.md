# 경력 그래프·채팅·이력서 기능 — 공통 계약

기반(Foundation) 작업이 만든 공유 타입·모듈과 파일 소유권. 기능 에이전트는 이 문서를 먼저 읽는다.
기존 규칙(docs/ARCHITECTURE.md)은 그대로다: 서버 전용 모듈은 `import "server-only"`, 인증은 `requireUser`/`requireApiUser`,
상태 변경 API는 `assertSameOrigin`, Next 16 `params`는 Promise. DB는 `@/lib/db/client`의 `prisma`(Prisma ORM, PostgreSQL).

## 0. 파일 소유권

> 2차(공고·지원·대조·HWP) 작업의 소유권은 **§7-0**을 본다. 아래 표는 1차 작업 기록이다.

| 담당 | 파일 |
|---|---|
| graph-ui | `src/app/app/graph/**`, `src/app/api/graph/**` (채팅 제외), `src/components/graph/**` (채팅 컴포넌트 제외) |
| graph-chat | `src/app/api/graph/chat/**`, `src/lib/chat/graph-chat.ts`, `src/components/graph/GraphChat*.tsx`. 그래프 페이지에서 채팅 패널은 graph-ui가 import할 수 있게 컴포넌트 이름 **`GraphChatPanel`** 고정(`src/components/graph/GraphChatPanel.tsx`, props: `{ initialThreadId?: string }`) |
| reviewer-chat | `src/app/api/diagnoses/[id]/chat/**`, `src/lib/chat/reviewer-chat.ts`, `src/components/report/ReviewerChat*.tsx`, 그리고 진단 화면(DiagnosisView 또는 리뷰어 카드)에 진입 버튼을 추가하는 최소 수정 |
| portfolio | `src/lib/ingest/**` 확장, `src/lib/diagnoses/form.ts`·`service.ts`·http 입력 경로, `src/app/api/diagnoses/route.ts`, `src/components/app/NewDiagnosisForm.tsx`, `src/lib/panel/prompts.ts`·`pipeline.ts`의 포트폴리오 반영, 보고서에 포트폴리오 표시(선택) |
| resumes | `src/app/app/resumes/**`, `src/app/api/resumes/**`, `src/lib/resumes/**`, `src/components/resumes/**`, 이력서 PDF 렌더(`src/lib/report`의 기존 PDF 폰트 재사용 가능, 새 파일은 `src/lib/resumes/pdf.tsx`) |

**공용 파일**(`prisma/schema.prisma`, `prisma/migrations/**`, `src/lib/domain/{graph,chat,resumes}.ts`, `src/lib/llm/*`, `src/lib/graph/*`,
`src/lib/storage/*`, `src/lib/chat/store.ts`, `src/lib/chat/prompt.ts`, `src/lib/api/errors.ts`, `src/components/app/AppSidebar.tsx`)은
기능 에이전트가 고치지 않는다 — 필요하면 최종 보고에 적는다.

## 1. DB (PostgreSQL, `prisma/schema.prisma` — 예전 drizzle 0003)

마이그레이션은 `prisma migrate deploy`(로컬 `npm run db:migrate`, Vercel Production 빌드)로 적용한다. 런타임은 적용하지 않는다.

| 테이블 | 컬럼 |
|---|---|
| `chat_threads` (`ChatThread`) | `id, userId(FK users cascade), kind: 'graph'\|'reviewer', diagnosisId?(FK diagnoses cascade), reviewer?: ReviewerId, title, createdAt, updatedAt` |
| `chat_messages` (`ChatMessage`) | `id, threadId(FK cascade), role: 'user'\|'assistant', content, data?: ChatMessageData(json), status?: ChatMessageStatus, usage?: UsageTotals(json), createdAt` |
| `diagnoses` +2 | `portfolioText?: string`, `portfolioFileName?: string` |
| `company_resumes` (`CompanyResume`) | `id, userId(FK cascade), company, roleTitle, jdText?, templateId: ResumeTemplateId, title, currentVersionId?(FK 없음), createdAt, updatedAt` |
| `resume_versions` (`ResumeVersion`) | `id, resumeId(FK cascade), versionNo(resumeId별 유일), storageKey, note?, source: 'ai'\|'manual', createdAt` |

타입: `ChatThreadRow`, `ChatMessageRow`, `CompanyResume`, `ResumeVersion` (`src/lib/db/types.ts`). 이력서 본문은 DB가 아니라 저장소(§5)에 버전별 JSON.

## 2. `src/lib/domain/graph.ts` (클라이언트·서버 공용)

```ts
NODE_LABELS = ["Company","Role","Project","Experience","Skill","Achievement","Education","Certification"]  // Person은 사용자당 1개, 자동
type NodeLabel; type EndpointLabel = NodeLabel | "Person"
PERSON_ID = "me"                       // API·변경안에서 본인 노드를 가리키는 id
NODE_LABEL_META[label] = { name(한국어), description }
REL_TYPES = ["WORKED_AT","HAD_ROLE","AT_COMPANY","WORKED_ON","PART_OF","HAS_EXPERIENCE","RELATED_TO",
             "USED_SKILL","HAS_SKILL","ACHIEVED","STUDIED_AT","EARNED"]
REL_RULES[type] = { name(한국어), from: EndpointLabel[], to: EndpointLabel[] }; isAllowedEdge(type, fromLabel, toLabel)
NODE_PROP_SCHEMAS[label]: z.ZodObject   // 라벨별 속성(대표 키 NODE_TITLE_KEY: Company.name, Role.title, Project.name,
                                        // Experience.title, Skill.name, Achievement.summary, Education.school, Certification.name)
                                        // 날짜는 "YYYY" | "YYYY-MM" | "YYYY-MM-DD"
// Project·Experience 공통 자소서 소재(STAR) 속성 — 모두 선택, 기존 노드·변경안은 그대로 통과(Neo4j 마이그레이션 없음):
//   situation(상황·목표 S·T, ≤1000), action(내 행동 A, ≤1000), result(결과 R, ≤1000), learned(배운 점, ≤1000),
//   categories: StoryTag[] (1~3개, 네이티브 문자열 리스트로 저장). Experience에는 myRole(내 역할)도 있다(Project는 기존 myRole·teamSize).
STORY_TAGS = ["problem-solving","collaboration","challenge-failure","motivation","leadership","values","learning","responsibility"]
STORY_TAG_ALIASES[tag]: string[]; resolveStoryTag(s): StoryTag|null; parseStoryTags(s); normalizeStoryTags(tags)  // 정렬·중복 제거·3개
type NodeProps<L>; allowedPropKeys(label): string[]
type GraphNode = { id; label; props; createdAt; updatedAt }   // label로 좁혀지는 유니온
type GraphEdge = { id: `${type}:${from}:${to}`; type; from; to } // from/to는 노드 id 또는 "me". (type,from,to) 유일
type CareerGraph = { person: { id: "me"; name: string|null }; nodes: GraphNode[]; edges: GraphEdge[] }
nodeDisplayName(node), edgeId(type, from, to)
MAX_NODES_PER_USER = 1000, MAX_OPS_PER_BATCH = 60

// 변경 연산 — 직접 편집 API와 채팅 변경안이 같이 쓴다
type GraphOp =
  | { op:"addNode"; ref:"new:<영문숫자>"; label; props }          // 임시 ref로 같은 변경안의 뒤 연산에서 참조
  | { op:"updateNode"; id; label; props: Partial<props | null> }  // null = 속성 삭제(대표 키는 삭제 불가)
  | { op:"deleteNode"; id }
  | { op:"addEdge" | "deleteEdge"; type; from; to }              // from/to: "me" | 기존 id | "new:..."
GraphOpSchema: z.ZodType<GraphOp> (엄격, API 입력 검증), GraphOpsSchema = z.array(GraphOpSchema).max(60)
interface GraphProposal { ops: GraphOp[]; summary: string }
interface ApplyGraphOpsResult { created: Record<ref, newId>; applied: number }
describeGraphOp(op, graph?, batch?): string  // "회사 추가: 페이랩", "연결(재직): 나 → 페이랩" — 확인 목록용

// LLM 구조화 출력용 평평한 형식(유니온·선택 필드 없음). 해당 없는 필드는 "" / []
LlmGraphOpSchema: { op, ref, id, label: NodeLabel|"", props: {key,value:string}[], type: RelType|"", from, to }
toGraphOps(llmOps): { ops: GraphOp[]; errors: string[] }  // 형 변환(숫자·참거짓), 화이트리스트 밖 키 제거, 틀린 연산은 errors로
                                                         // categories: "협업, leadership" → ["collaboration","leadership"] (모르는 값은 errors)
```

경험 카테고리 10개(`src/lib/domain/experience-categories.ts`)와 완성도 판정(`src/lib/graph/completeness.ts`:
`assessExperienceChecklist(graph)`, `categoryAskMessage(status)`, `checklistToPromptText(checklist)`)은 [EXPERIENCE-CATEGORIES.md](./EXPERIENCE-CATEGORIES.md).
그래프 채팅 프롬프트는 `<experience_checklist>`(`CHAT_TAGS.experienceChecklist`)를 그래프 뒤·캐시 구분자 앞에 넣고,
LLM의 updateNode `categories`는 기존 태그와 합집합으로 바꾼다(`mergeCategoryUpdates`). 직접 편집은 그대로 교체한다.

## 3. `src/lib/domain/chat.ts` (공용)

```ts
type ChatThreadKind = "graph" | "reviewer"; type ChatRole = "user" | "assistant"
type ChatMessageStatus = "proposed" | "applied" | "dismissed" | "failed"
MAX_CHAT_MESSAGE_CHARS = 4000; ChatUserMessageSchema = z.string().trim().min(1).max(4000)
CHAT_TAGS = { latestMessage:"latest_message", conversation:"conversation", careerGraph:"career_graph",
              resume:"resume", reviewerFeedback:"reviewer_feedback" }   // 프롬프트 자료 태그(테스트용 가짜 LLM도 이 태그를 읽는다)

GraphChatOutputSchema = { reply: string; ops: LlmGraphOp[] (≤60); summary: string; followUpQuestions: string[] (≤3) }
ReviewerChatOutputSchema = { reply; suggestedEdits: { before: string|null(원문 인용); after; reason }[] (≤5);
                             followUpQuestions: string[] (≤3); verdictOutlook: string|null }

type ChatMessageData =
  | { kind:"graph-proposal"; ops: GraphOp[]; summary; followUpQuestions; droppedOps?; created?; error? }
  | { kind:"reviewer-feedback"; suggestedEdits: (SuggestedEdit & { quoteVerified? })[]; followUpQuestions; verdictOutlook }
interface ChatThread { id; kind; diagnosisId; reviewer; title; createdAt(ms); updatedAt(ms) }
interface ChatMessage { id; threadId; role; content; data; status; createdAt(ms) }
```

권장 흐름(그래프 채팅): 사용자 메시지 저장 → LLM(`task:"graph-chat"`) → `toGraphOps` → assistant 메시지
`{status:"proposed", data:{kind:"graph-proposal", ops, ...}}` 저장 → 사용자가 확인 → `updateMessage(..., {expectStatus:"proposed"})`로
선점 후 `applyGraphOps` → 성공 `applied`(+created) / 실패 `failed`(+error). 거절은 `dismissed`.

## 4. `src/lib/domain/resumes.ts` (공용)

```ts
RESUME_SECTION_KEYS = ["summary","highlights","experience","projects","skills","education","certifications","extras"]; RESUME_SECTION_LABELS
RESUME_HEADING_KEYS = ["highlights","experience","projects","skills","education"]   // 섹션 제목 바꾸기 대상
ResumeDocumentSchema (모든 필드 필수, 없으면 "" / []):
  basics { name, headline, totalExperience, email, phone, location, portfolioUrl, links[{label,url}] }, summary,
  headings { highlights, experience, projects, skills, education }   // 빈 문자열이면 기본 제목
  highlights[{ title, context }],
  experience[{ company, department, title, startDate, endDate, location, scope, bullets[] }],
  projects[{ name, company, team, role(내 역할), startDate, endDate, summary, problem, action, result, evidence, bullets[], techs[] }],
  skills[{ category, detail, items[] }], education[{ school, degree, major, startDate, endDate, note }],
  certifications[{ name, issuer, date }], extras[{ title, items[] }]
type ResumeDocument; emptyResumeDocument(); EMPTY_RESUME_ITEM.<섹션>()   // 빈 항목 생성기
performanceScaffold(doc?)   // 성과 양식 빈 뼈대(성과 2·경력 2·프로젝트 2·역량 2·학력 1·자격 1)
// 예전 저장본 호환: 빠진 새 필드를 빈 값으로 채운 뒤 검증. 저장본 읽기·버전 저장 API·LLM 초안 검증이 이 경로를 쓴다.
upgradeResumeDocument(raw); StoredResumeDocumentSchema = z.preprocess(upgradeResumeDocument, ResumeDocumentSchema); parseResumeDocument(raw)
ResumeDraftOutputSchema = { document: ResumeDocument; notes: string[]; missingInfo: string[] }   // task "resume-draft"(LLM 스키마는 모든 필드 필수)
RESUME_VERSION_SOURCES = ["ai","manual"]
RESUME_TEMPLATE_IDS = ["performance","classic","modern","compact","developer","career-change"]; ResumeTemplateIdSchema
RESUME_TEMPLATES[id] = { id, name(한국어), description, sectionOrder: ResumeSectionKey[],
  style: { accent(hex), baseFontSize(pt), headingStyle:"underline"|"bar"|"plain", layout:"single"|"sidebar"|"labeled",
           density:"normal"|"compact", skillChips } }
DEFAULT_RESUME_TEMPLATE = "performance"
```

## 5. 서버 공통 모듈

### 경력 그래프 — `src/lib/graph/*`

```ts
// client.ts (server-only)
graphEnabled(): boolean                 // NEO4J_URI 없으면 false → 화면은 안내, API는 503
getDriver(); ensureGraphSchema(); closeDriver()
// service.ts (server-only) — 모든 쿼리 userId 조건 + 파라미터화, 라벨·관계는 화이트리스트만 Cypher에
getCareerGraph(userId, { personName? }): Promise<CareerGraph>
applyGraphOps(userId, ops: GraphOp[]): Promise<ApplyGraphOpsResult>   // 한 트랜잭션, 하나라도 틀리면 GraphOpError(400) + 아무것도 안 씀
deleteNode(userId, id): Promise<boolean>                               // 관계째 삭제, 남의 노드면 false
deleteUserGraph(userId): Promise<void>
// text.ts (순수) — service에서도 re-export
graphToText(graph, { maxChars? = 12000 }): string   // "[id] 이름 (key=value...)" + 관계 줄. LLM이 기존 id를 가리킬 수 있다
// errors.ts (순수): GraphOpError(status 400, index?), GraphUnavailableError(status 503)
// plan.ts (순수): planGraphOps(existingMap, ops, newId) — service 내부용
```

### 저장소 — `src/lib/storage/index.ts` (server-only)

R2_ACCOUNT_ID·R2_ACCESS_KEY_ID·R2_SECRET_ACCESS_KEY·R2_BUCKET(선택 R2_ENDPOINT)이 모두 있으면 R2(region `auto`), 아니면
로컬 `STORAGE_DIR`(기본 `data/storage`). 키는 `users/<userId>/...`만(조각: `[A-Za-z0-9][A-Za-z0-9._-]*`, `..` 금지).

```ts
userKey(userId, ...parts): string        // 예: userKey(u, "resumes", resumeId, `v${n}.json`)
userPrefix(userId, ...parts): string     // "users/<u>/.../"
putObject(key, body: Buffer|Uint8Array|string, { contentType? }); getObject(key): Promise<Buffer|null>
deleteObject(key) (없어도 OK); listByPrefix(prefix): Promise<string[]> (정렬)
putJson(key, value); getJson(key): Promise<unknown|null>   // 스키마 검증은 호출자(ResumeDocumentSchema.parse)
storageKind(): "r2" | "local"; StorageKeyError(status 400)
```

### LLM — `src/lib/llm`

```ts
type LlmTask = "graph-chat" | "reviewer-chat" | "resume-draft" | "posting-extract"     // LLM_TASKS (§7)
createLlmClient(provider).generate({ task, system, user, schema, effort, maxTokens?, signal? })  // TaskRequest
// 파이프라인은 그대로 { stage, ... } (GenerateRequest). LlmClient.generate는 LlmRequest = GenerateRequest | TaskRequest
requestLabel(req): string
```

- 엔진: `resolveRequestedProvider(requested)`(providers/options.ts). 진단 채팅은 그 진단의 엔진(`diagnosis.provider ?? legacyProvider(model)`) 권장.
- 출력 스키마는 위 도메인 스키마를 그대로 쓴다(테스트용 가짜 LLM `src/test/fake-llm.ts`가 그 스키마에 맞는 값을 낸다). 다른 스키마를 쓰면 테스트에서 `invalid_output`.
- 가짜 LLM이 읽는 자료 형식(= 실제 프롬프트도 이 형식으로): `wrapData(CHAT_TAGS.latestMessage, 메시지)`,
  `wrapData(CHAT_TAGS.resume, 이력서)`, `field("심사위원", 이름)`, `field("지원 회사", ...)`, `field("지원 직무", ...)`.
- 구조화 출력 스키마는 유니온·선택 필드를 줄인다(그래서 그래프 연산은 `LlmGraphOpSchema`). `.nullable()`은 기존 단계처럼 써도 된다.
- 오류 문구: `featureErrorResponse`(아래)가 `LlmPermanentError`를 `stageErrorMessage`로 바꿔 502.

### 채팅 공통

```ts
// src/lib/chat/store.ts (server-only) — 모두 userId 소유권 확인, 남의 것은 null/false
createThread({ userId, kind, title, diagnosisId?, reviewer? }): Promise<ChatThread>   // reviewer면 둘 다 필수
getThread(userId, threadId): Promise<ChatThread|null>
listThreads(userId, { kind?, diagnosisId?, reviewer?, limit? = 50 }): Promise<ChatThread[]>   // 최근 갱신 순
renameThread(userId, threadId, title): Promise<boolean>; deleteThread(userId, threadId): Promise<boolean>
addMessage(userId, { threadId, role, content, data?, status?, usage? }): Promise<ChatMessage|null>  // 스레드 updatedAt 갱신
listMessages(userId, threadId, { limit? }): Promise<ChatMessage[]|null>   // 오래된 순(limit이면 최근 N개)
getMessage(userId, messageId): Promise<ChatMessage|null>
updateMessage(userId, messageId, { status?, data?, content? }, { expectStatus? }): Promise<ChatMessage|null>  // 조건부 전환
toChatThread(row), toChatMessage(row)

// src/lib/chat/prompt.ts (순수)
INJECTION_RULE: string                 // 시스템 프롬프트에 반드시 포함(태그 안 지시문 무시)
wrapData(tag, body): string            // <tag>\n(neutralize된 본문)\n</tag>
field(label, value): string            // "- 라벨: 값" 한 줄
neutralizeChat(text): string           // 패널 태그 + CHAT_TAGS 무력화
historyToPrompt(messages, { maxMessages?=12, maxChars?=8000, maxCharsPerMessage?=2000 }): string
```

### 라우트 오류 응답 — `src/lib/api/errors.ts` (server-only)

```ts
featureErrorResponse(err, context): Response   // FeatureError·GraphOpError·GraphUnavailableError·StorageKeyError → 메시지+상태,
                                               // LlmPermanentError → 502 사용자 문구, 나머지 diagnoses/http errorResponse
class FeatureError(message, status)            // 기능 모듈이 404·409 등을 던질 때
```
`jsonError(message, status)`·`notFound()`는 `src/lib/diagnoses/http.ts` 그대로.

## 6. 화면·환경

- 내비게이션: '경력 그래프'(`/app/graph`), '이력서'(`/app/resumes`) 링크 추가됨. 두 페이지는 자리(placeholder) 상태 — graph-ui·resumes가 교체.
- `.env.example`: `NEO4J_URI/USER/PASSWORD/DATABASE`, `R2_*`, `STORAGE_DIR`. 개발용 Neo4j는 `docker-compose.yml`.
- 테스트: 실제 LLM 호출 금지(`new FakeLlmClient()`(`@/test/fake-llm`, 테스트 파일에서만 import 가능) 또는 가짜 클라이언트 주입).
  가짜 심사위원(mock) 엔진·`LLM_MOCK`은 없앴다. 로컬 확인은 Claude/ChatGPT 계정 로그인 엔진으로 한다. Neo4j 통합 테스트는
  `describe.skipIf(!process.env.NEO4J_URI)`, 고유 userId로 만들고 `deleteUserGraph`로 정리(예: `src/lib/graph/service.integration.test.ts`).
  실행: `set -a; . ./.env.local; set +a; npx vitest run src/lib/graph`.
  server-only 모듈 테스트는 `vi.mock("server-only", () => ({}))`, DB는 `createTestDb()`(`src/test/db.ts`, PGlite — chat/store.test.ts 참고),
  저장소는 `STORAGE_DIR=<tmp>` + R2 변수 삭제(storage/index.test.ts 참고).
- dev 서버는 3000 금지(메인 저장소 사용 중). 필요하면 `PORT=3100+`로 띄우고 끝나면 종료.


---

## 7. 공고 보관함·지원 추적·JD 대조·HWP (2차)

참고 프로젝트 CareerLoop(`/path/to/Carerr_loop`, MIT, 같은 저작권자)의 코드를 이식할 수 있다. 이식한 파일 머리 주석에
`CareerLoop(<경로>)에서 가져옴`을 적고, 알려진 결함(R-12 응답률, R-13 마감 로컬 시간대, R-14 지원 삭제 후 공고 상태)은 고쳐서 가져온다.
의존성은 기반이 설치함: `htmlparser2`, `cfb`, `fflate`(모두 자체 타입 포함).

### 7-0. 파일 소유권

| 담당 | 파일 |
|---|---|
| postings | `src/lib/postings/**`, `src/app/api/postings/**`(`[id]/match` 제외), `src/app/app/postings/**`(대조 카드 컴포넌트 자리 제외), `src/components/postings/**`, `POST /api/diagnoses`·`/api/resumes`의 `postingId` 처리(`src/app/api/diagnoses/route.ts`, `src/lib/diagnoses/form.ts`·`service.ts`, `src/lib/resumes/service.ts`의 해당 부분, `src/lib/resumes/prefill.ts`) |
| applications | `src/lib/applications/**`, `src/app/api/applications/**`, `src/app/api/insights/route.ts`, `src/app/app/applications/**`, `src/components/applications/**`, `src/app/app/page.tsx`의 인사이트 카드 부분 |
| match | `src/lib/skills/**`, `src/lib/graph/match*.ts`, `src/app/api/postings/[id]/match/**`, `src/app/api/insights/skills/**`, `src/components/match/**`, `GraphChatPanel`의 `initialMessage` prop(`src/components/graph/GraphChatPanel.tsx`), 그래프 페이지(`src/app/app/graph/page.tsx`)의 스킬 갭 패널 |
| hwp | `src/lib/ingest/**`, 업로드 UI의 허용 확장자·안내 문구(`src/components/app/FileDrop.tsx` 등), `THIRD_PARTY_NOTICES.md`(CareerLoop 출처 항목 포함 — 다른 담당은 이식한 파일만 최종 보고에 적는다) |

**공용(기반) 파일 — 기능 담당은 고치지 않는다, 필요하면 최종 보고에 적는다:** `prisma/schema.prisma`, `prisma/migrations/**`,
`src/lib/domain/{postings,applications,chat,graph,resumes}.ts`, `src/lib/time/kst.ts`, `src/lib/llm/*`, `src/test/fake-llm.ts`,
`src/lib/chat/prompt.ts`, `src/lib/api/errors.ts`, `src/components/app/AppSidebar.tsx`, `package.json`.

교차 지점:
- 공고 상세(`src/app/app/postings/[id]/page.tsx`, postings 소유)는 match의 `PostingMatchCard`를 import해 넣는다:
  `export function PostingMatchCard({ postingId }: { postingId: string })` — `src/components/match/PostingMatchCard.tsx`(클라이언트 컴포넌트, 스스로 `GET /api/postings/[id]/match`를 부른다).
- 공고 상세의 '지원 기록 추가'는 `/app/applications?new=1&postingId=<id>`로 이동한다(applications가 쿼리를 읽어 폼을 연다).
  공고 상세의 '관련 지원' 목록은 `GET /api/applications?postingId=<id>`를 쓴다(applications가 이 필터를 지원한다).
- 공고 상태: 지원 생성(postingId 있음) → 공고 `applied`, 지원 삭제 후 그 공고의 다른 지원이 없으면 → 공고 `planned`.
  applications 서비스가 `job_postings` 표(Prisma `jobPosting`)를 직접 갱신한다(같은 트랜잭션, `userId` 조건). postings 모듈을 import하지 않아도 된다.
- 마감 계산(`deadlineInfo` 등)은 postings의 `src/lib/postings/deadline.ts`(순수, server-only 아님)에 둔다 — applications의 `buildSuggestions`가 import한다.
  postings는 아래 시그니처를 지킨다.

### 7-1. DB (`prisma/schema.prisma` — 예전 drizzle 0004)

FK `ON DELETE set null`·cascade와 url_key 유일성은 `src/lib/db/db.test.ts`(PGlite)가 확인한다.

| 테이블 | 컬럼 |
|---|---|
| `job_postings` (`JobPosting`, `JobPostingRow`) | `id, userId(FK cascade), company, roleTitle, url?, urlKey?(normalizeUrl), platform?, status: PostingStatus='saved', jdText?(≤30000), deadline?('YYYY-MM-DD' KST), deadlineTime?('HH:mm' KST), deadlineKind: DeadlineKind='unspecified', employmentType='unknown', workType='unknown', location?, careerLevel='unknown', note?, extractedBy='manual', createdAt, updatedAt`. index(userId, updatedAt), **unique(userId, urlKey)**(null은 여러 개 가능) |
| `posting_imports` (`PostingImport`, `PostingImportRow`) | `id, userId(FK cascade), url, status: PostingImportStatus='queued', error?(사용자용 문구), postingId?(FK set null), attempts=0, createdAt, updatedAt`. index(userId, createdAt) |
| `diagnoses` +1 | `postingId?`(FK set null) |
| `company_resumes` +1 | `postingId?`(FK set null) |
| `applications` (`Application`, `ApplicationRow`) | `id, userId(FK cascade), postingId?(FK set null), company, roleTitle, stage: ApplicationStage='applied', appliedAt?('YYYY-MM-DD'), nextStep?, nextDate?('YYYY-MM-DD'), note?, favorite(boolean)=false, resumeId?(FK company_resumes set null), resumeVersionId?(FK 없음), resumeLabel?(지원 시점 이름 스냅숏), submittedKey?(저장소 키), diagnosisId?(FK set null), createdAt, updatedAt` |
| `application_events` (`ApplicationEvent`, `ApplicationEventRow`) | `id(autoincrement), applicationId(FK cascade), fromStage?(생성 시 null), toStage, note?, at` |

DB의 빈 텍스트는 null, API 응답(`JobPosting` 등)은 ""로 바꿔 내보낸다(아래 타입 주석 참고).

### 7-2. `src/lib/time/kst.ts` (순수, 공용)

```ts
DAY_MS, KST_OFFSET_MS
isValidKstDate(v): v is string        // 실제 있는 'YYYY-MM-DD'
isValidKstTime(v): v is string        // 'HH:mm'
kstDate(at = now): string; kstToday(now = Date.now()): string   // 시각 → KST 달력 날짜
kstDateTimeToMs(date, time?): number | null                     // KST 날짜(+시각)의 시작 ms
daysBetween(from, to): number | null; addKstDays(date, n): string
formatKstDate(date, { withYear?, withWeekday? }): string        // "11월 5일 (목)", 틀리면 "날짜 미정"
relativeKstLabel(date, today = kstToday()): string             // 오늘/내일/모레/3일 뒤/2일 지남
```
로컬 시간대(`new Date(y, m, d)`, `getDate()`)를 쓰지 않는다 — 서버(UTC)와 브라우저가 같은 답을 내야 한다.

### 7-3. `src/lib/domain/postings.ts` (공용)

```ts
POSTING_STATUSES = ["saved","reviewing","planned","applied","on_hold","closed"]; POSTING_STATUS_LABELS  // 관심/검토 중/지원 예정/지원함/보류/마감
DEADLINE_KINDS = ["date","rolling","unspecified"]; DEADLINE_KIND_LABELS
EMPLOYMENT_TYPES = ["full_time","contract","intern","new_grad","freelance","other","unknown"]; EMPLOYMENT_TYPE_LABELS
WORK_TYPES = ["onsite","hybrid","remote","unknown"]; WORK_TYPE_LABELS
CAREER_LEVELS = ["entry","experienced","senior","manager","any","unknown"]; CAREER_LEVEL_LABELS
POSTING_LIMITS = { company:150, roleTitle:250, url:2048, jdText:30000, location:300, note:6000, platform:40 }
DAILY_POSTING_IMPORT_LIMIT = 20       // 최근 24시간 posting_imports 행 수

PostingCreateInputSchema (strict; company·roleTitle 필수, 나머지 기본값. deadlineKind 생략 시 deadline 있으면 'date' 아니면 'unspecified')
PostingUpdateInputSchema (strict partial, 빈 객체 거절) — 서비스가 기존 행과 합친 뒤 postingDeadlineError로 다시 검사
postingDeadlineError({ deadline, deadlineTime, deadlineKind }): string | null
PostingImportInputSchema = { url: string(1..2048) }

interface JobPosting { id; company; roleTitle; url(""=없음); urlKey: string|null; platform; status; jdText; deadline(""=없음);
  deadlineTime; deadlineKind; employmentType; workType; location; careerLevel; note; extractedBy; createdAt(ms); updatedAt(ms) }
type JobPostingSummary = Omit<JobPosting,"jdText"> & { hasJd: boolean }   // 목록용

POSTING_IMPORT_STATUSES = ["queued","reading","analyzing","completed","failed"]; POSTING_IMPORT_STATUS_LABELS; isPostingImportActive(s)
interface PostingImportJob { id; url; status; error: string|null; postingId: string|null; createdAt; updatedAt }

PostingFactsSchema   // LLM 출력(task 'posting-extract'). 모든 필드 필수, 유니온 없음:
  { isJobPosting: boolean; company; companyEvidence; roleTitle; roleEvidence; employmentType; workType; location;
    careerLevel; deadline(YYYY-MM-DD|""); deadlineTime(HH:mm|""); deadlineEvidence; rolling: boolean; note }
type PostingFacts
```

### 7-4. `src/lib/domain/applications.ts` (공용)

```ts
APPLICATION_STAGES = ["interested","applied","assignment","interview","offer","rejected","withdrawn"]; APPLICATION_STAGE_LABELS
APPLICATION_BOARD_COLUMNS                  // 칸반 열 순서
SUBMITTED_STAGES = ["applied","assignment","interview","offer","rejected"]  // 응답률 분모: 이 중 하나에 '한 번이라도' 도달(이벤트 기준)
RESPONSE_STAGES = ["assignment","interview","offer"]                       // 응답률 분자: 한 번이라도 도달(지금 불합격이어도 셈)
CLOSED_STAGES = ["offer","rejected","withdrawn"]
APPLICATION_LIMITS = { company:150, roleTitle:250, nextStep:200, note:4000, eventNote:500 }

ApplicationCreateInputSchema (strict) — postingId 없으면 company·roleTitle 필수, resumeVersionId는 resumeId와 함께, stage 기본 'applied',
                                         appliedAt/nextDate는 'YYYY-MM-DD'|null(""→null)
ApplicationUpdateInputSchema (strict partial, stage 없음 — 단계는 POST /api/applications/[id]/stage)
ApplicationStageInputSchema = { stage; note = "" }

interface JobApplication { id; postingId; company; roleTitle; stage; appliedAt: string|null; nextStep; nextDate: string|null; note;
  favorite; resumeId; resumeVersionId; resumeLabel: string|null; hasSubmittedCopy: boolean; diagnosisId; createdAt; updatedAt }
interface ApplicationEvent { id: number; applicationId; fromStage: ApplicationStage|null; toStage; note; at }
interface ApplicationDetail extends JobApplication { events: ApplicationEvent[] }

// GET /api/insights — 실제 결과 집계. '합격 확률' 같은 예측 표현 금지
ResponseRate { submitted; responded; rate: number|null }
StageFunnelRow { stage; reached; current }
ResumePerformanceRow { resumeId; resumeVersionId; label; submitted; responded; rate }
CompanyRollupRow { company; applications; bestStage; matchScore: number|null }   // 연결된 완료 진단 fit.matchScore
Suggestion { kind: "deadline"|"next_step"|"follow_up"|"resume"|"pipeline"; message; href; postingId; applicationId }
InsightsResponse { responseRate; funnel; resumePerformance; companies; suggestions }
```

제출 사본: `userKey(userId, "applications", applicationId, "submitted.json")`에 그 버전의 ResumeDocument를 `putJson`.
`applied`로 바꾸거나 `resumeVersionId`를 지정할 때 복사한다. 단계 변경과 이벤트는 같은 트랜잭션.

### 7-5. LLM — task `posting-extract`

- `LLM_TASKS`에 추가됨. anthropic·CLI 클라이언트는 task 종류와 무관하게 동작한다(구조화 출력 = `toStrictJsonSchema(PostingFactsSchema)`).
- 프롬프트 형식(테스트용 가짜 LLM이 읽는 형식): system에 `INJECTION_RULE` 포함(이제 `<posting_page>`도 언급),
  user = `field("공고 주소", url)` + `wrapData(CHAT_TAGS.postingPage, pageText)`. 태그 이름은 `CHAT_TAGS.postingPage = "posting_page"`
  (`neutralizeChat`이 본문 안 같은 태그를 무력화한다).
- 가짜 출력(`src/test/fake-llm.ts`): 본문의 `회사: …`/`회사명: …`, `직무: …`/`모집 직무: …`/`포지션: …`/`모집 분야: …`, `근무지: …` 줄과
  `마감`·`접수 기간` 줄의 `2026.11.20 18:00` 같은 날짜·시각을 읽는다. 근거(*Evidence)는 본문 줄 그대로.
  회사·직무 줄이 없으면 `isJobPosting:false`. 본문에 `[가짜:근거없음]`이 있으면 회사·직무 근거를 본문에 없는 말로 내 근거 검증 실패를 시험할 수 있다.
  `상시 채용`/`채용 시 마감` → `rolling:true`. `정규직`/`계약직`/`인턴`, `신입`/`경력`/`경력 무관`, `원격`/`하이브리드`를 키워드로 고른다.

### 7-6. 담당별 권장 시그니처(명세 요약 — 담당이 세부를 정하되 교차 지점은 지킨다)

```ts
// postings
src/lib/postings/url.ts       normalizeUrl(raw): string; isValidUrl(raw): boolean; parsePostingUrl(raw): URL (FeatureError 400); inferPlatform(url): string
src/lib/postings/deadline.ts  isValidDeadlineDate = isValidKstDate; postingDeadlineAt(p: Pick<JobPosting,"deadline"|"deadlineTime">): number|null
                              type DeadlineLevel = "none"|"safe"|"soon"|"urgent"|"past"; interface DeadlineInfo { level; label; days: number|null }
                              deadlineInfo(p: Pick<JobPosting,"deadline"|"deadlineTime"|"deadlineKind">, now?: number|Date): DeadlineInfo
                              formatPostingDeadline(p): string
src/lib/postings/jd-sections.ts analyzeJobDescription(text) (CareerLoop writing.ts)
src/lib/postings/fetch.ts     fetchPostingPage(url, { fetchImpl?, lookup? }) — 사설·CGNAT·링크로컬·ULA 차단, DNS 고정, 리다이렉트 3회 재검사, 2MB·20s
                              isPublicAddress(ip): boolean
src/lib/postings/page-text.ts postingPageText(html): string (JSON-LD JobPosting 우선)
src/lib/postings/extract.ts   extractPosting({ url, pageText }, llm, { signal? }): Promise<{ facts; posting: PostingCreateInput }>  // 근거 검증
src/lib/postings/service.ts   listPostings(userId, opts?); getPosting(userId, id): JobPosting|null; createPosting(userId, input, { extractedBy? });
                              updatePosting(userId, id, patch); deletePosting(userId, id): boolean   // 중복 urlKey → FeatureError(409) + 기존 id
src/lib/postings/imports.ts   createImport(userId, url): PostingImportJob (하루 20회); runImport(importId, { llm?, fetchImpl? }); getImport(userId, id)
// applications
src/lib/applications/service.ts  listApplications(userId, { postingId? }); getApplication(userId, id): ApplicationDetail|null;
                                 createApplication(userId, input); updateApplication(userId, id, patch); changeStage(userId, id, input);
                                 deleteApplication(userId, id); getSubmittedCopy(userId, id): ResumeDocument|null
src/lib/applications/insights.ts responseRate(apps, events); stageFunnel(...); resumePerformance(...); companyRollup(..., scores);
                                 buildSuggestions({ applications, postings, now }): Suggestion[]   // 순수
// match
src/lib/skills/dictionary.ts  KEYWORD_DICTIONARY; aliasPattern; extractKeywords(text); matchKeywords(text, keywords); canonicalSkill(name): string|null
src/lib/graph/match.ts        matchGraphToRequirements(graph, reqs); requirementsFromJd(jdAnalysis|null, jdText); aggregateSkillGap(rows, limit=20)
src/lib/graph/match-service.ts matchPosting(userId, postingId); skillGapAcrossPostings(userId)   // 그래프 꺼짐 → GraphUnavailableError(503)
// hwp
src/lib/ingest/extract.ts      기존 extract 진입점에 .hwp/.hwpx/.html(.htm) 추가(이력서·포트폴리오·JD 파일 공통). 압축 해제 상한 32MB
```

### 7-7. 화면

- 사이드바(`AppSidebar`)는 그룹 메뉴: 진단(새 진단 `/app/new`·내 진단 `/app`), 경력(경력 그래프), 서류(이력서),
  지원(공고 보관함 `/app/postings`·지원 현황 `/app/applications`), 설정(AI 연결, CLI 엔진이 켜졌을 때만). 접힌 모드는 그룹 사이 구분선.
- 넓은 화면 사이드바: 바깥 칸이 행 높이만큼 늘어나 배경·경계선이 페이지 끝까지 이어지고, 안쪽 `<aside>`는 `sticky top-0 h-dvh` + 메뉴 자체 스크롤.
- `/app/postings`, `/app/postings/[id]`, `/app/applications`는 postings·applications 담당이 구현했다(통합 완료).

### 7-8. 구현 후 계약과 달라진 점(통합 기록)

- `parsePostingUrl`은 `FeatureError` 대신 순수 오류 `PostingUrlError`(status 400)를 던진다 — `url.ts`는 클라이언트도 쓰므로 server-only인
  `FeatureError`를 import할 수 없다. 서버 경로가 `FeatureError`로 바꿔 응답한다.
- 명세 밖 API `GET /api/postings/import`: 최근 24시간 가져오기 작업 목록(목록 화면을 다시 열어도 진행 상황을 이어 보여 준다).
- 행동 제안 링크 `/app/applications?open=<id>`를 applications가 읽어 그 지원 패널을 연다.
- 제출 사본 옆에 양식 id를 남기는 `submitted-meta.json`을 하나 더 둔다. `buildSuggestions` 입력에 선택 항목 `events`가 있다.
- `requirementsFromJd`는 `{ source, requirements }`를 돌려준다. `matchKeywords`는 `(required, skills)`를 받는다(CareerLoop와 같음).
  응답 타입 `PostingMatchResponse`·`SkillGapResponse`는 `src/lib/graph/match.ts`에 있다.
- `GraphChatPanel` props: `{ initialThreadId?: string; initialMessage?: string }`. 그래프 페이지가 `?ask=`를 `initialMessage`로 넘긴다.

## 8. 이력서·포트폴리오 가져오기 · 그래프에 묻기(3차)

설계·신호·가중치·평가는 `docs/GRAPH-QA.md`. 스키마 변경 없음 — `chat_threads.kind`에 `graph-qa` 추가, 나머지는 `chat_messages.data`(Json).

```
POST /api/graph/chat/threads/[threadId]/import   multipart: file | text, docKind(resume|portfolio), provider → 202 { message, warnings }
                                                 413 용량 · 415 형식 · 400 입력 없음/짧음 · 409 대기 중 · 429 GRAPH_IMPORT_LIMIT(24h 10회)
GET|POST /api/graph/qa/threads                   목록 { threads, graphEnabled } / 생성 201 { thread }
GET|PATCH|DELETE /api/graph/qa/threads/[id]      뷰 GraphQaThreadView(폴링) / 이름 / 삭제 204
POST /api/graph/qa/threads/[id]/messages         { message(≤1000자), provider } → 202 · 409 대기 중 · 429 GRAPH_QA_LIMIT(10분 30회)
POST /api/graph/qa/threads/[id]/retry            { provider } → 202 · 409 다시 시도할 것 없음
```

- `ChatMessageData`에 `DocumentImportData`(사용자 메시지: `{kind:"document-import", docKind, fileName, text, chars, truncated, warnings}`,
  원본 파일 없음·뷰에서는 text 비움)와 `GraphAnswerData`(`{kind:"graph-answer", sources: GraphSource[], insufficient, grounded, missingInfo,
  suggestions, droppedCitations?, debug?}`)를 더했다. `GraphSource = {n, nodeId, label, name, path: GraphPathStep[], pathText, snippet, exists?}`.
- `GraphProposalData.source?: "chat" | "document-import"` — 가져오기 변경안만 적용 상한 `MAX_IMPORT_OPS`(150). 직접 편집 API는 60 그대로.
- `toGraphOps(llmOps, { max? })`, `planGraphOps(existing, ops, newId, { maxOps? })`, `applyGraphOps(userId, ops, { maxOps? })`.
- `LLM_TASKS`에 `graph-import`·`graph-qa`·`graph-qa-rerank`. 환경 변수 `GRAPH_QA_LLM_RERANK`(off | on, 기본: API 엔진만).
- 그래프 화면은 `GraphAssistantPanel`(`initialMessage`, `initialTab`(`?tab=qa`), `uploadLimits`, `aside`=그래프 요소): 위 탭, 왼쪽 채팅, 오른쪽 그래프 — "경험 정리하기" | "경험 질문하기".
  window 이벤트 `career-graph:focus`(`focusGraphNode(id, pathIds?)`)로 출처 칩이 그래프 노드를 고르고 경로를 강조한다.
  체크리스트 루트 id는 `experience-checklist`.
