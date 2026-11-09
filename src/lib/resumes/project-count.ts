/**
 * 이력서 생성 시 대표 프로젝트 개수 기준(기본 2~3개, 순수). 단일 초안(draft.ts)·그래프 에이전트(resume-agent)가 같은 상수·문구를 쓴다.
 * Python 워커(worker/app/jobs/resume_draft_output.py check_project_count)가 같은 규칙을 옮겼다 — 바꾸면 fixture를 다시 만든다.
 * 사실을 지어내지 않는다: 모자라면 자료의 다른 프로젝트를 고르라고 하거나 사용자에게 묻고, 넘치면 앞(관련도 순)의 3개만 남긴다.
 */

export const PROJECT_COUNT_MIN = 2;
export const PROJECT_COUNT_MAX = 3;

/** 프롬프트 규칙 한 줄(단일 초안 규칙 11·v1 계획·v2 구역 에이전트). */
export const PROJECT_COUNT_RULE =
  "프로젝트는 기본 2~3개를 쓴다: 자료(경험 그래프의 프로젝트·기존 이력서·저장소)에 있는 프로젝트 중 JD(없으면 지원 직무)와 가장 관련 있는 것부터 고르고, 3개가 넘으면 관련도 높은 3개만 쓴다. 자료에 프로젝트가 2개 미만이면 개수를 맞추려고 지어내지 말고 있는 만큼만 쓰며(없으면 빈 배열) missingInfo에 다른 프로젝트를 묻는 질문을 남긴다.";

/** 프로젝트가 2개 미만일 때 사용자에게 묻는 질문. */
export const PROJECT_MORE_QUESTION = "이 직무와 관련해 이력서에 더 넣을 프로젝트(이름·기간·내 역할·결과)가 있나요? 대표 프로젝트는 2~3개를 권장합니다.";

export interface ProjectCountCheck {
  /** 남길 앞쪽 프로젝트 수(넘치면 PROJECT_COUNT_MAX, 아니면 그대로). */
  keep: number;
  notes: string[];
  missingInfo: string[];
}

/**
 * 생성 결과의 프로젝트 수 점검(결정적). available은 자료에 있는 프로젝트 수(경험 그래프 Project 노드 수 — 모르면 null).
 * - 3개 초과: 앞의 3개만 남기고 뺀 이름을 notes에 적는다(조용히 지우지 않는다).
 * - 2개 미만: missingInfo에 질문을 더하고, 자료에 쓰지 않은 프로젝트가 더 있으면 notes에 알린다(내용을 지어 채우지 않는다).
 */
export function checkProjectCount(projects: readonly { name: string }[], available: number | null): ProjectCountCheck {
  const n = projects.length;
  if (n > PROJECT_COUNT_MAX) {
    const dropped = projects
      .slice(PROJECT_COUNT_MAX)
      .map((p) => p.name.trim() || "(이름 없음)")
      .join(", ");
    return { keep: PROJECT_COUNT_MAX, notes: [`대표 프로젝트는 2~3개 기준이라 앞의 ${PROJECT_COUNT_MAX}개만 남기고 ${dropped}를 뺐습니다.`], missingInfo: [] };
  }
  if (n >= PROJECT_COUNT_MIN) return { keep: n, notes: [], missingInfo: [] };
  const notes =
    available !== null && available >= PROJECT_COUNT_MIN && available > n
      ? [`경험 그래프에 프로젝트가 ${available}개 있지만 초안에는 ${n}개만 들어갔습니다. 다시 생성하거나 직접 더해 대표 프로젝트를 2~3개로 맞춰 주세요.`]
      : [];
  return { keep: n, notes, missingInfo: [PROJECT_MORE_QUESTION] };
}
