"use client";

/**
 * 성과 중심 이력서 양식(docs/reference/resume-template-performance.html)을 React로 옮긴 A4 시트.
 * - onChange가 있으면 편집 모드: 각 칸이 contenteditable="plaintext-only"이고 입력이 ResumeDocument 상태로 들어간다.
 *   항목 추가·삭제 버튼, 1장 넘침 표시(원본 checkFit), 원본의 '작성 안내'를 함께 보인다.
 * - 없으면 읽기 전용(버전 미리보기·서버 렌더 테스트).
 * 사용자 값은 언제나 텍스트 노드(React 자식 또는 textContent)로만 넣는다 — innerHTML·dangerouslySetInnerHTML을 쓰지 않는다.
 * 빈 칸은 CSS(:empty::before)로 원본의 대괄호 안내 문구를 보인다. 안내 문구는 값이 아니라서 저장·PDF에 들어가지 않는다.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ElementType, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { MonthPickerButton } from "@/components/ui/MonthInput";
import { CURRENT_TEXT } from "@/lib/dates/month-input";
import {
  EMPTY_RESUME_ITEM,
  RESUME_SECTION_LABELS,
  type ResumeDocument,
  type ResumeExperience,
  type ResumeHeadingKey,
  type ResumeProject,
} from "@/lib/domain/resumes";
import { motivationParagraphs, PERFORMANCE_HEADINGS, splitAddMarkers } from "@/lib/resumes/layout";
import "./performance-sheet.css";
import { itemKeys, patchItem, useAnnouncer, useReorder, type ReorderHandlers } from "./reorder";
import { MOBILE_QUERY, SHEET_PAGE_GAP, useSheetPages } from "./sheet-pagination";

type Doc = ResumeDocument;

/** 클래스 이름(performance-sheet.css). */
const css = {
  add: "pf-add",
  addBullet: "pf-add-bullet",
  addButton: "pf-add-button",
  body: "pf-body",
  contact: "pf-contact",
  date: "pf-date",
  datePick: "pf-date-pick",
  detail: "pf-detail",
  education: "pf-education",
  entry: "pf-entry",
  entryHead: "pf-entry-head",
  entryMeta: "pf-entry-meta",
  entryTitle: "pf-entry-title",
  evidence: "pf-evidence",
  experience: "pf-experience",
  field: "pf-field",
  header: "pf-header",
  highlightContext: "pf-highlight-context",
  highlightTitle: "pf-highlight-title",
  highlights: "pf-highlights",
  identityRow: "pf-identity-row",
  intro: "pf-intro",
  item: "pf-item",
  multiline: "pf-multiline",
  name: "pf-name",
  notes: "pf-notes",
  overflow: "pf-overflow",
  page: "pf-page",
  pageNo: "pf-page-no",
  photo: "pf-photo",
  pages: "pf-pages",
  paged: "pf-paged",
  period: "pf-period",
  project: "pf-project",
  remove: "pf-remove",
  reorder: "pf-reorder",
  srOnly: "pf-sr-only",
  result: "pf-result",
  role: "pf-role",
  root: "pf-root",
  section: "pf-section",
  sectionContent: "pf-section-content",
  sectionLabel: "pf-section-label",
  sheet: "pf-sheet",
  sheetWrap: "pf-sheet-wrap",
  skills: "pf-skills",
  status: "pf-status",
  tagline: "pf-tagline",
} as const;

/** 항목 수 한도(ResumeDocumentSchema와 같다). */
const LIMITS = {
  highlights: 8,
  experience: 20,
  projects: 20,
  skills: 10,
  education: 10,
  certifications: 20,
  bullets: 15,
};

// ---------------------------------------------------------------------------
// 원본의 대괄호 안내 문구. 첫 항목과 그다음 항목의 문구가 다른 곳은 [첫 번째, 나머지].
// ---------------------------------------------------------------------------

const PH = {
  name: "[이름]",
  headline: "[지원 직무]",
  tagline: "[한 줄 소개]",
  totalExperience: "[0년 0개월]",
  email: "[이메일 주소]",
  phone: "[연락처]",
  portfolioUrl: "[포트폴리오 또는 업무 자료 URL]",
  summary:
    "[주요 고객·업무의 문제]를 [핵심 방법]으로 개선하는 [직무명]입니다.\n[핵심 경험·도메인]에서 [담당 범위]를 맡아 [확인 가능한 결과]를 만들었습니다.",
  highlightTitle: ["[직무 KPI] [기준값] → [개선값] · [개선 폭과 단위]", "[대표 변화 또는 도입 결과] · [확인 가능한 규모]"],
  highlightContext: ["[측정 기간·대상] / [본인이 수행한 핵심 행동]", "[적용 범위·확인 시점] / [조직에 남은 기여]"],
  company: ["[최근 회사명]", "[이전 회사명 또는 주요 활동]"],
  start: "[YYYY.MM]",
  end: ["[현재 / YYYY.MM]", "[YYYY.MM]"],
  department: ["[부서]", "[부서·조직]"],
  title: ["[직무·직급]", "[역할]"],
  scope: ["[서비스·제품·업무]의 [담당 범위]를 맡아 [주요 책임]을 수행.", "[지원 직무와 관련된 경험]을 수행하며 [확인 가능한 결과]를 달성."],
  bullet: "[직접 결정·실행한 일]로 [검증된 변화 또는 성과]에 기여.",
  projectName: ["[문제와 변화가 드러나는 프로젝트명]", "[다른 핵심 역량을 보여주는 프로젝트명]"],
  projectStart: "[YYYY.MM",
  projectEnd: "MM]",
  projectCompany: "[회사·활동명]",
  team: "[팀 구성]",
  role: "[결정·실행 범위]",
  problem: ["[어떤 자료]로 [개선이 필요한 원인·상황]을 확인.", "[고객·동료·업무]의 [문제]와 [목표 또는 제약]을 파악."],
  action: ["[선택 기준]에 따라 [본인의 판단·실행·협업]을 수행.", "[비교한 대안·합의 기준]을 바탕으로 [본인 행동]을 실행."],
  result: ["[기간·대상]에서 [지표 전후 변화 또는 검증 결과] 확인.", "[확인한 결과]를 얻고 [프로세스·기준·산출물]을 정착."],
  evidence: "[측정 자료명 또는 공개 가능한 링크]",
  skillName: ["[업무·방법론]", "[도구·기술]"],
  skillDetail: ["[실제로 수행할 수 있는 일과 적용 경험]", "[도구명]을 활용한 [분석·설계·개발·운영 범위]"],
  // 원본은 '[학교·전공]' 한 칸이지만 문서에서는 학교와 전공이 따로라 두 칸으로 나눴다.
  school: "[학교]",
  major: "[전공]",
  degree: "[학위·졸업 상태]",
  eduPeriod: "[YYYY.MM - YYYY.MM]",
  certName: "[직무 관련 자격·교육]",
  issuer: "[발급·운영 기관]",
  certDate: "[YYYY.MM]",
} as const;

