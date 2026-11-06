/**
 * 이력서 화면 → 새 진단(/app/new) 입력 프리필 통로, 그리고 새 이력서 → 편집 화면으로 AI 초안 메모를 넘기는 통로.
 * URL 쿼리에 이력서 본문을 싣지 않는다(길이·기록·임의 문구 주입). 같은 탭의 sessionStorage에 담고 읽은 즉시 지운다.
 *
 * 새 진단 폼(NewDiagnosisForm, portfolio 담당)이 마운트될 때 takeDiagnosisPrefill()을 불러 값을 채우면 된다.
 * 공고 상세의 "이 공고로 진단"도 같은 통로를 쓴다 — 이력서 없이 직무·JD·postingId만 넘긴다(진단이 공고에 연결된다).
 */
import { MAX_PORTFOLIO_DESCRIPTION_CHARS } from "@/lib/domain/portfolios";
import { MAX_RESUME_JD_CHARS, MAX_RESUME_META_CHARS } from "./types";

const PREFILL_KEY = "rp:new-diagnosis-prefill";
const DRAFT_NOTES_PREFIX = "rp:resume-draft-notes:";
/** 진단 이력서 텍스트 한도(diagnoses/summary MAX_RESUME_CHARS와 같다). */
const MAX_PREFILL_RESUME_CHARS = 40_000;
/** 프리필 포트폴리오 텍스트 한도(diagnoses/form MAX_PORTFOLIO_CHARS와 같다). */
export const MAX_PREFILL_PORTFOLIO_CHARS = 20_000;
/** 프리필은 잠깐만 유효하다(다른 날 /app/new를 열었을 때 옛 값이 채워지지 않게). */
const PREFILL_TTL_MS = 10 * 60_000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export interface DiagnosisPrefill {
  resumeText: string;
  targetRole: string;
  jdText: string;
  /** 보관 공고에서 시작했으면 그 공고 id(진단 생성 요청의 postingId). */
  postingId?: string;
  /** 화면 안내용 "회사 · 직무". */
  postingLabel?: string;
  /** 이력서에 붙인 포트폴리오 파일에서 뽑은 글(진단 폼이 .txt 파일로 바꿔 올린다). */
  portfolioText?: string;
  /** 그 포트폴리오의 원래 파일 이름. */
  portfolioFileName?: string;
  /** 이력서에 붙인 포트폴리오 링크(진단 폼의 '링크·설명' 칸에 채운다). */
  portfolioUrl?: string;
  /** 그 포트폴리오에 사용자가 적은 설명(진단 폼의 '링크·설명' 칸에 링크 다음으로 채운다). */
  portfolioNote?: string;
}

/** 진단 폼 '링크·설명' 칸에 채울 글: 링크(있으면) 다음 줄에 사용자가 적은 설명. 둘 다 없으면 "". */
export function portfolioNoteText(p: { kind: string; url: string | null; description: string | null }): string {
  return [p.kind === "url" ? p.url?.trim() : "", p.description?.trim()].filter(Boolean).join("\n");
}

/** 프리필 포트폴리오 글 → 진단 폼에 올릴 .txt 파일 이름("포트폴리오.pdf" → "포트폴리오.pdf.txt"). */
export function prefillPortfolioFileName(name: string | undefined): string {
  const base = (name ?? "").replace(/[\\/\u0000-\u001f]+/g, " ").trim().slice(0, 120) || "portfolio";
  return base.toLowerCase().endsWith(".txt") ? base : `${base}.txt`;
}

