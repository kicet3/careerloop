/**
 * 다듬기 항목 제안 카드: 여러 칸 고치기(칸마다 전/후·체크·적용 버튼 하나), 새 항목 추가(미리보기), 상태 배지,
 * 전체 이력서 답변·칸 답변 안의 카드, 예전 메시지(항목 제안 없음)는 예전처럼 그린다.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/lib/domain/chat";
import type { PolishItemSuggestion, ResumePolishData, ResumePolishDocData } from "@/lib/domain/resume-polish";
import { EMPTY_RESUME_ITEM } from "@/lib/domain/resumes";
import { DocMessage } from "./PolishDocumentChat";
import { PolishItemCard } from "./PolishItemCard";
import { MessageBubble } from "./PolishPanel";

const project = { ...EMPTY_RESUME_ITEM.project(), name: "정산 개편", problem: "정산이 늦었다" };

const edit: PolishItemSuggestion = {
  kind: "item-edit",
  section: "projects",
  index: 0,
  label: "프로젝트 1 · 정산 개편",
  changes: [
    { field: "name", label: "프로젝트 이름", before: "정산 개편", after: "결제 개선", flagged: [] },
    { field: "result", label: "결과", before: "", after: "[ADD: 수치 확인 — 정산 시간 73% 단축]", flagged: ["73"] },
    { field: "techs", label: "기술", before: [], after: ["Go", "Kafka"], flagged: [] },
  ],
  reason: "한 번에 채웠다",
  flagged: ["73"],
};

const add: PolishItemSuggestion = {
  kind: "item-add",
  section: "projects",
  index: 1,
  label: "새 프로젝트 · 결제 개선",
  changes: [
    { field: "name", label: "프로젝트 이름", before: "", after: "결제 개선", flagged: [] },
    { field: "problem", label: "문제", before: "", after: "[ADD: 문제 — 어떤 상황이었는지]", flagged: [] },
  ],
  item: { ...EMPTY_RESUME_ITEM.project(), name: "결제 개선", problem: "[ADD: 문제 — 어떤 상황이었는지]" },
  reason: "그래프에 있다",
  flagged: [],
};

const noop = () => {};
/** 태그를 뺀 글(낱말 차이는 조각마다 태그로 감싼다). */
const text = (html: string) => html.replace(/<[^>]+>/g, "");
const base = { excluded: [] as string[], dirty: false, applying: false, onApply: noop };