const pick = (v: string | readonly string[], i: number): string => (typeof v === "string" ? v : (v[Math.min(i, v.length - 1)] ?? ""));

/** 원본 '작성 안내'. 버튼 이름만 이 화면에 맞게 바꿨다. */
export const PERFORMANCE_NOTES = [
  "수치에는 기간·대상·비교 기준을 함께 적고, 팀의 성과와 본인의 역할을 구분하세요.",
  "대괄호는 실제 정보로 바꾸세요. 수치가 없다면 확인 가능한 산출물·적용 범위를 적으세요.",
  "신입이라면 ‘경력’을 ‘관련 경험’으로 바꾸고 인턴·교육·개인 프로젝트의 성격을 밝혀 주세요. 섹션 제목도 클릭해 바꿀 수 있습니다.",
  "‘PDF 내려받기’는 저장한 버전으로 같은 디자인의 A4 PDF를 만듭니다. 빈 칸과 안내 문구는 PDF에 찍히지 않습니다.",
  "수정 내용은 자동 저장되지 않습니다. ‘저장’을 누르면 새 버전으로 보관되고, 버전 목록에서 언제든 되돌릴 수 있습니다.",
];

// ---------------------------------------------------------------------------
// 편집 칸
// ---------------------------------------------------------------------------

interface FieldProps {
  /** 테스트·포커스 이동용 경로(예: "experience.0.company"). */
  path: string;
  value: string;
  placeholder: string;
  label: string;
  max: number;
  as?: ElementType;
  className?: string;
  multiline?: boolean;
  /** 편집 모드일 때만. */
  onChange?: (v: string) => void;
  /** 한 줄 칸에서 Enter. */
  onEnter?: () => void;
  /** 빈 칸에서 Backspace. */
  onBackspaceEmpty?: () => void;
}

/** innerText는 브라우저가 넣은 <br>도 줄바꿈으로 읽는다. 남은 줄바꿈 하나뿐이면 빈 값. */
function readText(el: HTMLElement): string {
  const t = (el.innerText ?? el.textContent ?? "").replace(/\r/g, "");
  return t === "\n" ? "" : t;
}

function caretToEnd(el: HTMLElement) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** 칸 안 커서 위치(글자 수). 커서가 칸 밖이면 null. */
function caretOffset(el: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.endContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.endContainer, range.endOffset);
  return pre.toString().length;
}

function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection();
  const node = el.firstChild;
  if (!sel || !node || node.nodeType !== Node.TEXT_NODE) return caretToEnd(el);
  const range = document.createRange();
  range.setStart(node, Math.min(offset, node.textContent?.length ?? 0));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {splitAddMarkers(text).map((p, i) =>
        p.add ? (
          <mark key={i} className={css.add}>
            {p.text}
          </mark>
        ) : (
          p.text
        ),
      )}
    </>
  );
}

function Field(props: FieldProps) {
  return props.onChange ? <EditableField {...props} onChange={props.onChange} /> : <StaticField {...props} />;
}

function StaticField({ path, value, placeholder, as: Tag = "span", className, multiline }: FieldProps) {
  return (
    <Tag className={cn(css.field, multiline && css.multiline, className)} data-field={path} data-empty={placeholder}>
      {value ? <RichText text={value} /> : null}
    </Tag>
  );
}

/**
 * contenteditable 칸. React가 입력 중인 텍스트 노드를 다시 그리면 커서가 튀므로, 자식은 처음 값으로 고정하고
 * 바깥 값이 DOM과 달라졌을 때만(복원·폼 탭 편집·항목 삭제로 자리 이동) textContent로 맞춘다.
 */
