import { describe, expect, it } from "vitest";
import type { PostingImportJob } from "@/lib/domain/postings";
import { EMPTY_EXPLORE_FILTERS, exploreSearchParams, parseExploreSearchParams } from "@/lib/domain/shared-postings";
import { mergeImportResults, upsertImportJob } from "./import-jobs";

const job = (id: string, status: PostingImportJob["status"], over: Partial<PostingImportJob> = {}): PostingImportJob => ({
  id,
  url: `https://x.example/${id}`,
  status,
  error: null,
  errorCode: null,
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

  it("링크 없는 원문 붙여넣기 작업의 원문(pastedText)은 실패로 끝나도 남는다(다시 붙여넣기 입력에 채움)", () => {
    const { jobs } = mergeImportResults(
      [{ ...job("a", "analyzing", { url: "" }), pastedText: "원문" }],
      [job("a", "failed", { url: "", error: "공고 내용을 찾지 못했습니다." })],
    );
    expect(jobs[0]).toMatchObject({ status: "failed", url: "", pastedText: "원문" });
  });
});

describe("upsertImportJob", () => {
  it("새 작업을 맨 앞에, 같은 id는 바꿔 끼우고 개수를 자른다", () => {
    const list = [job("a", "queued"), job("b", "queued")];
    expect(upsertImportJob(list, job("b", "reading")).map((j) => `${j.id}:${j.status}`)).toEqual(["b:reading", "a:queued"]);
    expect(upsertImportJob(list, job("c", "queued"), 2).map((j) => j.id)).toEqual(["c", "a"]);
  });
});

describe("exploreSearchParams(공고 찾기 주소)", () => {
  it("빈 조건·기본 마감(마감 전)·병역특례 전체·1쪽은 싣지 않는다", () => {
    expect(exploreSearchParams(EMPTY_EXPLORE_FILTERS)).toBe("");
    expect(exploreSearchParams({ ...EMPTY_EXPLORE_FILTERS, company: " 토스 ", tech: "React", deadline: "soon", military: "expert" }, 2)).toBe(
      "company=%ED%86%A0%EC%8A%A4&tech=React&deadline=soon&military=expert&page=2",
    );
    expect(exploreSearchParams({ ...EMPTY_EXPLORE_FILTERS, deadline: "all" }, 1)).toBe("deadline=all");
  });
  it("주소 → 조건·쪽(틀린 값은 기본값), 다시 주소로 돌리면 같다", () => {
    const qs = "q=ios&deadline=soon&military=industrial&page=3";
    const parsed = parseExploreSearchParams(Object.fromEntries(new URLSearchParams(qs)));
    expect(parsed).toEqual({ filters: { ...EMPTY_EXPLORE_FILTERS, q: "ios", deadline: "soon", military: "industrial" }, page: 3 });
    expect(exploreSearchParams(parsed.filters, parsed.page)).toBe(qs);
    expect(parseExploreSearchParams({ deadline: "nope", military: "x", page: "-1" })).toEqual({ filters: EMPTY_EXPLORE_FILTERS, page: 1 });
    expect(parseExploreSearchParams({ page: "abc" }).page).toBe(1);
    expect(parseExploreSearchParams({ hidden: "only" }).filters.hiddenOnly).toBe(true);
  });
});
