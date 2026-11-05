# 경험 카테고리 (자소서·이력서·포트폴리오용 최소 경험)

CareerLoop는 경력 그래프가 자기소개서·이력서·포트폴리오에 반복해서 쓰이는 경험 소재를 **최소한** 갖췄는지 `경험 체크리스트`로 보여 준다.
필수 6개를 모두 채우면 완료이고, 추천 4개는 더 채우면 좋은 항목이다.

- 정의: `src/lib/domain/experience-categories.ts` (`EXPERIENCE_CATEGORIES`, `STORY_FIELD_NAMES`)
- 소재 분류 태그와 별칭: `src/lib/domain/graph.ts` (`STORY_TAGS`, `STORY_TAG_ALIASES`)
- 판정: `src/lib/graph/completeness.ts` (`assessExperienceChecklist`)
- 화면: `src/components/graph/ExperienceChecklist.tsx` (경력 그래프 화면 맨 위)
- 채팅: `src/lib/chat/graph-chat.ts` (시스템 프롬프트 규칙 11~14, 사용자 프롬프트의 `<experience_checklist>` 블록)

## 1. 그래프 매핑

- 자소서 소재를 담는 노드는 **Project와 Experience** 두 가지다. Role(직함)은 이력서 구조용이며, 회사에서 겪은 일화는
  Role 아래에 `WORKED_ON`으로 Project를 만들어 담는다.
- Project·Experience에 선택 속성 STAR 필드를 둔다: `situation`(상황·목표, S·T), `action`(내 행동, A), `result`(결과, R),
  `learned`(배운 점·가치관, E). Experience에는 `myRole`도 있다(Project에는 원래 `myRole`·`teamSize`가 있다).
- `categories`(문자열 배열, 1~3개)는 그 노드가 어떤 자소서 소재인지 단다. 값은 아래 태그 카테고리 id만 쓴다.
  자동 판정 카테고리(`career`, `quantified-result`)는 태그로 달 수 없다.
- 모두 optional이라 기존 노드·변경안이 그대로 통과한다. Neo4j 마이그레이션은 없다(문자열 리스트는 네이티브 속성).

## 2. 카테고리

| # | id | 이름 | 필수 | 판정 | 쓰이는 자소서 문항 | 최소 입력(done 조건) |
|---|---|---|---|---|---|---|
| 1 | `career` | 직무 경험(경력·인턴·프로젝트) | 필수 | auto | 직무역량·전문성, NCS 경력·경험기술서, 이력서 경력·프로젝트 | **Role**: title, AT_COMPANY 연결, startDate, 그리고 summary 또는 연결된 Project·Achievement 1개 이상. 또는 **Project**: name, myRole, startDate, 그리고 action(없으면 summary). 둘 중 하나가 1개 이상 |
| 2 | `quantified-result` | 정량 성과 | 필수 | auto | 직무역량, 도전·목표 달성, 이력서 핵심 성과·불릿 | 수치(`hasMetric`: 날짜·연도·학년 같은 숫자를 뺀 뒤 아라비아 숫자)가 들어간 Achievement(value 또는 summary)가 Role·Project·Experience에서 ACHIEVED로 연결됨. 또는 Project·Experience의 `result`에 수치. 1개 이상 |
| 3 | `problem-solving` | 문제 해결·개선(트러블슈팅) | 필수 | tag | 문제해결·창의, 직무역량, NCS 문제해결능력 | situation, action, result |
| 4 | `collaboration` | 협업·갈등 해결 | 필수 | tag | 협업·팀워크, 갈등 해결·의사소통, NCS 대인관계·의사소통 | situation, myRole, action, result |
| 5 | `challenge-failure` | 도전·실패 극복 | 필수 | tag | 도전·목표 달성, 실패·극복 | situation, action, result, learned |
| 6 | `motivation` | 지원동기 소재(직무 관심 계기) | 필수 | tag | 지원동기, 입사 후 포부의 근거 | situation(계기), action(그 뒤 준비한 활동·학습) |
| 7 | `leadership` | 리더십·주도성 | 추천 | tag | 리더십·주도성, 인재상 | situation, myRole, action, result |
| 8 | `values` | 성장과정·가치관(장단점 포함) | 추천 | tag | 성장과정, 가치관, 성격의 장단점 | situation, action, learned |
| 9 | `learning` | 자기개발·학습 | 추천 | tag | 자기개발, 직무역량 준비, NCS 자기개발능력 | situation(학습 목표), action(방법·기간), result(자격·점수·산출물·링크) |
| 10 | `responsibility` | 책임감·직업윤리·고객지향 | 추천 | tag | 책임감·주인의식, NCS 직업윤리, 고객지향·서비스 | situation, action, result |