function EditableField({
  path,
  value,
  placeholder,
  label,
  max,
  as: Tag = "span",
  className,
  multiline,
  onChange,
  onEnter,
  onBackspaceEmpty,
}: FieldProps & { onChange: (v: string) => void }) {
  const ref = useRef<HTMLElement>(null);
  const [initial] = useState(value);
  const sanitize = (raw: string) => {
    const next = multiline ? raw : raw.replace(/\n+/g, " ");
    return next.length > max ? next.slice(0, max) : next;
  };
  /** 줄바꿈·길이 초과를 정리해 DOM에 반영하고 값을 알린다. 고쳐 쓸 때 커서는 원래 자리(넘치면 끝)로 돌려 둔다. */
  const normalizeField = (el: HTMLElement) => {
    const raw = readText(el);
    const next = sanitize(raw);
    if (next !== raw || raw === "") {
      // 붙여넣은 줄바꿈·길이 초과를 정리했거나, 다 지웠는데 <br>이 남아 안내 문구가 안 보이는 경우.
      const at = caretOffset(el);
      el.textContent = next;
      if (next) {
        if (at === null) caretToEnd(el);
        else setCaret(el, at);
      }
    }
    onChange(next);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && readText(el) !== value) el.textContent = value;
  }, [value]);

  return (
    <Tag
      ref={ref}
      className={cn(css.field, multiline && css.multiline, className)}
      contentEditable="plaintext-only"
      suppressContentEditableWarning
      role="textbox"
      aria-label={label}
      aria-multiline={multiline || undefined}
      spellCheck={false}
      data-field={path}
      data-empty={placeholder}
      onInput={(e: React.FormEvent<HTMLElement>) => {
        // 한글 조합 중에는 DOM을 고쳐 쓰지 않는다(조합이 끊겨 글자가 사라진다). 값을 올리면 바깥 값 동기화(useLayoutEffect)가
        // DOM을 다시 쓸 수 있으므로 정리·반영은 compositionend에서 한 번에 한다.
        if ((e.nativeEvent as InputEvent).isComposing) return;
        normalizeField(e.currentTarget);
      }}
      onCompositionEnd={(e: React.CompositionEvent<HTMLElement>) => normalizeField(e.currentTarget)}
      onPaste={(e: React.ClipboardEvent<HTMLElement>) => {
        // 붙여넣기는 정리한 글을 커서 자리에 직접 넣는다(나중에 고쳐 쓰면 커서가 칸 끝으로 튄다).
        const text = e.clipboardData.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        const el = e.currentTarget;
        const selected = window.getSelection()?.toString().length ?? 0;
        const room = Math.max(0, max - (readText(el).length - selected));
        const clean = (multiline ? text.replace(/\r\n?/g, "\n") : text.replace(/[\r\n]+/g, " ")).slice(0, room);
        if (clean && !document.execCommand("insertText", false, clean)) normalizeField(el);
      }}
      onKeyDown={(e: React.KeyboardEvent<HTMLElement>) => {
        if (e.key === "Enter" && !multiline && !e.nativeEvent.isComposing) {
          e.preventDefault();
          onEnter?.();
        } else if (e.key === "Backspace" && onBackspaceEmpty && readText(e.currentTarget) === "") {
          e.preventDefault();
          onBackspaceEmpty();
        }
      }}
    >
      {initial}
    </Tag>
  );
}

/**
 * 기간 칸(시작·종료): 칸에 바로 쓰고, 편집 모드면 옆의 작은 달력 버튼으로도 고른다(YYYY.MM — draft-rules와 같은 형식).
 * 버튼은 칸 위 여백에 띄워 줄 높이·쪽 나눔을 바꾸지 않고, 화면에서만 보인다(PDF는 서버가 따로 그린다).
 */
function DateField(props: FieldProps & { end?: boolean }) {
  const { end, ...field } = props;
  const onChange = field.onChange;
  if (!onChange) return <Field {...field} />;
  return (
    <span className={css.date}>
      <Field {...field} />
      <MonthPickerButton
        value={field.value}
        format="dot"
        label={`${field.label} 달력에서 고르기`}
        onPick={onChange}
        onPickCurrent={end ? () => onChange(CURRENT_TEXT) : undefined}
        wrapperClassName={css.datePick}
        className="size-full rounded-full"
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// 시트
// ---------------------------------------------------------------------------

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className={css.remove} aria-label={label} title={label} onClick={onClick}>
      ×
    </button>
  );
}

/**
 * 순서 바꾸기 컨트롤(끌기 손잡이·위·아래). 삭제 버튼 옆 여백에 띄워(absolute) 본문 높이·쪽 나눔에 영향이 없고,
 * 편집 모드 화면에서만 그린다(미리보기·PDF에는 없다. PDF는 서버가 저장 문서로 따로 그린다).
 */
function ReorderControls({ r, i, label }: { r: ReorderHandlers; i: number; label: string }) {
  return (
    <div className={css.reorder}>
      {/* 손잡이는 span(role=button): Firefox는 <button>을 끌지 못한다. */}
      <span
        role="button"
        tabIndex={0}
        {...r.handle(i)}
        aria-label={`${label} 순서 바꾸기`}
        aria-roledescription="끌기 손잡이"
        aria-keyshortcuts="ArrowUp ArrowDown Home End"
        title="끌어서 순서 바꾸기 · 방향키 ↑↓, Home/End로도 옮깁니다"
      >
        <span aria-hidden>⠿</span>
      </span>
      <button type="button" {...r.up(i)} aria-label={`${label} 위로 이동`} title="위로">
        ↑
      </button>
      <button type="button" {...r.down(i)} aria-label={`${label} 아래로 이동`} title="아래로">
        ↓
      </button>
    </div>
  );
}

/** 끌기 중 표시(놓을 자리 위/아래 선). */
function dragAttrs(r: { dragging: number | null; over: number | null }, i: number) {
  return {
    "data-dragging": r.dragging === i || undefined,
    "data-drop-target": r.dragging !== null && r.over === i && r.dragging !== i ? (r.dragging > i ? "before" : "after") : undefined,
  };
}

