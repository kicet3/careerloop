/**
 * 그래프 채팅·문서 가져오기 프롬프트가 함께 쓰는 그래프 모델 설명(순수). 라벨·속성·관계 방향·경험 카테고리를 LLM에 알려 준다.
 */
import { EXPERIENCE_CATEGORIES } from "@/lib/domain/experience-categories";
import { allowedPropKeys, NODE_LABEL_META, NODE_LABELS, NODE_TITLE_KEY, PERSON_ID, REL_RULES, REL_TYPES } from "@/lib/domain/graph";

export function modelGuide(): string {
  const labels = NODE_LABELS.map(
    (l) => `- ${l}(${NODE_LABEL_META[l].name}): ${NODE_LABEL_META[l].description}. 속성: ${allowedPropKeys(l).join(", ")} (대표 이름: ${NODE_TITLE_KEY[l]})`,
  ).join("\n");
  const rels = REL_TYPES.map((t) => `- ${t}(${REL_RULES[t].name}): ${REL_RULES[t].from.join("|")} → ${REL_RULES[t].to.join("|")}`).join("\n");
  const cats = EXPERIENCE_CATEGORIES.map((c) =>
    c.source === "tag"
      ? `- ${c.id}(${c.name}${c.required ? ", 필수" : ", 추천"}): 최소 ${c.minFields.join(", ")}`
      : `- ${c.id}(${c.name}, 필수): 태그 아님 — 그래프 구조로 판정`,
  ).join("\n");
  return `노드 종류(본인은 Person, id "${PERSON_ID}"):\n${labels}\n\n관계(허용 방향만 쓸 수 있다):\n${rels}\n\n경험 카테고리(Project·Experience의 categories 값은 아래 id만 쓴다):\n${cats}`;
}

/**
 * 날짜 규칙(그래프 채팅·문서 가져오기·저장소 가져오기 공통, 시스템 프롬프트 — 고정 문자열이라 캐시를 깨지 않는다).
 * 오늘 날짜는 구분자 뒤 todayLine()으로 넣는다. 서버도 같은 계약을 강제한다(src/lib/domain/graph-dates.ts, plan.ts).
 */
export const GRAPH_DATE_RULES = `날짜 규칙(모든 날짜 속성 공통 — 어긋난 값은 서버가 뺀다):
D1. 날짜는 YYYY-MM으로 쓴다. 연도만 알면 YYYY. 일(日)은 쓰지 않는다(2024.3 → 2024-03, 24년 3월 → 2024-03, 2024-03-15 → 2024-03).
D2. 상대 표현은 '오늘 날짜'(한국 시간) 기준으로 연월을 계산한다: '작년 3월' → 작년-03, '재작년' → 재작년 연도(YYYY), '올해 초' → 올해 연도(YYYY), '지난달' → 이번 달의 전달. '3개월간'·'반년 동안'처럼 길이만 말하면 시작이나 종료 중 하나를 알 때만 나머지를 계산하고, 둘 다 모르면 비워 두고 묻는다.
D3. 진행 중('현재', '지금까지', '재직 중', '재학 중', '아직 하고 있다')이면 endDate를 쓰지 않고 current="true"로 둔다(Role·Project·Experience·Education). 진행 중인 일의 endDate를 이번 달로 적지 않는다. 끝났다고 하면 endDate를 넣는다(current는 서버가 지운다).
D4. 오늘 이후 날짜는 쓰지 않는다(졸업 예정인 Education.endDate만 예외). startDate는 endDate보다 늦을 수 없다.
D5. 프로젝트 기간을 그 프로젝트가 속한 직무(Role)·회사·다른 프로젝트의 기간으로 채우지 않는다. 사용자가 그 프로젝트의 기간을 따로 말했거나 '입사 때부터 지금까지'처럼 같다고 말했을 때만 넣는다. 모르면 비워 두고 그 프로젝트의 기간을 묻되, 이미 물었거나 답한 기간은 다시 묻지 않는다(followUpTopics의 period).
D6. 회사(Company)에는 날짜가 없다(재직 기간은 Role에). 자격증 취득 연월은 Certification.date, 성과를 낸 시점은 Achievement.date에 YYYY-MM으로 넣는다.`;

/** 구분자 뒤 '오늘 날짜' 줄의 값: 상대 표현을 풀 때 쓸 올해·이번 달·작년을 함께 적는다. today는 YYYY-MM-DD(KST). */
export function todayText(today: string): string {
  const y = Number(today.slice(0, 4));
  return `${today} (한국 시간 · 이번 달 ${today.slice(0, 7)} · 올해 ${y} · 작년 ${y - 1})`;
}
