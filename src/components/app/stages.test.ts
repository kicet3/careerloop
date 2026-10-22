import { describe, expect, it } from "vitest";
import { STAGE_KEYS } from "@/lib/domain/schemas";
import { formatElapsed, groupStatus, STAGE_GROUPS, type StageState } from "./stages";

const st = (pairs: [StageState["stage"], StageState["status"]][]): StageState[] =>
  pairs.map(([stage, status]) => ({ stage, status, error: null }));

describe("STAGE_GROUPS", () => {
  it("13단계를 빠짐없이 한 번씩 담는다", () => {
    const all = STAGE_GROUPS.flatMap((g) => g.stages);
    expect(all.sort()).toEqual([...STAGE_KEYS].sort());
  });
});

describe("groupStatus", () => {
  const keys = ["rewrite", "plan"] as const;
  it("전부 대기면 pending", () => {
    expect(groupStatus([...keys], [])).toBe("pending");
  });
  it("일부 완료면 running", () => {
    expect(groupStatus([...keys], st([["rewrite", "done"]]))).toBe("running");
  });
  it("전부 완료면 done", () => {
    expect(groupStatus([...keys], st([["rewrite", "done"], ["plan", "done"]]))).toBe("done");
  });
  it("하나라도 실패면 failed", () => {
    expect(groupStatus([...keys], st([["rewrite", "failed"], ["plan", "running"]]))).toBe("failed");
  });
});

describe("formatElapsed", () => {
  it("분·초로 표시", () => {
    expect(formatElapsed(5_000)).toBe("5초");
    expect(formatElapsed(125_000)).toBe("2분 05초");
  });
});