interface AddSpec {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

function AddButton({
  label,
  onClick,
  disabled,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button type="button" className={cn(css.addButton, className)} onClick={onClick} disabled={disabled}>
      + {label}
    </button>
  );
}

function Section({
  id,
  doc,
  edit,
  add,
  children,
  contentAs: Content = "div",
  contentClassName,
}: {
  id: ResumeHeadingKey;
  doc: Doc;
  edit?: (d: Doc) => void;
  add?: AddSpec | AddSpec[];
  children: ReactNode;
  contentAs?: ElementType;
  contentClassName?: string;
}) {
  return (
    <section className={css.section} data-section={id} aria-label={doc.headings[id] || PERFORMANCE_HEADINGS[id]}>
      <div className={css.sectionLabel}>
        <Field
          as="h2"
          path={`headings.${id}`}
          value={doc.headings[id]}
          placeholder={PERFORMANCE_HEADINGS[id]}
          label="섹션 제목"
          max={30}
          onChange={edit ? (v) => edit({ ...doc, headings: { ...doc.headings, [id]: v } }) : undefined}
        />
        {edit && add && [add].flat().map((a) => <AddButton key={a.label} label={a.label} onClick={a.onClick} disabled={a.disabled} />)}
      </div>
      <Content className={cn(css.sectionContent, contentClassName)}>{children}</Content>
    </section>
  );
}

export function PerformanceSheet({
  document: doc,
  onChange,
  className,
  photoUrl = null,
}: {
  document: ResumeDocument;
  /** 있으면 편집 모드. */
  onChange?: (doc: ResumeDocument) => void;
  className?: string;
  /** 머리글 프로필 사진 주소(소유자만 읽는 /api/account/photo). 없으면 사진 칸을 그리지 않는다. */
  photoUrl?: string | null;
}) {
  const editable = !!onChange;
  const bodyRef = useRef<HTMLDivElement>(null);
  // 쪽 나눔: 한 장을 넘으면 A4 쪽 카드로 나눠 보인다(sheet-pagination.ts). PDF도 같은 자리에서 쪽이 바뀐다.
  const pages = useSheetPages(bodyRef, doc);
  const [fitMode, setFitMode] = useState<"pending" | "mobile" | "a4">("pending");
  const fit =
    fitMode === "pending"
      ? { text: "분량 확인 중", over: false }
      : fitMode === "mobile"
        ? { text: "PDF는 A4로 만들어집니다", over: false }
        : pages > 1
          ? { text: `내용이 ${pages}쪽입니다 · 쪽 단위로 나눠 보입니다`, over: true }
          : { text: "현재 1장 범위", over: false };
  const [focusPath, setFocusPath] = useState<string | null>(null);

  // 원본 checkFit의 화면 판정: 좁은 화면은 A4가 아닌 모바일 배치라 쪽 수 대신 안내만 보인다.
  useEffect(() => {
    if (!editable) return;
    // 쪽 나눔(sheet-pagination.ts)과 같은 기준(CSS @media max-width: 600px)으로 판정한다.
    const mq = window.matchMedia(MOBILE_QUERY);
    const check = () => setFitMode(mq.matches ? "mobile" : "a4");
    check();
    mq.addEventListener("change", check);
    return () => mq.removeEventListener("change", check);
  }, [editable]);

  // 항목을 새로 만들면(Enter·추가 버튼) 그 칸으로 커서를 옮긴다.
  useEffect(() => {
    if (!focusPath) return;
    const el = bodyRef.current?.querySelector<HTMLElement>(`[data-field="${focusPath}"]`);
    if (el) {
      el.focus();
      caretToEnd(el);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 한 번 옮기고 비운다
    setFocusPath(null);
  }, [focusPath]);

  const edit = onChange;
  const on = <T,>(fn: (v: string) => T) => (edit ? fn : undefined);
  const set = (patch: Partial<Doc>) => edit?.({ ...doc, ...patch });
  const basics = (patch: Partial<Doc["basics"]>) => set({ basics: { ...doc.basics, ...patch } });
  // 고친 항목은 화면용 key를 이어받는다(reorder.ts) — 항목 key가 자리 번호가 아니라 항목을 따라가야 순서를 바꿔도 칸이 맞는다.
  const upAt = <T extends object>(xs: T[], i: number, patch: Partial<T>) => xs.map((x, k) => (k === i ? patchItem(x, patch) : x));
  const removeAt = <T,>(xs: T[], i: number) => xs.filter((_, k) => k !== i);
  const insertAt = <T,>(xs: T[], i: number, x: T) => [...xs.slice(0, i), x, ...xs.slice(i)];

  // 경력·프로젝트 순서 바꾸기(끌기·버튼·방향키). 훅은 읽기 전용에서도 부르지만 컨트롤은 편집 모드에서만 그린다.
  const [moved, announce] = useAnnouncer();
  const expOrder = useReorder({
    items: doc.experience,
    onChange: (experience) => set({ experience }),
    announce,
    name: (x, i) => `경력 ${i + 1}${x.company.trim() ? `(${x.company.trim()})` : ""}`,
  });
  const projOrder = useReorder({
    items: doc.projects,
    onChange: (projects) => set({ projects }),
    announce,
    name: (x, i) => `프로젝트 ${i + 1}${x.name.trim() ? `(${x.name.trim()})` : ""}`,
  });
  const keysOf = {
    highlights: itemKeys(doc.highlights),
    skills: itemKeys(doc.skills),
    education: itemKeys(doc.education),
    certifications: itemKeys(doc.certifications),
  };

  const b = doc.basics;

  // ----- 머리글
  const header = (
    <header className={css.header}>
      <div className={css.identityRow}>
        <div>
          <Field
            as="h1"
            className={css.name}
            path="basics.name"
            value={b.name}
            placeholder={PH.name}
            label="이름"
            max={80}
            onChange={on((v) => basics({ name: v }))}
          />
          <p className={css.role}>
            <Field
              path="basics.headline"
              value={b.headline}
              placeholder={PH.headline}
              label="지원 직무"
              max={160}
              onChange={on((v) => basics({ headline: v }))}
            />
            <span className={css.experience}>
              총 경력{" "}
              <Field
                path="basics.totalExperience"
                value={b.totalExperience}
                placeholder={PH.totalExperience}
                label="총 경력"
                max={40}
                onChange={on((v) => basics({ totalExperience: v }))}
              />
            </span>
          </p>
        </div>
        <div className={css.contact}>
          <Field
            as="div"
            path="basics.email"
            value={b.email}
            placeholder={PH.email}
            label="이메일"
            max={160}
            onChange={on((v) => basics({ email: v }))}
          />
          <Field
            as="div"
            path="basics.phone"
            value={b.phone}
            placeholder={PH.phone}
            label="전화번호"
            max={40}
            onChange={on((v) => basics({ phone: v }))}
          />
          <Field
            as="div"
            path="basics.portfolioUrl"
            value={b.portfolioUrl}
            placeholder={PH.portfolioUrl}
            label="포트폴리오 주소"
            max={500}
            onChange={on((v) => basics({ portfolioUrl: v }))}
          />
        </div>
        {photoUrl ? (
          // 소유자만 읽는 같은 출처 라우트(next/image 최적화를 거치지 않는다). PDF는 서버가 같은 사진을 data URI로 넣는다.
          // eslint-disable-next-line @next/next/no-img-element
          <img className={css.photo} src={photoUrl} alt="프로필 사진" data-resume-photo />
        ) : null}
      </div>
      {/* 한 줄 소개: 지원 직무 줄이 아니라 이름·연락처 아래 독립 줄. */}
      <Field
        as="p"
        className={css.tagline}
        path="basics.tagline"
        value={b.tagline}
        placeholder={PH.tagline}
        label="한 줄 소개"
        max={200}
        onChange={on((v) => basics({ tagline: v }))}
      />
      <Field
        as="p"
        className={css.intro}
        multiline
        path="summary"
        value={doc.summary}
        placeholder={PH.summary}
        label="직무 요약"
        max={1500}
        onChange={on((v) => set({ summary: v }))}
      />
    </header>
  );

  // ----- 핵심 성과
  const highlights = (
    <Section
      id="highlights"
      doc={doc}
      edit={edit}
      add={{
        label: "성과",
        disabled: doc.highlights.length >= LIMITS.highlights,
        onClick: () => {
          set({
            highlights: [...doc.highlights, EMPTY_RESUME_ITEM.highlight()],
          });
          setFocusPath(`highlights.${doc.highlights.length}.title`);
        },
      }}
    >
      <ul className={css.highlights}>
        {doc.highlights.map((h, i) => (
          <li key={keysOf.highlights[i]} className={css.item}>
            <Field
              as="div"
              className={css.highlightTitle}
              path={`highlights.${i}.title`}
              value={h.title}
              placeholder={pick(PH.highlightTitle, i)}
              label={`핵심 성과 ${i + 1}`}
              max={200}
              onChange={on((v) => set({ highlights: upAt(doc.highlights, i, { title: v }) }))}
            />
            <Field
              as="div"
              className={css.highlightContext}
              path={`highlights.${i}.context`}
              value={h.context}
              placeholder={pick(PH.highlightContext, i)}
              label={`핵심 성과 ${i + 1}의 근거`}
              max={300}
              onChange={on((v) => set({ highlights: upAt(doc.highlights, i, { context: v }) }))}
            />
            {edit && <RemoveButton label={`핵심 성과 ${i + 1} 삭제`} onClick={() => set({ highlights: removeAt(doc.highlights, i) })} />}
          </li>
        ))}
      </ul>
    </Section>
  );

  // ----- 경력
  const upExp = (i: number, patch: Partial<ResumeExperience>) => set({ experience: upAt(doc.experience, i, patch) });
  const experience = (
    <Section
      id="experience"
      doc={doc}
      edit={edit}
      add={{
        label: "경력",
        disabled: doc.experience.length >= LIMITS.experience,
        onClick: () => {
          set({
            experience: [...doc.experience, EMPTY_RESUME_ITEM.experience()],
          });
          setFocusPath(`experience.${doc.experience.length}.company`);
        },
      }}
    >
      {doc.experience.map((e, i) => {
        const n = i === 0 ? "최근" : `${i + 1}번째`;
        const addBullet = (at: number) => {
          if (e.bullets.length >= LIMITS.bullets) return;
          upExp(i, { bullets: insertAt(e.bullets, at, "") });
          setFocusPath(`experience.${i}.bullets.${at}`);
        };
        return (
          <article
            key={expOrder.keys[i]}
            className={cn(css.entry, css.item)}
            data-item={`experience.${i}`}
            {...(edit ? { ...expOrder.item(i), ...dragAttrs(expOrder, i) } : {})}
          >
            <div className={css.entryHead}>
              <Field
                as="div"
                className={css.entryTitle}
                path={`experience.${i}.company`}
                value={e.company}
                placeholder={pick(PH.company, i)}
                label={`${n} 회사명`}
                max={120}
                onChange={on((v) => upExp(i, { company: v }))}
              />
              <div className={css.period}>
                <DateField
                  path={`experience.${i}.startDate`}
                  value={e.startDate}
                  placeholder={PH.start}
                  label={`${n} 경력 시작`}
                  max={20}
                  onChange={on((v) => upExp(i, { startDate: v }))}
                />
                {" - "}
                <DateField end
                  path={`experience.${i}.endDate`}
                  value={e.endDate}
                  placeholder={pick(PH.end, i)}
                  label={`${n} 경력 종료`}
                  max={20}
                  onChange={on((v) => upExp(i, { endDate: v }))}
                />
              </div>
            </div>
            <div className={css.entryMeta}>
              <Field
                path={`experience.${i}.department`}
                value={e.department}
                placeholder={pick(PH.department, i)}
                label={`${n} 부서`}
                max={120}
                onChange={on((v) => upExp(i, { department: v }))}
              />
              {" · "}
              <Field
                path={`experience.${i}.title`}
                value={e.title}
                placeholder={pick(PH.title, i)}
                label={`${n} 직무`}
                max={120}
                onChange={on((v) => upExp(i, { title: v }))}
              />
            </div>
            <Field
              as="p"
              multiline
              path={`experience.${i}.scope`}
              value={e.scope}
              placeholder={pick(PH.scope, i)}
              label={`${n} 담당 범위`}
              max={600}
              onChange={on((v) => upExp(i, { scope: v }))}
            />
            {e.bullets.length > 0 && (
              <ul>
                {e.bullets.map((x, j) => (
                  <Field
                    key={j}
                    as="li"
                    path={`experience.${i}.bullets.${j}`}
                    value={x}
                    placeholder={PH.bullet}
                    label={`${n} 대표 기여 ${j + 1}`}
                    max={500}
                    onChange={on((v) =>
                      upExp(i, {
                        bullets: e.bullets.map((x, k) => (k === j ? v : x)),
                      }),
                    )}
                    onEnter={() => addBullet(j + 1)}
                    onBackspaceEmpty={() => {
                      upExp(i, { bullets: removeAt(e.bullets, j) });
                      if (j > 0) setFocusPath(`experience.${i}.bullets.${j - 1}`);
                    }}
                  />
                ))}
              </ul>
            )}
            {edit && (
              <>
                {/* 불릿 추가는 여백에 띄운 + 버튼(본문 높이·1장 판정에 영향이 없게). 불릿에서 Enter로도 추가된다. */}
                <button
                  type="button"
                  className={cn(css.remove, css.addBullet)}
                  aria-label={`${n} 경력에 대표 기여 추가`}
                  title="대표 기여 추가(불릿에서 Enter)"
                  disabled={e.bullets.length >= LIMITS.bullets}
                  onClick={() => addBullet(e.bullets.length)}
                >
                  +
                </button>
                <RemoveButton label={`${n} 경력 삭제`} onClick={() => set({ experience: removeAt(doc.experience, i) })} />
                {doc.experience.length > 1 && <ReorderControls r={expOrder} i={i} label={`${n} 경력`} />}
              </>
            )}
          </article>
        );
      })}
    </Section>
  );

  // ----- 대표 프로젝트
  const upProj = (i: number, patch: Partial<ResumeProject>) => set({ projects: upAt(doc.projects, i, patch) });
  const projects = (
    <Section
      id="projects"
      doc={doc}
      edit={edit}
      add={{
        label: "프로젝트",
        disabled: doc.projects.length >= LIMITS.projects,
        onClick: () => {
          set({ projects: [...doc.projects, EMPTY_RESUME_ITEM.project()] });
          setFocusPath(`projects.${doc.projects.length}.name`);
        },
      }}
    >
      {doc.projects.map((p, i) => {
        const n = i === 0 ? "첫" : `${i + 1}번째`;
        const detail = (key: "problem" | "action" | "result", dt: string) => (
          <dl className={cn(css.detail, key === "result" && css.result)}>
            <dt>{dt}</dt>
            <Field
              as="dd"
              multiline
              path={`projects.${i}.${key}`}
              value={p[key]}
              placeholder={pick(PH[key], i)}
              label={`${n} 프로젝트 ${dt}`}
              max={500}
              onChange={on((v) => upProj(i, { [key]: v }))}
            />
          </dl>
        );
        return (
          <article
            key={projOrder.keys[i]}
            className={cn(css.project, css.item)}
            data-item={`projects.${i}`}
            {...(edit ? { ...projOrder.item(i), ...dragAttrs(projOrder, i) } : {})}
          >
            <div className={css.entryHead}>
              <Field
                as="div"
                className={css.entryTitle}
                path={`projects.${i}.name`}
                value={p.name}
                placeholder={pick(PH.projectName, i)}
                label={`${n} 프로젝트명`}
                max={120}
                onChange={on((v) => upProj(i, { name: v }))}
              />
              <div className={css.period}>
                <DateField
                  path={`projects.${i}.startDate`}
                  value={p.startDate}
                  placeholder={PH.projectStart}
                  label={`${n} 프로젝트 시작`}
                  max={20}
                  onChange={on((v) => upProj(i, { startDate: v }))}
                />
                {" - "}
                <DateField end
                  path={`projects.${i}.endDate`}
                  value={p.endDate}
                  placeholder={PH.projectEnd}
                  label={`${n} 프로젝트 종료`}
                  max={20}
                  onChange={on((v) => upProj(i, { endDate: v }))}
                />
              </div>
            </div>
            <div className={css.entryMeta}>
              <Field
                path={`projects.${i}.company`}
                value={p.company}
                placeholder={PH.projectCompany}
                label={`${n} 프로젝트 회사·활동명`}
                max={120}
                onChange={on((v) => upProj(i, { company: v }))}
              />
              {" · "}
              <Field
                path={`projects.${i}.team`}
                value={p.team}
                placeholder={PH.team}
                label={`${n} 프로젝트 팀 구성`}
                max={120}
                onChange={on((v) => upProj(i, { team: v }))}
              />
              {" · 내 역할: "}
              <Field
                path={`projects.${i}.role`}
                value={p.role}
                placeholder={PH.role}
                label={`${n} 프로젝트 내 역할`}
                max={120}
                onChange={on((v) => upProj(i, { role: v }))}
              />
            </div>
            {detail("problem", "문제")}
            {detail("action", "행동")}
            {detail("result", "결과")}
            <div className={css.evidence}>
              근거:{" "}
              <Field
                path={`projects.${i}.evidence`}
                value={p.evidence}
                placeholder={PH.evidence}
                label={`${n} 프로젝트 근거`}
                max={300}
                onChange={on((v) => upProj(i, { evidence: v }))}
              />
            </div>
            {edit && <RemoveButton label={`${n} 프로젝트 삭제`} onClick={() => set({ projects: removeAt(doc.projects, i) })} />}
            {edit && doc.projects.length > 1 && <ReorderControls r={projOrder} i={i} label={`${n} 프로젝트`} />}
          </article>
        );
      })}
    </Section>
  );

  // ----- 직무 역량(항목/설명 쌍). 다른 양식에서 쓴 기술 목록(items)은 설명이 비었을 때 안내 문구 자리에 흐리게 보인다.
  const skills = (
    <Section
      id="skills"
      doc={doc}
      edit={edit}
      contentAs="dl"
      contentClassName={css.skills}
      add={{
        label: "역량",
        disabled: doc.skills.length >= LIMITS.skills,
        onClick: () => {
          set({ skills: [...doc.skills, EMPTY_RESUME_ITEM.skill()] });
          setFocusPath(`skills.${doc.skills.length}.category`);
        },
      }}
    >
      {doc.skills.map((s, i) => {
        const items = s.items
          .map((x) => x.trim())
          .filter(Boolean)
          .join(", ");
        return (
          <div key={keysOf.skills[i]} style={{ display: "contents" }}>
            <Field
              as="dt"
              path={`skills.${i}.category`}
              value={s.category}
              placeholder={pick(PH.skillName, i)}
              label={`역량 ${i + 1}`}
              max={60}
              onChange={on((v) => set({ skills: upAt(doc.skills, i, { category: v }) }))}
            />
            <dd className={css.item}>
              <Field
                path={`skills.${i}.detail`}
                value={s.detail}
                placeholder={items || pick(PH.skillDetail, i)}
                label={`역량 ${i + 1} 설명`}
                max={300}
                onChange={on((v) => set({ skills: upAt(doc.skills, i, { detail: v }) }))}
              />
              {edit && <RemoveButton label={`역량 ${i + 1} 삭제`} onClick={() => set({ skills: removeAt(doc.skills, i) })} />}
            </dd>
          </div>
        );
      })}
    </Section>
  );

  // ----- 학력·자격(학력과 자격을 한 섹션에)
  const upEdu = (i: number, patch: Partial<Doc["education"][number]>) => set({ education: upAt(doc.education, i, patch) });
  const upCert = (i: number, patch: Partial<Doc["certifications"][number]>) => set({ certifications: upAt(doc.certifications, i, patch) });
  const education = (
    <Section
      id="education"
      doc={doc}
      edit={edit}
      contentClassName={css.education}
      add={[
        {
          label: "학력",
          disabled: doc.education.length >= LIMITS.education,
          onClick: () => {
            set({ education: [...doc.education, EMPTY_RESUME_ITEM.education()] });
            setFocusPath(`education.${doc.education.length}.school`);
          },
        },
        {
          label: "자격·교육",
          disabled: doc.certifications.length >= LIMITS.certifications,
          onClick: () => {
            set({ certifications: [...doc.certifications, EMPTY_RESUME_ITEM.certification()] });
            setFocusPath(`certifications.${doc.certifications.length}.name`);
          },
        },
      ]}
    >
      {doc.education.map((e, i) => (
        <div key={`e-${keysOf.education[i]}`} className={cn(css.entryHead, css.item)} data-item={`education.${i}`}>
          <div className={css.entryTitle}>
            <Field
              path={`education.${i}.school`}
              value={e.school}
              placeholder={PH.school}
              label={`학교 ${i + 1}`}
              max={120}
              onChange={on((v) => upEdu(i, { school: v }))}
            />
            {(e.major.trim() || edit) && (
              <>
                {" "}
                <Field
                  path={`education.${i}.major`}
                  value={e.major}
                  placeholder={PH.major}
                  label={`전공 ${i + 1}`}
                  max={120}
                  onChange={on((v) => upEdu(i, { major: v }))}
                />
              </>
            )}
            {" · "}
            <Field
              path={`education.${i}.degree`}
              value={e.degree}
              placeholder={PH.degree}
              label={`학위·졸업 상태 ${i + 1}`}
              max={60}
              onChange={on((v) => upEdu(i, { degree: v }))}
            />
          </div>
          <div className={css.period}>
            <DateField
              path={`education.${i}.startDate`}
              value={e.startDate}
              placeholder="[YYYY.MM"
              label={`학력 ${i + 1} 시작`}
              max={20}
              onChange={on((v) => upEdu(i, { startDate: v }))}
            />
            {" - "}
            <DateField end
              path={`education.${i}.endDate`}
              value={e.endDate}
              placeholder="YYYY.MM]"
              label={`학력 ${i + 1} 종료`}
              max={20}
              onChange={on((v) => upEdu(i, { endDate: v }))}
            />
          </div>
          {edit && <RemoveButton label={`학력 ${i + 1} 삭제`} onClick={() => set({ education: removeAt(doc.education, i) })} />}
        </div>
      ))}
      {doc.certifications.map((c, i) => (
        <div key={`c-${keysOf.certifications[i]}`} className={cn(css.entryHead, css.item)} data-item={`certifications.${i}`}>
          <div className={css.entryTitle}>
            <Field
              path={`certifications.${i}.name`}
              value={c.name}
              placeholder={PH.certName}
              label={`자격·교육 ${i + 1}`}
              max={120}
              onChange={on((v) => upCert(i, { name: v }))}
            />
            {" · "}
            <Field
              path={`certifications.${i}.issuer`}
              value={c.issuer}
              placeholder={PH.issuer}
              label={`발급·운영 기관 ${i + 1}`}
              max={120}
              onChange={on((v) => upCert(i, { issuer: v }))}
            />
          </div>
          <div className={css.period}>
            <Field
              path={`certifications.${i}.date`}
              value={c.date}
              placeholder={PH.certDate}
              label={`자격 ${i + 1} 취득 시점`}
              max={20}
              onChange={on((v) => upCert(i, { date: v }))}
            />
          </div>
          {edit && <RemoveButton label={`자격 ${i + 1} 삭제`} onClick={() => set({ certifications: removeAt(doc.certifications, i) })} />}
        </div>
      ))}
    </Section>
  );

  // 읽기 전용이면 내용이 하나도 없는 섹션은 뺀다(편집 모드는 항상 보여 채울 수 있게).
  const show = {
    highlights: editable || doc.highlights.length > 0,
    experience: editable || doc.experience.length > 0,
    projects: editable || doc.projects.length > 0,
    skills: editable || doc.skills.length > 0,
    education: editable || doc.education.length + doc.certifications.length > 0,
  };
  const extras = doc.extras.filter((x) => x.title.trim() || x.items.some((i) => i.trim()));
  const motivation = motivationParagraphs(doc.motivation);

  return (
    <div className={cn(css.root, className)} data-template="performance">
      {editable && (
        <div className={css.status}>
          <span>A4 1장 기준 · 내용을 늘리면 페이지가 추가될 수 있습니다</span>
          <span role="status" className={fit.over ? css.overflow : undefined} data-fit={fit.over ? "over" : "ok"}>
            {fit.text}
          </span>
        </div>
      )}
      <div className={css.sheetWrap}>
        <div
          className={cn(css.sheet, pages > 1 && css.paged)}
          role={editable ? "group" : undefined}
          aria-label={editable ? "이력서 편집 영역" : "이력서 미리보기"}
          data-pages={pages}
          style={pages > 1 ? { minHeight: `calc(${pages} * 297mm + ${(pages - 1) * SHEET_PAGE_GAP}px)` } : undefined}
        >
          {pages > 1 && (
            <div className={css.pages} aria-hidden>
              {Array.from({ length: pages }, (_, i) => (
                <div key={i} className={css.page} style={{ top: `calc(${i} * (297mm + ${SHEET_PAGE_GAP}px))` }}>
                  <span className={css.pageNo}>
                    {i + 1} / {pages}쪽
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className={css.body} ref={bodyRef}>
            {header}
            {show.highlights && highlights}
            {show.experience && experience}
            {show.projects && projects}
            {show.skills && skills}
            {show.education && education}
            {/* 기타(다른 양식에서 쓴 수상·발표 등)는 같은 2단 섹션으로 읽기 전용 표시. 편집은 '입력 폼' 탭에서. */}
            {extras.map((x, i) => (
              <section key={`x${i}`} className={css.section} data-section="extras">
                <div className={css.sectionLabel}>
                  <h2>{x.title.trim() || "기타"}</h2>
                </div>
                <div className={cn(css.sectionContent, css.entry)}>
                  <ul>
                    {x.items
                      .filter((v) => v.trim())
                      .map((v, j) => (
                        <li key={j}>
                          <RichText text={v} />
                        </li>
                      ))}
                  </ul>
                </div>
              </section>
            ))}
            {/* 지원 동기(지원처별 이력서): 읽기 전용 표시. 편집·추천은 시트 위 '지원 동기' 칸에서. */}
            {motivation.length > 0 && (
              <section className={css.section} data-section="motivation">
                <div className={css.sectionLabel}>
                  <h2>{RESUME_SECTION_LABELS.motivation}</h2>
                </div>
                <div className={cn(css.sectionContent, css.entry)}>
                  {motivation.map((para, i) => (
                    <p key={i} style={{ whiteSpace: "pre-line" }}>
                      <RichText text={para} />
                    </p>
                  ))}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
      {editable && (
        // 순서 변경 알림. 본문(쪽 나눔 측정 대상) 밖에 둔다.
        <p aria-live="polite" className={css.srOnly}>
          {moved}
        </p>
      )}
      {editable && (
        <aside className={css.notes} aria-label="작성 안내">
          <strong>채울 때 확인하세요</strong>
          <ul>
            {PERFORMANCE_NOTES.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