각 카테고리의 채팅 질문(`guideQuestion`)과 체크리스트 버튼 문장(`chatStarter`)은 코드에 있다.

범위 밖으로 둔 것:

- **입사 후 포부**: 경험이 아니라 계획이다. `motivation`과 `learning`이 근거 소재가 된다.
- **대외활동·동아리·봉사**: 역량이 아니라 출처 유형이라 `Experience.kind`로 둔다.
- **학력·기술**: 경험 카테고리가 아니라 체크리스트에 넣지 않는다(필요하면 나중에 "이력서 기본 정보" 줄로 따로 붙인다).

## 3. 판정 규칙

필드 채움:

- `filled(text)`: 공백을 뺀 길이가 **8자 이상**(`MIN_STORY_CHARS`)이면 채운 것이다. "했음"처럼 짧은 값은 채운 것이 아니다.
- `myRole`: 값이 있으면 채운 것이다(직함은 짧을 수 있다).
- 기존 노드: `situation`이 비어 있으면 Project.summary나 Experience.description으로 대신한다. `action`·`result`는 대신하지 않으므로
  기존 노드는 partial로 남아 무엇을 더 채울지 안내받는다.

태그 카테고리:

- 후보 = 그 태그를 가진 Project·Experience. 없으면 `missing`, 후보 중 하나라도 `minFields`를 모두 채웠으면 `done`, 그 밖에는 `partial`이고
  가장 덜 빠진 후보가 `best`(빠진 항목은 한국어 이름과 필드 id).
- 예외: `learning`은 태그 후보가 없어도 Certification이 있으면 `partial`("자격증을 준비한 과정을 경험으로 남겨 보세요").

자동 카테고리:

- `career`: Role·Project가 없으면 `missing`, 위 조건을 채운 노드가 있으면 `done`, 그 밖에는 `partial`(회사 연결·시작일·내 역할·한 일 중 빠진 것을 알린다).
- `quantified-result`: Achievement와 `result`가 하나도 없으면 `missing`. 수치가 없으면 `partial`("수치(전후 값, %, 건수, 기간)를 넣어 주세요"),
  수치는 있지만 본인(me)에서만 ACHIEVED로 이어졌으면 `partial`("어떤 경험의 성과인지 연결해 주세요"). 이때 '연결하기'는
  Role·Project·Experience만 대상으로 보인다(본인 연결은 판정을 바꾸지 못한다). Role의 회사 연결은 Company만 보인다.
- 수치 판정(`hasMetric`)은 "2024년 3월", "2024.03", "2023 해커톤", "3월 5일", "3학년", "1분기", "Q1"의 숫자를 지운 뒤 숫자가 남는지 본다.
  "2000명"처럼 연도 모양 숫자 뒤에 단위가 붙으면 수치로 본다.

그 밖:

- 알 수 없는 태그 값은 무시한다.
- 노드 하나가 여러 카테고리를 채워도 된다. 자료들이 "핵심 경험 3~5개를 문항별로 다시 쓴다"고 권하기 때문이며, 태그 3개 상한이 몰아 달기를 막는다.
- 진행률: `progress = round(100 × Σ필수(done=1, partial=0.5) / 6)`, `complete` = 필수 6개 모두 done.

채팅:

- LLM은 사용자가 실제로 말한 내용이 뒷받침하는 `categories`만 단다(id 또는 한국어 별칭 → `toGraphOps`가 id로 바꾸고 모르는 값은 버린다).
- LLM의 updateNode `categories`는 기존 태그와 합친다(`mergeCategoryUpdates`). 보낸 값이 기존 태그의 진부분집합이면 교체한다
  ("리더십 태그 빼줘" → 남길 태그만 보냄). 합쳐서 3개를 넘으면 기존 태그를 지키고 넣지 못한 새 태그를, 바뀐 것이 없어 연산이 빠지면 그 사실을
  변경안의 "뺀 항목"에 남긴다. 같은 변경안에서 같은 노드를 여러 번 고치면 앞 연산 결과를 기준으로 본다. 직접 편집(NodeForm)은 그대로 교체한다.
- 태그 문자열은 쉼표·`|`·`/`·`·`로 나누고, 공백으로 이어진 단어는 가장 긴 별칭(3단어까지)부터 맞춘다("리더십 문제 해결" → leadership, problem-solving).
- `<experience_checklist>`에 빠진 필수 항목이 있으면 followUpQuestions 하나 이상이 그 항목의 최소 정보를 묻는다(한 번에 한 카테고리, 사용자 화제 우선).
  최소 정보는 지어내지 않고 묻는다.

## 4. 근거 출처