describe("PolishItemCard", () => {
  it("고치기: 칸마다 이름·전/후, 칸 체크, 적용 버튼 하나(고를 칸 수)", () => {
    const html = renderToStaticMarkup(<PolishItemCard {...base} suggestion={edit} state="live" current={project} onToggleField={noop} />);
    expect(html).toContain("3칸 한 번에");
    expect(html).toContain("프로젝트 1 · 정산 개편");
    for (const label of ["프로젝트 이름", "결과", "기술"]) expect(html).toContain(label);
    expect(text(html)).toContain("결제 개선");
    expect(text(html)).toContain("근거 확인 필요: 73");
    expect(html.match(/aria-label="[^"]+ 적용"/g)).toHaveLength(3);
    expect(html).toContain("적용(3칸 · 새 버전 저장)");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>적용\(3칸/);
  });

  it("체크를 푼 칸은 빼고 센다, 바뀐 칸이 있으면 표시하고 그 칸을 고르면 적용할 수 없다", () => {
    const off = renderToStaticMarkup(<PolishItemCard {...base} suggestion={edit} state="live" current={project} excluded={["techs"]} onToggleField={noop} />);
    expect(off).toContain("적용(2칸 · 새 버전 저장)");
    const changed = { ...project, name: "사용자가 바꾼 이름" };
    const stale = renderToStaticMarkup(<PolishItemCard {...base} suggestion={edit} state="stale" current={changed} onToggleField={noop} />);
    expect(stale).toContain("제안 뒤 바뀐 칸");
    expect(stale).toMatch(/<button[^>]*disabled=""[^>]*>적용\(3칸/);
    const without = renderToStaticMarkup(<PolishItemCard {...base} suggestion={edit} state="stale" current={changed} excluded={["name"]} onToggleField={noop} />);
    expect(without).not.toMatch(/<button[^>]*disabled=""[^>]*>적용\(2칸/);
  });

  it("추가: 새 항목 미리보기와 추가 버튼, 이미 추가했으면 배지·버튼 꺼짐, 상한이면 안내", () => {
    const html = renderToStaticMarkup(<PolishItemCard {...base} suggestion={add} state="live" />);
    expect(html).toContain("새 항목 추가");
    expect(html).toContain("새 프로젝트 · 결제 개선");
    expect(html).toContain("[ADD: 문제 — 어떤 상황이었는지]");
    expect(html).toContain("추가(새 버전 저장)");
    const done = renderToStaticMarkup(<PolishItemCard {...base} suggestion={add} state="applied" />);
    expect(done).toContain("추가함");
    expect(done).toMatch(/<button[^>]*disabled=""[^>]*>추가/);
    expect(renderToStaticMarkup(<PolishItemCard {...base} suggestion={add} state="full" />)).toContain("항목 수 상한");
  });

  it("같은 자리에 다른 항목이 오면(anchor가 다르면) 칸 값이 같아도 적용할 수 없다", () => {
    const anchored = { ...edit, anchor: { name: "정산 개편", company: "", startDate: "", endDate: "" } };
    // 이름 칸은 고칠 칸이라 anchor에서 빠지지만, 여기서는 정체 칸으로 이름을 둔 예전 형태를 흉내 낸다.
    const other = { ...project, name: "다른 프로젝트" };
    const html = renderToStaticMarkup(
      <PolishItemCard {...base} suggestion={{ ...anchored, changes: anchored.changes.filter((c) => c.field !== "name") }} state="stale" current={other} onToggleField={noop} />,
    );
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>적용\(2칸/);
    expect(html).toContain("제안 뒤 바뀐 항목");
  });

  it("저장하지 않은 변경이 있으면 적용할 수 없다", () => {
    const html = renderToStaticMarkup(<PolishItemCard {...base} dirty suggestion={edit} state="live" current={project} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>적용/);
  });
});

const msg = (data: unknown, status: ChatMessage["status"] = "proposed"): ChatMessage =>
  ({ id: "m1", threadId: "t", role: "assistant", content: "이렇게 고쳐 볼 수 있어요.", status, data, createdAt: 0 }) as unknown as ChatMessage;

describe("답변 안의 카드·예전 메시지", () => {
  const sections = { projects: [project], experience: [] };
  const docProps = { dirty: false, applying: false, selected: [] as number[], onToggle: noop, onApply: noop, onJump: noop, sections };

  it("전체 이력서 답변: 예전 메시지(칸 제안만, kind 없음)는 예전처럼 칸 카드로 그린다", () => {
    const data: ResumePolishDocData = {
      kind: "resume-polish-doc",
      targetPath: "document",
      sourceVersionId: null,
      answerFlagged: [],
      suggestions: [{ path: "summary", label: "요약", before: "옛 요약", after: "새 요약", reason: "짧게", flagged: [] }],
      dropped: 0,
      followUpQuestion: "",
      graphSources: 0,
    };
    const html = renderToStaticMarkup(<DocMessage {...docProps} message={msg(data)} fields={{ summary: "옛 요약" }} />);
    expect(html).toContain("칸으로 이동");
    expect(text(html)).toContain("새 요약");
    expect(html).not.toContain("polish-item-card");
  });

  it("전체 이력서 답변: 항목 고치기·추가 카드를 프로젝트 구역에 그린다", () => {
    const data: ResumePolishDocData = {
      kind: "resume-polish-doc",
      targetPath: "document",
      sourceVersionId: null,
      answerFlagged: [],
      suggestions: [edit, add],
      dropped: 0,
      followUpQuestion: "",
      graphSources: 0,
    };
    const html = renderToStaticMarkup(<DocMessage {...docProps} message={msg(data)} fields={{}} />);
    expect(html.match(/data-testid="polish-item-card"/g)).toHaveLength(2);
    expect(html).toContain(">프로젝트</p>");
    expect(html).toContain("선택 적용");
  });

  it("전체 이력서 답변: 적용 기록이 있는 추가는 문서에서 알아볼 수 없어도 '추가함'이고 다시 추가할 수 없다", () => {
    const data: ResumePolishDocData = {
      kind: "resume-polish-doc",
      targetPath: "document",
      sourceVersionId: null,
      answerFlagged: [],
      suggestions: [add],
      dropped: 0,
      followUpQuestion: "",
      graphSources: 0,
      applied: [{ index: 0, versionId: "v2" }],
    };
    const html = renderToStaticMarkup(<DocMessage {...docProps} message={msg(data)} fields={{}} />);
    expect(html).toContain("추가함");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>추가\(새 버전 저장\)/);
  });

  it("칸 답변: 예전 메시지는 대안 문구만, 항목 제안이 있으면 카드를 더 그린다(적용한 답변이면 적용함)", () => {
    const old: ResumePolishData = {
      kind: "resume-polish",
      targetPath: "projects[0].problem",
      before: "정산이 늦었다",
      sourceVersionId: null,
      suggestions: [{ text: "월말 정산이 늦었다", reason: "구체적", flagged: [] }],
      followUpQuestion: "",
      graphSources: 0,
    };
    const item = { section: "projects" as const, index: 0, value: project as unknown as Record<string, unknown> };
    const oldHtml = renderToStaticMarkup(<MessageBubble message={msg(old)} stale={false} selected={null} onPick={noop} item={item} />);
    expect(oldHtml).toContain("월말 정산이 늦었다");
    expect(oldHtml).not.toContain("polish-item-card");
    const withItem = renderToStaticMarkup(<MessageBubble message={msg({ ...old, itemSuggestion: edit })} stale={false} selected={null} onPick={noop} item={item} />);
    expect(withItem).toContain("polish-item-card");
    expect(withItem).toContain("적용(3칸 · 새 버전 저장)");
    const applied = renderToStaticMarkup(
      <MessageBubble message={msg({ ...old, itemSuggestion: edit, appliedItem: true }, "applied")} stale={false} selected={null} onPick={noop} item={item} />,
    );
    expect(applied).toContain("적용함");
    expect(applied).toMatch(/<button[^>]*disabled=""[^>]*>적용\(3칸/);
  });
});
