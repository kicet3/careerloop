/**
 * 작성 팁 패널: JD가 있으면 'JD 맞춤 팁' 탭이 맨 앞·기본, 공용 이력서·JD 없음이면 기본 팁만(writingTipTabs).
 * JdTipsView: 불러오는 중·없음(만들기)·no_jd·ready(구역별 묶음·키워드 ✓ 포함/추가 필요·쓸 만한 경험·다시 만들기)·stale 안내·오류.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ResumeJdTipsResponse } from "@/lib/domain/resume-jd-tips";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { JdTipsView } from "./JdTipsTab";
import { ResumeWritingTips, writingTipTabs } from "./ResumeWritingTips";

const noop = () => {};
const ready: Extract<ResumeJdTipsResponse, { status: "ready" | "stale" }> = {
  status: "ready",
  reused: false,
  createdAt: Date.UTC(2026, 10, 7),
  coverage: [],
  tips: {
    summary: [
      { kind: "duty", text: "결제 API 개발" },
      { kind: "required", text: "Kotlin 서버 개발 경험" },
      { kind: "preferred", text: "AWS 운영 경험" },
    ],
    sections: [
      { section: "first", tips: [{ tip: "한 줄 소개에 결제 API 개발을 드러내세요", jdQuote: "결제 API 개발" }] },
      { section: "projects", tips: [{ tip: "Kafka 파이프라인 프로젝트를 위로 올리세요", jdQuote: "Kafka 이벤트 파이프라인" }] },
    ],
    keywords: ["Kotlin", "AWS"],
    experiences: [{ name: "주문 시스템 개편", kind: "프로젝트", section: "projects", why: "Kafka 요건과 이어짐" }],
    notices: [],
  },
};
const view = (data: ResumeJdTipsResponse | null, extra: Partial<Parameters<typeof JdTipsView>[0]> = {}) =>
  renderToStaticMarkup(<JdTipsView data={data} coverage={[]} generating={false} error={null} onGenerate={noop} {...extra} />);

describe("ResumeWritingTips", () => {
  it("접힌 머리: 작성 팁 버튼(aria-expanded=false)", () => {
    const html = renderToStaticMarkup(<ResumeWritingTips resumeId="r1" kind="company" document={emptyResumeDocument()} jdAvailable jdKey="x" />);
    expect(html).toContain("작성 팁");
    expect(html).toContain('aria-expanded="false"');
  });

  it("탭: 지원처별 + JD면 'JD 맞춤 팁'이 맨 앞·기본, 공용·JD 없음이면 기본 팁만(기본 탭 유지)", () => {
    const withJd = writingTipTabs("company", true);
    expect(withJd.defaultTab).toBe("jd");
    expect(withJd.tabs.map((t) => t.label)).toEqual(["JD 맞춤 팁", "첫 화면 4요소", "프로젝트 구조", "성과 숫자", "협업·개성", "제출 전 체크리스트"]);
    for (const [kind, jd] of [["company", false], ["general", true], ["general", false]] as const) {
      const t = writingTipTabs(kind, jd);
      expect(t.defaultTab).toBe("first");
      expect(t.tabs.map((x) => x.id)).not.toContain("jd");
      expect(t.tabs).toHaveLength(5);
    }
  });
});

describe("JdTipsView", () => {
  it("불러오는 중·오류(다시 불러오기)", () => {
    expect(view(null)).toContain("불러오는 중");
    const err = view(null, { error: "JD 맞춤 팁을 불러오지 못했습니다.", onRetryLoad: noop });
    expect(err).toContain('role="alert"');
    expect(err).toContain("다시 불러오기");
  });

  it("no_jd: 공용·JD 없음 안내(만들기 버튼 없음)", () => {
    expect(view({ status: "no_jd", reason: "general" })).toContain("공용 이력서");
    const empty = view({ status: "no_jd", reason: "empty" });
    expect(empty).toContain("JD를 붙여 넣거나 공고를 연결");
    expect(empty).not.toContain("<button");
  });

  it("none: 'JD 맞춤 팁 만들기', 만드는 중이면 비활성", () => {
    expect(view({ status: "none" })).toContain("JD 맞춤 팁 만들기");
    const busy = view({ status: "none" }, { generating: true });
    expect(busy).toContain("만드는 중…");
    expect(busy).toContain("disabled");
  });

  it("ready: JD 요약·키워드 칩(✓ 포함/추가 필요)·구역별 팁(공고 인용)·쓸 만한 경험·다시 만들기", () => {
    const html = view(ready, {
      coverage: [
        { keyword: "Kotlin", included: true },
        { keyword: "AWS", included: false },
      ],
    });
    expect(html).toContain("JD 요약");
    expect(html).toContain("핵심 업무");
    expect(html).toContain("우대");
    expect(html).toContain("포함 1/2");
    expect(html).toMatch(/Kotlin <span[^>]*>✓ 포함/);
    expect(html).toMatch(/AWS <span[^>]*>추가 필요/);
    expect(html.indexOf("첫 화면 · 한 줄 소개·요약")).toBeLessThan(html.indexOf(">프로젝트<"));
    expect(html).toContain("공고: “결제 API 개발”");
    expect(html).toContain("내 경험에서 쓸 만한 것");
    expect(html).toContain("주문 시스템 개편");
    expect(html).toContain("다시 만들기");
    expect(html).not.toContain("바뀌었습니다");
  });

  it("stale: JD가 바뀌었다는 안내, reused: 다른 이력서의 팁을 다시 씀, 생성 오류 표시", () => {
    const stale = view({ ...ready, status: "stale" }, { error: "JD 맞춤 팁은 하루 10번까지 만들 수 있습니다." });
    expect(stale).toContain("바뀌었습니다");
    expect(stale).toContain("하루 10번");
    expect(view({ ...ready, reused: true })).toContain("다른 내 이력서의 팁을 다시 썼습니다");
  });
});
