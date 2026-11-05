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