- 자소서 빈출 문항 유형(직무역량, 지원동기·포부, 도전, 문제해결, 협업·갈등, 성장과정, 가치관): 자소설닷컴 https://jasoseol.com/blog/?p=5163
- 4대 항목(지원동기, 성장과정, 직무역량, 입사 후 포부): 하이잡 https://www.haijob.co.kr/blog/?p=2023 ,
  https://www.haijob.co.kr/blog/how-to-prepare-for-each-item-of-cover-letter-motivation-for-application-growth-process-job-competency-aspiration-after-joining-the-company-etc/
- 경험 정리 3단계와 핵심 경험 3~5개 재사용: 하이잡 https://www.haijob.co.kr/blog/?p=2339
- STAR 작성 규칙(S·T는 짧게, A·R은 구체적으로): 하이잡 https://www.haijob.co.kr/blog/writing-method-using-star-methodology/
- 경험 유형 8종과 역량 키워드, 가치관 → STAR → 직무 연결 구조: 링커리어 https://community.linkareer.com/employment_data/6089574
- NCS 경력과 경험의 구분, 필수 기재사항(기간, 활동처, 담당업무, 성과): 고용24 https://m.work24.go.kr/wk/r/d/1110/resumeSelfIntroGuide1.do
- NCS 경력·경험기술서와 직업기초능력 10개 영역: 캐치 https://www.catch.co.kr/Guide/NCSGuideAtoZ3 , https://www.catch.co.kr/Guide/NCSGuideAtoZ4
- 공기업 윤리 문항(책임감·직업윤리): 잡플래닛 https://www.jobplanet.co.kr/contents/news-616/ (검색 요약 기준),
  한국경제 잡앤조이 https://magazine.hankyung.com/job-joy/article/202004022060b (검색 요약 기준)
- 실패 문항에는 깨달음과 변화가 필요함: 경기일보(잡코리아 인용) https://www.kyeonggi.com/article/201603080840089 (검색 요약 기준)
- CARE의 성찰(Evaluation) 단계, `learned` 필드의 근거: University of Warwick
  https://warwick.ac.uk/services/careers/blog/be_a_star_how_to_shine_at_applications_and_interviews (검색 요약 기준)
- 정량 성과(수치화한 이력서의 서류 합격률 13% 상승), 기여도, 섹션별 작성법: 원티드 https://www.wanted.co.kr/events/article_23_01_09 ,
  https://www.wanted.co.kr/events/article_23_01_06
- 섹션 구성(Experience, Leadership & Activities)과 정량화: Harvard OCS https://careerservices.fas.harvard.edu/resources/create-a-strong-resume/
- XYZ 공식(성과, 지표, 방법): CNBC/Google https://www.cnbc.com/2018/08/16/google-recruiters-share-the-3-part-formula-for-stronger-resumes.html
- 경력기술서 구조와 팀 성과·개인 기여 구분: 하이잡 https://www.haijob.co.kr/blog/?p=12023
- 개발자 포트폴리오(트러블슈팅, 기술 선택 이유, 회고): 알체라 https://www.alchera.ai/resource/blog/developer-portfolio

## 5. 남은 제약과 판단

- 필수 6개 선정(학력·기술·입사 후 포부 제외)과 기준값(8자, 숫자 1개 이상, 카테고리당 1건)은 출처에 정해진 수치가 없어 설계 판단으로 정했다.
- CARE를 한국 자료에서 공식 기법으로 다룬 사례는 찾지 못했다. 그래서 `learned`는 실패 극복과 가치관 카테고리에만 최소 필드로 요구한다.
- 숫자 판정은 아라비아 숫자만 본다. "두 배"처럼 한글로 쓴 수치는 아직 성과 수치로 인정되지 않는다. 날짜 제거는 흔한 표기만 다루므로
  "v2 출시" 같은 버전 번호는 수치로 잘못 볼 수 있다.
- `values`(성장과정·가치관)는 하이잡이 꼽은 4대 항목(성장과정 포함)이고 자소설닷컴의 빈출 유형이지만 추천으로 둔다. 같은 자료들이 직무역량·
  지원동기를 중심 문항으로 다루고, 성장과정 문항은 기업마다 있거나 없으며 다른 경험(도전·실패의 `learned`, 협업)에서 가치관을 끌어올 수
  있기 때문이다(설계 판단). 대신 필수를 다 채워도 `values`가 비어 있으면 체크리스트 완료 문구가 성장과정 소재를 채우라고 안내한다.
- 체크리스트는 필수가 남은 동안 추천 4개를 접어 둔다(작은 화면에서 그래프·채팅을 밀어내지 않게). 완료한 줄은 이름·힌트만 보인다.
