/**
 * 이력서 화면 → 새 진단(/app/new) 입력 프리필 통로, 그리고 새 이력서 → 편집 화면으로 AI 초안 메모를 넘기는 통로.
 * URL 쿼리에 이력서 본문을 싣지 않는다(길이·기록·임의 문구 주입). 같은 탭의 sessionStorage에 담고 읽은 즉시 지운다.
 *
 * 새 진단 폼(NewDiagnosisForm, portfolio 담당)이 마운트될 때 takeDiagnosisPrefill()을 불러 값을 채우면 된다.
 * 공고 상세의 "이 공고로 진단"도 같은 통로를 쓴다 — 이력서 없이 직무·JD·postingId만 넘긴다(진단이 공고에 연결된다).
 */
import { MAX_RESUME_JD_CHARS, MAX_RESUME_META_CHARS } from "./types";

const PREFILL_KEY = "rp:new-diagnosis-prefill";
const DRAFT_NOTES_PREFIX = "rp:resume-draft-notes:";
/** 진단 이력서 텍스트 한도(diagnoses/summary MAX_RESUME_CHARS와 같다). */
const MAX_PREFILL_RESUME_CHARS = 40_000;
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
