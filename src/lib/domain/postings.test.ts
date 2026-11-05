import { describe, expect, it } from "vitest";
import { ApplicationCreateInputSchema, ApplicationUpdateInputSchema } from "./applications";
import { PostingCreateInputSchema, PostingUpdateInputSchema, postingDeadlineError } from "./postings";

describe("공고 입력 스키마", () => {
  it("기본값과 마감 종류를 채운다", () => {
    const a = PostingCreateInputSchema.parse({ company: " 토스 ", roleTitle: "백엔드" });
    expect(a).toMatchObject({ company: "토스", status: "saved", deadline: "", deadlineKind: "unspecified", employmentType: "unknown" });
    const b = PostingCreateInputSchema.parse({ company: "토스", roleTitle: "백엔드", deadline: "2026-11-20", deadlineTime: "18:00" });
    expect(b.deadlineKind).toBe("date");
  });

  it("마감 필드가 서로 맞지 않으면 거절한다", () => {
    expect(PostingCreateInputSchema.safeParse({ company: "a", roleTitle: "b", deadlineTime: "18:00" }).success).toBe(false);
    expect(PostingCreateInputSchema.safeParse({ company: "a", roleTitle: "b", deadline: "2026-02-30" }).success).toBe(false);
    expect(PostingCreateInputSchema.safeParse({ company: "a", roleTitle: "b", deadline: "2026-11-20", deadlineKind: "rolling" }).success).toBe(false);
    expect(postingDeadlineError({ deadline: "", deadlineTime: "", deadlineKind: "date" })).not.toBeNull();
    expect(postingDeadlineError({ deadline: "", deadlineTime: "", deadlineKind: "rolling" })).toBeNull();
  });

  it("모르는 필드·빈 PATCH는 거절한다", () => {
    expect(PostingCreateInputSchema.safeParse({ company: "a", roleTitle: "b", userId: "x" }).success).toBe(false);
    expect(PostingUpdateInputSchema.safeParse({}).success).toBe(false);
    expect(PostingUpdateInputSchema.parse({ status: "planned" })).toEqual({ status: "planned" });
  });
});

describe("지원 입력 스키마", () => {
  it("공고가 없으면 회사·직무가 필요하다", () => {
    expect(ApplicationCreateInputSchema.safeParse({}).success).toBe(false);
    expect(ApplicationCreateInputSchema.parse({ postingId: "p1" })).toMatchObject({ stage: "applied", company: "", nextDate: null });
    expect(ApplicationCreateInputSchema.parse({ company: "토스", roleTitle: "백엔드", appliedAt: "" }).appliedAt).toBeNull();
  });

  it("버전만 고르거나 틀린 날짜는 거절한다", () => {
    expect(ApplicationCreateInputSchema.safeParse({ postingId: "p1", resumeVersionId: "v1" }).success).toBe(false);
    expect(ApplicationCreateInputSchema.safeParse({ postingId: "p1", nextDate: "2026-13-01" }).success).toBe(false);
  });

  it("PATCH로 단계는 못 바꾼다", () => {
    expect(ApplicationUpdateInputSchema.safeParse({ stage: "offer" }).success).toBe(false);
    expect(ApplicationUpdateInputSchema.parse({ nextDate: "2026-11-10" })).toEqual({ nextDate: "2026-11-10" });
  });
});
