/**
 * 경험 그래프 소유자 표시 — 다른 사용자의 그래프가 LLM 프롬프트·MCP 응답에 섞이지 않게 하는 마지막 확인(심층 방어).
 * getCareerGraph가 읽은 그래프 객체에 요청 userId를 단다(객체 밖 WeakMap — 직렬화·API 응답에 실리지 않는다).
 * 그래프를 프롬프트·도구 응답에 쓰기 직전에 assertGraphOwner로 요청 사용자와 같은지 본다.
 * 표시는 그 객체에만 붙는다(복사본에는 없다). 표시 없는 그래프(테스트 고정값·복사본)는 통과, 다른 사용자 표시면 막는다.
 */

const owners = new WeakMap<object, string>();

/** 그래프 소유자가 요청 사용자와 다르다(버그 — 다른 사용자의 그래프를 쓰려 했다). */
export class GraphOwnerMismatchError extends Error {
  constructor() {
    super("다른 사용자의 경험 그래프를 쓰려고 했습니다.");
    this.name = "GraphOwnerMismatchError";
  }
}

/** 그래프 객체에 소유자를 단다. 같은 객체를 돌려준다. */
export function markGraphOwner<T extends object>(graph: T, userId: string): T {
  owners.set(graph, userId);
  return graph;
}

/** 단 소유자(없으면 undefined). */
export function graphOwnerOf(graph: object): string | undefined {
  return owners.get(graph);
}

/** 소유자 표시가 있고 userId와 다르면 GraphOwnerMismatchError. 같은 객체를 돌려준다. */
export function assertGraphOwner<T extends object>(graph: T, userId: string): T {
  const owner = owners.get(graph);
  if (owner !== undefined && owner !== userId) throw new GraphOwnerMismatchError();
  return graph;
}
