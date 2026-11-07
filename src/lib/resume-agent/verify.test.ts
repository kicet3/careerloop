import { describe, expect, it } from "vitest";
import { ResumeDocumentSchema } from "@/lib/domain/resumes";
import { verifyDraft, MAX_DROP_RATIO } from "./verify";
import { draft, exp, item, pack, proj } from "./__fixtures__/units";

const P = pack([
  item("E1", { label: "Role", name: "백엔드 개발자", text: "department: 주문플랫폼팀", period: "2021.03 ~ 현재", facts: { company: "페이랩", startDate: "2021.03", endDate: "", current: true } }),
  item("E2", { text: "result: 주문 처리 시간을 1,200ms에서 300ms로 줄였다 | myRole: 백엔드 리드", skills: ["Kotlin", "Kafka"] }),
  item("E3", { label: "Skill", name: "React", skills: ["React"] }),
], { skillKeys: ["Kotlin", "Kafka", "React"] });

describe("verifyDraft", () => {
  it("인용 없는 줄은 지우고(항목 인용 상속), 25%를 넘으면 지우지 않고 재작성 신호", () => {
    const d = draft(
      { experience: [exp({ bullets: ["주문 처리 시간을 1200ms에서 300ms로 줄였다", "근거 없는 줄", "또 근거 없는 줄"] })] },
      [{ path: "experience[0].bullets[0]", refs: ["E2"], requirementIds: [] }],
    );
    // experience[0] 항목 인용이 없고 줄 하나만 인용: 항목 뼈대는 직무 노드와 이름이 같아 자동 인용된다 → 나머지 줄도 상속.
    const r = verifyDraft(d, P, null, { allowRetry: true });
    expect(r.needsRetry).toBe(false);
    expect(r.draft.document.experience[0]!.bullets).toHaveLength(3);

    const noRole = draft({ experience: [exp({ title: "다른 직무", bullets: ["근거 없는 줄", "또 근거 없는 줄", "주문 처리 시간을 1200ms에서 300ms로 줄였다"] })] }, [
      { path: "experience[0].bullets[2]", refs: ["E2"], requirementIds: [] },
    ]);
    const retry = verifyDraft(noRole, P, null, { allowRetry: true });
    expect(MAX_DROP_RATIO).toBe(0.25);
    expect(retry.needsRetry).toBe(true);
    expect(retry.uncitedPaths).toEqual(expect.arrayContaining(["experience[0].bullets[0]", "experience[0].bullets[1]"]));
    const dropped = verifyDraft(noRole, P, null, { allowRetry: false, retried: true });
    expect(dropped.draft.document.experience[0]!.bullets).toEqual(["주문 처리 시간을 1200ms에서 300ms로 줄였다"]);
    expect(dropped.report.dropped.map((x) => x.path)).toEqual(["experience[0].bullets[1]", "experience[0].bullets[0]"]);
    expect(dropped.report.retriedForCitations).toBe(true);
  });

  it("[ADD: …]만 있는 줄은 인용이 없어도 남긴다", () => {
    const d = draft({ summary: "[ADD: 대표 성과]", experience: [exp({ bullets: ["x"] })] }, [{ path: "experience[0]", refs: ["E1"], requirementIds: [] }]);
    expect(verifyDraft(d, P, null, { allowRetry: false }).draft.document.summary).toBe("[ADD: 대표 성과]");
  });

  it("근거에 없는 숫자 → [ADD: 수치 확인 — …](쉼표·[ADD] 안 숫자·총 경력 칸은 무시)", () => {
    const d = draft(
      {
        basics: { ...draft().document.basics, totalExperience: "5년 3개월" },
        experience: [exp({ bullets: ["주문 처리 시간을 1200ms에서 300ms로 줄였다", "매출을 30% 늘렸다", "[ADD: 2024년 지표] 확인"] })],
      },
      [
        { path: "experience[0]", refs: ["E1", "E2"], requirementIds: [] },
        { path: "summary", refs: ["E1"], requirementIds: [] },
      ],
    );
    // 총 경력은 직무 기간(2021.03 ~ 현재)으로 서버가 계산한다: 2026.05 기준 63개월 = 5년 3개월.
    const r = verifyDraft(d, P, null, { allowRetry: false, asOf: new Date(2026, 4, 15) });
    const b = r.draft.document.experience[0]!.bullets;
    expect(b[0]).toBe("주문 처리 시간을 1200ms에서 300ms로 줄였다");
    expect(b[1]).toBe("[ADD: 수치 확인 — 매출을 30% 늘렸다]");
    expect(b[2]).toBe("[ADD: 2024년 지표] 확인");
    expect(r.report.numbersFlagged).toEqual([{ path: "experience[0].bullets[1]", numbers: ["30"] }]);
    expect(r.draft.document.basics.totalExperience).toBe("5년 3개월");
    expect(r.draft.missingInfo.some((m) => m.includes("30"))).toBe(true);
  });

  it("기술명: 그래프 기술(별칭 '리액트'↔React)·인용 근거에 있는 것만 남긴다", () => {
    const d = draft({ projects: [proj({ summary: "s", techs: ["Kotlin", "리액트", "Terraform"] })] }, [{ path: "projects[0]", refs: ["E2"], requirementIds: [] }]);
    const r = verifyDraft(d, P, null, { allowRetry: false });
    expect(r.draft.document.projects[0]!.techs).toEqual(["Kotlin", "리액트"]);
    expect(r.report.dropped).toEqual([{ path: "projects[0].techs", text: "Terraform", reason: "unknown_skill" }]);
  });

  it("경력 뼈대(회사·직무·기간)는 인용한 직무 노드 값으로 고친다", () => {
    const d = draft({ experience: [exp({ company: "페이 랩스", title: "서버 개발자", startDate: "2020.01", endDate: "2023.01" })] }, [
      { path: "experience[0]", refs: ["E1"], requirementIds: [] },
    ]);
    const r = verifyDraft(d, P, null, { allowRetry: false });
    expect(r.draft.document.experience[0]).toMatchObject({ company: "페이랩", title: "백엔드 개발자", startDate: "2021.03", endDate: "현재" });
    expect(r.report.corrected.map((c) => c.path)).toEqual(["experience[0].title", "experience[0].company", "experience[0].startDate", "experience[0].endDate", "basics.totalExperience"]);
  });

  it("pack 밖 ref는 버리고 근거가 남지 않으면 항목째 지운다", () => {
    const d = draft({ projects: [proj({ name: "지어낸 프로젝트", summary: "무언가" })] }, [{ path: "projects[0]", refs: ["E77"], requirementIds: [] }]);
    const r = verifyDraft(d, P, null, { allowRetry: false, invalidRefPaths: ["projects[0]"] });
    expect(r.draft.document.projects).toHaveLength(0);
    expect(r.report.dropped).toEqual([{ path: "projects[0]", text: "지어낸 프로젝트", reason: "invalid_ref" }]);
  });

  it("riskyClaims: gap 요건을 인용한 줄, 근거에 없는 주도·최상급 표현", () => {
    const d = draft(
      { experience: [exp({ bullets: ["결제 시스템을 총괄했다", "업계 최초로 도입했다", "Kafka 운영"] })] },
      [
        { path: "experience[0]", refs: ["E1"], requirementIds: [] },
        { path: "experience[0].bullets[2]", refs: ["E2"], requirementIds: ["R5"] },
      ],
    );
    const r = verifyDraft(d, P, { requirementMap: [{ requirementId: "R5", status: "gap", refs: [], angle: "" }] }, { allowRetry: false });
    expect(r.report.riskyClaims.map((x) => [x.path, x.reason])).toEqual([
      ["experience[0].bullets[0]", "ownership"],
      ["experience[0].bullets[1]", "superlative"],
      ["experience[0].bullets[2]", "gap_requirement"],
    ]);
  });

  describe("수치 자리표시 길이·문장 단위", () => {
    const asOf = new Date(2026, 4, 15);
    it("칸 상한 근처 tagline(200)은 상한 안에서 닫는 괄호를 남기고, 문서 스키마를 통과한다", () => {
      const tagline = `결제 지연을 99% 줄인 ${"가".repeat(180)}`.slice(0, 195);
      const d = draft({ basics: { ...draft().document.basics, tagline }, experience: [exp({ bullets: ["x"] })] }, [
        { path: "experience[0]", refs: ["E1"], requirementIds: [] },
        { path: "summary", refs: ["E1"], requirementIds: [] },
      ]);
      const r = verifyDraft(d, P, null, { allowRetry: false, asOf });
      const t = r.draft.document.basics.tagline;
      expect(t.length).toBeLessThanOrEqual(200);
      expect(t.startsWith("[ADD: 수치 확인 — ")).toBe(true);
      expect(t.endsWith("…]")).toBe(true);
      expect(ResumeDocumentSchema.safeParse(r.draft.document).success).toBe(true);
    });

    it("여러 문장 요약(600자)은 근거 없는 숫자가 든 문장만 감싸고, 길면 상한 안에서 자른다", () => {
      const ok = "주문 처리 시간을 1,200ms에서 300ms로 줄였습니다.";
      const bad = "매출을 30% 늘렸습니다.";
      const d = draft({ summary: `${ok} ${bad} 결제 도메인 백엔드 개발자입니다.`, experience: [exp({ bullets: ["x"] })] }, [
        { path: "experience[0]", refs: ["E1"], requirementIds: [] },
        { path: "summary", refs: ["E2"], requirementIds: [] },
      ]);
      const r = verifyDraft(d, P, null, { allowRetry: false, asOf });
      expect(r.draft.document.summary).toBe(`${ok} [ADD: 수치 확인 — ${bad}] 결제 도메인 백엔드 개발자입니다.`);

      const long = `${"가".repeat(560)} 매출을 30% 늘렸습니다`;
      const d2 = draft({ experience: [exp({ scope: long, bullets: ["x"] })] }, [{ path: "experience[0]", refs: ["E1"], requirementIds: [] }]);
      const s = verifyDraft(d2, P, null, { allowRetry: false, asOf }).draft.document.experience[0]!.scope;
      expect(s.length).toBeLessThanOrEqual(600);
      expect(s.endsWith("]")).toBe(true);
      // 다음 검증에서 다시 잡히지 않는다(자리표시 안 숫자는 확인하지 않는다 — 겹쳐 감싸지 않음).
      const again = verifyDraft({ ...d2, document: { ...d2.document, experience: [exp({ scope: s, bullets: ["x"] })] } }, P, null, { allowRetry: false, asOf });
      expect(again.draft.document.experience[0]!.scope).toBe(s);
      expect(again.report.numbersFlagged).toEqual([]);
    });

    it("기간 숫자(연·월·개월 수)와 총 경력('5년 차')은 근거로 본다", () => {
      const PP = pack(
        [
          item("E1", { label: "Role", name: "백엔드 개발자", period: "2021.03 ~ 현재", facts: { company: "페이랩", startDate: "2021.03", endDate: "", current: true } }),
          item("E2", { name: "Kafka 도입", text: "result: 지연 40% 감소", period: "2022.03 ~ 2022.12", facts: { company: null, startDate: "2022.03", endDate: "2022.12", current: false } }),
        ],
        { skillKeys: [] },
      );
      const d = draft(
        {
          basics: { ...draft().document.basics, tagline: "결제 지연을 줄여 온 6년 차 백엔드 개발자", totalExperience: "7년 3개월" },
          experience: [exp({ bullets: ["2022년 Kafka 도입으로 지연 40% 감소", "10개월간 Kafka 전환", "2022.03부터 3월까지 준비"] })],
        },
        [
          { path: "experience[0]", refs: ["E1", "E2"], requirementIds: [] },
          { path: "summary", refs: ["E1"], requirementIds: [] },
        ],
      );
      const r = verifyDraft(d, PP, null, { allowRetry: false, asOf });
      expect(r.report.numbersFlagged).toEqual([]);
      expect(r.draft.document.basics.tagline).toBe("결제 지연을 줄여 온 6년 차 백엔드 개발자");
      // 총 경력은 모델 값이 아니라 직무 기간으로 계산한다(2021.03 ~ 2026.05 = 5년 3개월).
      expect(r.draft.document.basics.totalExperience).toBe("5년 3개월");
      expect(r.report.corrected).toContainEqual({ path: "basics.totalExperience", before: "7년 3개월", after: "5년 3개월" });
    });
  });

  it("프로젝트 기간은 인용한 노드 값으로, 팀 구성 숫자·근거 없는 '리드' 역할은 자리표시로, 학력·자격 날짜·발급처는 그래프 값으로", () => {
    const PP = pack([
      item("E1", { label: "Role", name: "백엔드 개발자", period: "2021.03 ~ 현재", facts: { company: "페이랩", startDate: "2021.03", endDate: "", current: true } }),
      item("E2", { name: "주문 시스템", text: "action: 이벤트 분리", facts: { company: null, startDate: "2022.03", endDate: "2023.01", current: false } }),
      item("E3", { label: "Education", name: "한국대학교", text: "degree: 학사 | major: 컴퓨터공학", facts: { company: null, startDate: "2015.03", endDate: "2021.02", current: false } }),
      item("E4", { label: "Certification", name: "정보처리기사", text: "issuer: 한국산업인력공단", facts: { company: null, startDate: "2020.11", endDate: "", current: false } }),
    ]);
    const d = draft(
      {
        experience: [exp({ bullets: ["x"] })],
        projects: [proj({ name: "주문 시스템", summary: "이벤트 분리", startDate: "2020.01", endDate: "2020.12", team: "백엔드 3·디자인 1", role: "PL·백엔드 리드" })],
        education: [{ school: "한국대학교", degree: "석사", major: "컴퓨터공학", startDate: "2014.03", endDate: "2020.02", note: "" }],
        certifications: [{ name: "정보처리기사", issuer: "어딘가", date: "2019.05" }],
      },
      [
        { path: "experience[0]", refs: ["E1"], requirementIds: [] },
        { path: "projects[0]", refs: ["E2"], requirementIds: [] },
      ],
    );
    const r = verifyDraft(d, PP, null, { allowRetry: false, asOf: new Date(2026, 4, 15) });
    const p = r.draft.document.projects[0]!;
    expect([p.startDate, p.endDate]).toEqual(["2022.03", "2023.01"]);
    expect(p.team).toBe("[ADD: 수치 확인 — 백엔드 3·디자인 1]");
    expect(p.role).toBe("[ADD: 역할 확인 — PL·백엔드 리드]");
    expect(r.draft.document.education[0]).toMatchObject({ degree: "", major: "컴퓨터공학", startDate: "2015.03", endDate: "2021.02" });
    expect(r.draft.document.certifications[0]).toMatchObject({ issuer: "", date: "2020.11" });
  });

  it("전략이 뺀 근거(plan.exclude)만 인용한 줄·항목은 지우고(excluded), 재작성 비율에 세지 않는다", () => {
    const PP = pack([
      item("E1", { label: "Role", name: "백엔드 개발자", period: "2021.03 ~ 현재", facts: { company: "페이랩", startDate: "2021.03", endDate: "", current: true } }),
      item("E2", { name: "주문 시스템" }),
      item("E9", { label: "Certification", name: "워드프로세서" }),
    ]);
    const d = draft(
      { experience: [exp({ bullets: ["x"] })], projects: [proj({ summary: "s" })], certifications: [{ name: "워드프로세서", issuer: "", date: "" }], extras: [{ title: "기타", items: ["사내 체육대회 우승"] }] },
      [
        { path: "experience[0]", refs: ["E1"], requirementIds: [] },
        { path: "projects[0]", refs: ["E2"], requirementIds: [] },
        { path: "extras[0].items[0]", refs: ["E9"], requirementIds: [] },
      ],
    );
    const plan = {
      requirementMap: [],
      include: { experience: [], projects: [{ ref: "E2", why: "", requirementIds: [] }], extras: [] },
      exclude: [
        { ref: "E9", reason: "직무 무관" },
        { ref: "E2", reason: "넣기로도 함 — 넣는 쪽이 이긴다" },
      ],
      keywordPlan: [],
    };
    const retry = verifyDraft(d, PP, plan, { allowRetry: true });
    expect(retry.needsRetry).toBe(false);
    const r = retry;
    expect(r.draft.document.certifications).toHaveLength(0);
    expect(r.draft.document.extras[0]!.items).toEqual([]);
    expect(r.draft.document.projects).toHaveLength(1);
    expect(r.report.dropped.map((x) => x.reason)).toEqual(["excluded", "excluded"]);
  });
});
