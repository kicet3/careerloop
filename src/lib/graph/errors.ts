/** 그래프 기능 오류(순수 모듈 — 라우트 오류 응답에서 neo4j 드라이버를 불러오지 않고 instanceof로 쓸 수 있게 분리). */

/** 변경 연산이 형식·존재·관계 방향 검사를 통과하지 못함(400). 아무것도 쓰지 않았다. */
export class GraphOpError extends Error {
  readonly status = 400;
  constructor(
    message: string,
    /** 문제가 된 연산의 순번(0부터). */
    readonly index?: number,
  ) {
    super(index === undefined ? message : `변경 #${index + 1}: ${message}`);
    this.name = "GraphOpError";
  }
}

/** NEO4J_URI가 없어 그래프 저장소를 쓸 수 없음(503). */
export class GraphUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "경력 그래프 저장소(Neo4j)가 설정되지 않았습니다.") {
    super(message);
    this.name = "GraphUnavailableError";
  }
}
