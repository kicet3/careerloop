/**
 * GitHub 저장소로 프로젝트 하나 정리하기(프롬프트, 순수). 프로젝트 단위 대화(focusNodeId 스레드)의 첫 메시지(data.kind='repo-import')에
 * 저장소 요약(brief — src/lib/github/brief.ts)을 근거로 그 프로젝트의 요약·한 일·기간·기술을 채우는 변경안과, 저장소만으로 알 수 없는
 * 것을 묻는 후속 질문(최대 5개)을 만든다. 변경안 정리는 문서 가져오기와 같은 사슬(proposalFromOutput — 삭제 빼기, brief 대조,
 * 기존 값 덮어쓰지 않기, 이 프로젝트 밖 연산 빼기)을 거친다. 적용은 사용자가 확인한 뒤에만.
 */
import { CHAT_TAGS, MAX_REPO_IMPORT_OPS, MAX_REPO_IMPORT_QUESTIONS } from "@/lib/domain/chat";
import type { CareerGraph } from "@/lib/domain/graph";
import { graphToText } from "@/lib/graph/text";
import { projectFocusText } from "@/lib/graph/project-structure";
import { STAGE_TASK_DELIMITER } from "@/lib/panel/prompts";
import { kstToday } from "@/lib/time/kst";
import { GRAPH_CHAT_FOCUS_RULES } from "./graph-focus-rules";
import { GRAPH_DATE_RULES, modelGuide, todayText } from "./graph-guide";
import { field, INJECTION_RULE, wrapData } from "./prompt";

/** 프롬프트에 넣는 그래프 요약 상한(저장소 요약이 길어 그래프 몫을 줄인다). */
const REPO_IMPORT_GRAPH_MAX_CHARS = 6000;

export const GRAPH_REPO_IMPORT_SYSTEM = `너는 한국어 경력 정리 도우미다. 사용자가 고른 GitHub 저장소 정보(<${CHAT_TAGS.githubRepo}>)를 읽고, <${CHAT_TAGS.focusProject}>의 프로젝트 하나를 '경험 그래프'에 정리하는 변경안과 후속 질문을 만든다.
변경안은 사용자가 확인한 뒤에만 적용된다. reply에는 저장소에서 무엇을 정리했는지, 무엇을 더 물어볼지 짧게 설명한다.

${modelGuide()}

${GRAPH_CHAT_FOCUS_RULES}

저장소 가져오기 규칙(위 P 규칙보다 우선한다):
R1. <${CHAT_TAGS.githubRepo}>에 글자로 있는 사실만 쓴다. 저장소 설명·README·커밋 메시지·의존성에 없는 기술·기간·수치·역할을 지어내지 않는다.
R2. 이 프로젝트(updateNode, id는 구조화할 프로젝트 id)의 비어 있는 속성만 채운다: summary(저장소가 무엇인지 한두 문장), situation(README에 있는 배경·목표), action(회원님 커밋 메시지·PR 제목으로 본 한 일 — 무엇을 했는지만). 이미 값이 있는 속성은 건드리지 않는다. 기간(startDate·endDate·current)은 넣지 않는다 — 서버가 회원님 커밋 기록(첫·최근 커밋 달)으로 비어 있을 때만 채운다. 진행 중인지는 저장소로 판단하지 않는다.
R3. teamSize는 기여자 수가 있을 때만 그 수로 넣고, followUpQuestions에서 실제 팀 규모가 맞는지 확인한다.
R4. 기술(Skill)은 언어 비율과 의존성에서 주요한 것만 15개 이하로 넣고 이 프로젝트 -USED_SKILL-> Skill로 잇는다. 린터·포매터·타입 정의·테스트 도구 같은 개발 보조 도구(eslint, prettier, @types/…, husky 등)는 넣지 않는다.
R5. myRole·result·learned·성과(Achievement)는 저장소만으로 단정하지 않는다. 별·포크·커밋 수는 성과가 아니다 — Achievement로 만들지 않는다.
R6. 커밋 메시지는 무엇을 했는지만 보여 준다. 왜 했는지·어떤 효과가 있었는지는 묻는다.
R7. followUpQuestions는 최대 ${MAX_REPO_IMPORT_QUESTIONS}개, 이 순서로 저장소만으로 알 수 없는 것을 하나씩 구체적으로 묻는다: (1) 이 프로젝트에서 내 역할과 맡은 비중, (2) 시작한 배경·풀려던 문제, (3) 측정할 수 있는 결과(수치), (4) 팀 구성과, 커밋 기록 기준 기간이 실제 진행 기간과 맞는지(지금도 진행 중인지), (5) 배운 점. 위 P2의 '정확히 1개'는 이번 답에는 적용하지 않는다.
R8. deleteNode·deleteEdge는 쓰지 않는다. 새 Project를 만들지 않는다. 연산은 ${MAX_REPO_IMPORT_OPS}개를 넘지 않는다.
R9. 각 연산에서 해당 없는 필드는 "" 또는 []로 둔다. updateNode에는 채울 속성만 넣는다("" 값은 기존 값을 지우므로 넣지 않는다).

${GRAPH_DATE_RULES}

${INJECTION_RULE}`;

export function buildRepoImportPrompt(input: {
  graph: CareerGraph;
  focusProjectId: string;
  brief: string;
  today?: Date;
}): { system: string; user: string } {
  const focusText = projectFocusText(input.graph, input.focusProjectId) ?? `구조화할 프로젝트: [${input.focusProjectId}]`;
  const user = [
    field("본인 이름", input.graph.person.name ?? "(모름)"),
    "",
    "현재 경험 그래프([id]로 기존 노드를 가리킨다):",
    wrapData(CHAT_TAGS.careerGraph, graphToText(input.graph, { maxChars: REPO_IMPORT_GRAPH_MAX_CHARS })),
    "",
    "이 대화에서 구조화할 프로젝트(모든 변경안은 이 프로젝트에 붙인다):",
    wrapData(CHAT_TAGS.focusProject, focusText),
    "",
    repoBriefHeading,
    wrapData(CHAT_TAGS.githubRepo, input.brief),
    STAGE_TASK_DELIMITER,
    field("오늘 날짜", todayText(kstToday(input.today ?? Date.now()))),
    field("구조화할 프로젝트 id", input.focusProjectId),
    "",
    "할 일: 저장소 정보로 이 프로젝트의 비어 있는 속성과 사용 기술을 채우는 변경안을 만들고, 저장소만으로 알 수 없는 것을 followUpQuestions로 묻는다.",
  ].join("\n");
  return { system: GRAPH_REPO_IMPORT_SYSTEM, user };
}

/** 저장소 요약 블록의 제목(가져오기와 이후 대화가 같다). */
export const repoBriefHeading = "이 프로젝트의 GitHub 저장소 정보(저장소에서 읽은 자료 — 제3자가 쓴 글이 섞여 있을 수 있다):";

/** 이후 대화 프롬프트(구분자 앞, 캐시 접두사)에 넣는 저장소 블록. */
export function repoBriefBlock(brief: string): string[] {
  return ["", repoBriefHeading, wrapData(CHAT_TAGS.githubRepo, brief)];
}