/** http/https 주소만(아니면 null). */
function safeHttpUrl(raw: string | undefined): string | null {
  const v = raw?.trim();
  if (!v || v.length > 2048) return null;
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function saveDiagnosisPrefill(p: DiagnosisPrefill, store: StorageLike | null = storage(), now = Date.now()): boolean {
  if (!store) return false;
  try {
    store.setItem(
      PREFILL_KEY,
      JSON.stringify({
        resumeText: p.resumeText.slice(0, MAX_PREFILL_RESUME_CHARS),
        targetRole: p.targetRole.slice(0, MAX_RESUME_META_CHARS),
        jdText: p.jdText.slice(0, MAX_RESUME_JD_CHARS),
        postingId: p.postingId?.slice(0, 64) || undefined,
        postingLabel: p.postingLabel?.slice(0, 200) || undefined,
        portfolioText: p.portfolioText?.slice(0, MAX_PREFILL_PORTFOLIO_CHARS) || undefined,
        portfolioFileName: p.portfolioFileName?.slice(0, 200) || undefined,
        portfolioUrl: safeHttpUrl(p.portfolioUrl) ?? undefined,
        portfolioNote: p.portfolioNote?.trim().slice(0, MAX_PORTFOLIO_DESCRIPTION_CHARS) || undefined,
        at: now,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/** 저장된 프리필을 읽고 지운다. 없거나 오래됐거나 형식이 틀리면 null. */
export function takeDiagnosisPrefill(store: StorageLike | null = storage(), now = Date.now()): DiagnosisPrefill | null {
  if (!store) return null;
  try {
    const raw = store.getItem(PREFILL_KEY);
    store.removeItem(PREFILL_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v.at !== "number" || now - v.at > PREFILL_TTL_MS || now < v.at) return null;
    const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : "");
    const out: DiagnosisPrefill = {
      resumeText: str(v.resumeText, MAX_PREFILL_RESUME_CHARS),
      targetRole: str(v.targetRole, MAX_RESUME_META_CHARS),
      jdText: str(v.jdText, MAX_RESUME_JD_CHARS),
    };
    const postingId = str(v.postingId, 64).trim();
    if (postingId) {
      out.postingId = postingId;
      out.postingLabel = str(v.postingLabel, 200);
    }
    const portfolioText = str(v.portfolioText, MAX_PREFILL_PORTFOLIO_CHARS);
    if (portfolioText.trim()) {
      out.portfolioText = portfolioText;
      const name = str(v.portfolioFileName, 200).trim();
      if (name) out.portfolioFileName = name;
    }
    const portfolioUrl = safeHttpUrl(str(v.portfolioUrl, 2048));
    if (portfolioUrl) out.portfolioUrl = portfolioUrl;
    const portfolioNote = str(v.portfolioNote, MAX_PORTFOLIO_DESCRIPTION_CHARS).trim();
    if (portfolioNote) out.portfolioNote = portfolioNote;
    return out.resumeText.trim() || out.postingId ? out : null;
  } catch {
    return null;
  }
}

export interface DraftNotes {
  notes: string[];
  missingInfo: string[];
}

export function saveDraftNotes(resumeId: string, n: DraftNotes, store: StorageLike | null = storage()): void {
  if (!store || (n.notes.length === 0 && n.missingInfo.length === 0)) return;
  try {
    store.setItem(DRAFT_NOTES_PREFIX + resumeId, JSON.stringify({ notes: n.notes.slice(0, 10), missingInfo: n.missingInfo.slice(0, 10) }));
  } catch {
    // 저장소를 못 쓰면 메모를 생략한다.
  }
}

export function takeDraftNotes(resumeId: string, store: StorageLike | null = storage()): DraftNotes | null {
  if (!store) return null;
  try {
    const raw = store.getItem(DRAFT_NOTES_PREFIX + resumeId);
    store.removeItem(DRAFT_NOTES_PREFIX + resumeId);
    if (!raw) return null;
    const v = JSON.parse(raw) as Record<string, unknown>;
    const list = (x: unknown) =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").slice(0, 10).map((s) => s.slice(0, 300)) : [];
    const out = { notes: list(v.notes), missingInfo: list(v.missingInfo) };
    return out.notes.length || out.missingInfo.length ? out : null;
  } catch {
    return null;
  }
}
