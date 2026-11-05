import { describe, expect, it } from "vitest";
import type { PostingImportJob } from "@/lib/domain/postings";
import { exploreQueryString, EMPTY_EXPLORE_FILTERS } from "./ExploreView";
import { mergeImportResults, upsertImportJob } from "./import-jobs";

const job = (id: string, status: PostingImportJob["status"], over: Partial<PostingImportJob> = {}): PostingImportJob => ({
  id,
  url: `https://x.example/${id}`,
  status,
  error: null,
  postingId: null,
  sharedPostingId: null,
  refresh: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

describe("mergeImportResults", () => {
  it("이번에 completed가 된 작업만 돌려준다(이미 끝난 작업·실패·요청 실패는 아님)", () => {
    const prev = [job("a", "analyzing"), job("b", "reading"), job("c", "completed"), job("d", "queued")];
    const { jobs, newlyCompleted } = mergeImportResults(prev, [
      job("a", "completed", { postingId: "p1" }),
      job("b", "failed", { error: "실패" }),
      job("c", "completed"),
      null,
    ]);
    expect(newlyCompleted.map((j) => j.id)).toEqual(["a"]);
    expect(newlyCompleted[0]!.postingId).toBe("p1");
    expect(jobs.map((j) => j.status)).toEqual(["completed", "failed", "completed", "queued"]);
  });

  it("화면 전용 값(fromShared)은 유지한다", () => {
    const { jobs } = mergeImportResults([{ ...job("a", "queued"), fromShared: true }], [job("a", "reading")]);
    expect(jobs[0]).toMatchObject({ status: "reading", fromShared: true });
  });
});

describe("upsertImportJob", () => {
  it("새 작업을 맨 앞에, 같은 id는 바꿔 끼우고 개수를 자른다", () => {
    const list = [job("a", "queued"), job("b", "queued")];
    expect(upsertImportJob(list, job("b", "reading")).map((j) => `${j.id}:${j.status}`)).toEqual(["b:reading", "a:queued"]);
    expect(upsertImportJob(list, job("c", "queued"), 2).map((j) => j.id)).toEqual(["c", "a"]);
  });
});

describe("exploreQueryString", () => {
  it("빈 조건은 싣지 않고 마감 조건은 항상 싣는다", () => {
    expect(exploreQueryString(EMPTY_EXPLORE_FILTERS, 0)).toBe("deadline=open");
    expect(exploreQueryString({ ...EMPTY_EXPLORE_FILTERS, company: " 토스 ", tech: "React", deadline: "soon" }, 2)).toBe(
      "company=%ED%86%A0%EC%8A%A4&tech=React&deadline=soon&page=2",
    );
  });
});
