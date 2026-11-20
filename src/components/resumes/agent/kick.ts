/**
 * 대기 중인 에이전트 작업에 이어 가기(POST …/advance)를 보낸다. 동시 작업이 여러 개(MAX_ACTIVE_AGENT_JOBS)라서
 * 지금 보고 있는 작업뿐 아니라 내 다른 작업도 열려 있는 화면(진행 화면·이력서 목록)이 함께 밀어 준다 —
 * 연쇄(서명된 자기 호출)가 꺼진 배포에서 화면에 없는 작업이 멈춰 자리를 차지하지 않게.
 * 작업마다 한 번에 하나(응답 전 재전송 없음). 서버는 리스로 중복 실행을 막는다.
 */
const inFlight = new Set<string>();

export function kickAgentJobs(ids: readonly string[]): void {
  for (const id of ids) {
    if (inFlight.has(id)) continue;
    inFlight.add(id);
    void fetch(`/api/resumes/agent-jobs/${encodeURIComponent(id)}/advance`, { method: "POST" })
      .catch(() => undefined) // 다음 폴링에서 다시.
      .finally(() => inFlight.delete(id));
  }
}
