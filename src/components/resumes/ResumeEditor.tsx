"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatDateTime } from "@/components/app/stages";
import { SegmentedTabs } from "@/components/app/Tabs";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import {
  RESUME_TEMPLATES,
  ResumeDocumentSchema,
  type ResumeDocument,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";
import { SourceLink } from "@/components/postings/SourceLink";
import { portfolioHasText, type PortfolioPickOption, type PortfolioUploadConfig } from "@/lib/domain/portfolios";
import { POSTING_STATUS_LABELS } from "@/lib/domain/postings";
import { SELF_HOSTED_UPLOAD_LIMITS, VERCEL_UPLOAD_LIMITS, type UploadLimits } from "@/lib/ingest/upload-limits";
import {
  createDraftAutosaver,
  draftStatusText,
  EDIT_DRAFT_KEEPALIVE_MAX_BYTES,
  formatDraftClock,
  shouldWarnBeforeLeave,
  utf8ByteLength,
  type AutosaveStatus,
} from "@/lib/resumes/edit-draft-autosave";
import { countAddMarkers, resumeToText } from "@/lib/resumes/layout";
import { saveDiagnosisPrefill, takeDraftNotes, type DiagnosisPrefill, type DraftNotes } from "@/lib/resumes/prefill";
import {
  MAX_RESUME_JD_CHARS,
  MAX_RESUME_META_CHARS,
  type ChangeResumeStatusResult,
  type ResumeDetail,
  REGENERATE_VERSION_NOTES,
  RESUME_EDIT_DRAFT_CHANGED,
  type ResumeEditDraftClash,
  type ResumeEditDraftResponse,
  type ResumeEditDraftView,
  type ResumeMeta,
  type ResumePostingLink,
  type ResumeVersionMeta,
} from "@/lib/resumes/types";
import { PerformanceSheet } from "./PerformanceSheet";
import { MotivationEditor } from "./MotivationEditor";
import { RegenerateDialog } from "./RegenerateDialog";
import { ResumeDocumentForm } from "./ResumeDocumentForm";
import { ResumePortfolioCard } from "./ResumePortfolioCard";
import { ResumePreview } from "./ResumePreview";
import { ResumeStatusControl } from "./ResumeStatusControl";
import { ResumeWritingTips } from "./ResumeWritingTips";
import { inputClass, textareaClass } from "./styles";
import { TemplatePicker } from "./TemplatePicker";
import { PolishHoverLayer } from "./polish/PolishHoverLayer";
import { POLISH_DOCUMENT_PATH } from "@/lib/domain/resume-polish";
import { highlightPolishField } from "./polish/jump";
import { type PolishApplied, PolishPanel } from "./polish/PolishPanel";

type Pane = "edit" | "preview";
/** 성과 중심 양식의 편집 방식: 시트 위에서 바로 / 구조화 입력 폼. */
type PerfPane = "sheet" | "form";
type Busy = "save" | "meta" | "delete" | "restore" | "view" | "discard" | null;

const LEAVE_CONFIRM = "임시 저장에 실패한 변경이 있습니다. 이대로 이 화면을 떠날까요? (마지막 임시 저장 뒤의 변경은 사라질 수 있습니다)";
const DISCARD_CONFIRM = "임시 저장본과 새 버전으로 저장하지 않은 변경을 모두 버리고, 마지막으로 저장한 버전을 불러올까요? 되돌릴 수 없습니다.";

/** 임시 저장에 보낼 지금 화면 상태. baseVersionId는 작업본이 바탕으로 한 버전(충돌을 정하기 전에는 작업본의 원래 기준). */
type DraftSnapshot = { document: ResumeDocument; templateId: ResumeTemplateId; baseVersionId: string | null };

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

/** 회사별 이력서 편집 화면: 구조화 폼 + 양식 미리보기 + 버전 저장·복원 + PDF·진단 연결. */
export function ResumeEditor({
  resume: initialResume,
  versions: initialVersions,
  initialDocument,
  currentVersionId,
  posting: initialPosting = null,
  uploadLimits = SELF_HOSTED_UPLOAD_LIMITS,
  portfolioUpload,
  portfolios = [],
  photoUrl = null,
  initialDraft = null,
  regenerate = null,
  regenerated = false,
}: {
  resume: ResumeMeta;
  versions: ResumeVersionMeta[];
  initialDocument: ResumeDocument;
  currentVersionId: string | null;
  /** 연결 공고(원문 링크·상태 동기화 표시). */
  posting?: ResumePostingLink | null;
  /** 서버가 정한 업로드 상한(포트폴리오 파일은 이것과 4MB 중 작은 값). */
  uploadLimits?: UploadLimits;
  /** 포트폴리오 업로드 설정(서버가 정한다). 없으면 uploadLimits와 4MB 중 작은 값으로 바로 보낸다. */
  portfolioUpload?: PortfolioUploadConfig;
  /** 내 포트폴리오 보관함(첨부 칸에서 고른다). */
  portfolios?: PortfolioPickOption[];
  /** 내 프로필 사진 주소(소유자만 읽는 /api/account/photo). 없으면 null — '사진 넣기'를 끄고 안내만 보인다. */
  photoUrl?: string | null;
  /** 이 이력서의 임시 저장본(새 버전으로 저장하지 않은 작업본). 있으면 그 내용으로 연다. */
  initialDraft?: ResumeEditDraftView | null;
  /** '다시 생성' 버튼 설정(경험 그래프를 쓸 수 없으면 null — 버튼을 숨긴다). runningHref는 이 이력서를 다시 생성 중인 작업의 진행 화면. */
  regenerate?: { agentAvailable: boolean; runningHref: string | null } | null;
  /** 다시 생성 완료 알림으로 들어왔다(?regenerated=1): 새 버전 안내와 이전 버전 비교·되돌리기를 보인다. */
  regenerated?: boolean;
}) {
  const router = useRouter();
  // meta.templateId는 화면에서 고른 양식(저장 전일 수 있음), savedTemplateId는 서버에 저장된 양식.
  // 임시 저장본이 있으면 그 내용(양식 선택 포함)으로 연다. 저장된 버전과 다르다고 보고 '새 버전 저장 전'으로 표시한다.
  const [meta, setMeta] = useState(() => (initialDraft?.templateId ? { ...initialResume, templateId: initialDraft.templateId } : initialResume));
  const [savedTemplateId, setSavedTemplateId] = useState<ResumeTemplateId>(initialResume.templateId);
  const [versions, setVersions] = useState(initialVersions);
  const [posting, setPosting] = useState(initialPosting);
  const [doc, setDoc] = useState(initialDraft?.document ?? initialDocument);
  const [baseVersionId, setBaseVersionId] = useState(currentVersionId);
  // 문서 변경 여부(마지막으로 저장한 버전 대비). 양식 변경은 저장된 양식과 비교해 따로 셈한다(원래 양식으로 되돌리면 깨끗해진다).
  const [docDirty, setDirty] = useState(initialDraft !== null);
  // 임시 저장: 서버에 있는 작업본의 저장 시각, 연 직후 '불러왔습니다' 알림, 작업본의 기준 버전이 현재 버전이 아닐 때의 충돌.
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(initialDraft?.updatedAt ?? null);
  const initialConflict = initialDraft !== null && initialDraft.baseVersionId !== currentVersionId;
  const [loadedDraftAt, setLoadedDraftAt] = useState<number | null>(initialDraft && !initialConflict ? initialDraft.updatedAt : null);
  const [conflict, setConflict] = useState<{ draftBaseVersionId: string | null; latestVersionId: string | null } | null>(
    initialConflict ? { draftBaseVersionId: initialDraft.baseVersionId, latestVersionId: currentVersionId } : null,
  );
  const [autosave, setAutosave] = useState<AutosaveStatus>({ pending: false, saving: false, failed: false });
  // 다른 탭·기기가 그 사이 작업본을 바꿔 임시 저장이 거절됐다(409 draft_changed): 그쪽 저장 시각. 고르기 전에는 새 버전 저장도 막는다.
  const [draftClashAt, setDraftClashAt] = useState<number | null>(null);
  // 이 화면이 마지막으로 본·쓴 서버 작업본의 저장 시각(PUT expectedUpdatedAt). 저장 콜백이 읽으므로 ref로도 둔다.
  const draftAtRef = useRef<number | null>(initialDraft?.updatedAt ?? null);
  const markDraft = (at: number | null) => {
    draftAtRef.current = at;
    setDraftSavedAt(at);
  };
  // 다른 곳의 작업본을 불러오려고 새로고침할 때는 떠나기 확인을 건너뛴다.
  const skipLeaveWarnRef = useRef(false);
  const dirty = docDirty || meta.templateId !== savedTemplateId;
  const [note, setNote] = useState("");
  const [pane, setPane] = useState<Pane>("edit");
  const [perfPane, setPerfPane] = useState<PerfPane>("sheet");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftNotes, setDraftNotes] = useState<DraftNotes | null>(null);
  // AI로 다듬기 패널: 열림 여부와 대상 칸 경로(domain/resume-polish.ts). 적용은 서버가 새 버전으로 저장한다.
  const [polish, setPolish] = useState<{ target: string | null } | null>(null);
  // 방금 적용한 다듬기(알림의 '되돌리기'용): 적용 전 버전과 적용으로 만든 버전, 그때 띄운 알림 문구.
  const [polishUndo, setPolishUndo] = useState<{ previousId: string; appliedId: string; notice: string } | null>(null);
  const [viewing, setViewing] = useState<{ version: ResumeVersionMeta; document: ResumeDocument } | null>(null);
  const [metaOpen, setMetaOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [regenBanner, setRegenBanner] = useState(regenerated);
  // 버전 미리보기를 열면 그 자리로 옮긴다(다시 생성 배너의 '이전 버전과 비교'는 화면 위에 있다).
  useEffect(() => {
    if (viewing) document.getElementById("resume-version-preview")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [viewing]);
  const [metaForm, setMetaForm] = useState({
    company: meta.company,
    roleTitle: meta.roleTitle,
    title: meta.title,
    jdText: meta.jdText ?? "",
  });

  const template = RESUME_TEMPLATES[meta.templateId];
  // 머리글 사진: 사진이 있고 이 이력서에서 '사진 넣기'가 켜져 있을 때만.
  const headerPhoto = photoUrl && meta.includePhoto ? photoUrl : null;
  const directPortfolioBytes = Math.min(uploadLimits.perFileBytes, VERCEL_UPLOAD_LIMITS.perFileBytes);
  const upload: PortfolioUploadConfig = portfolioUpload ?? { maxBytes: directPortfolioBytes, directMaxBytes: directPortfolioBytes, presigned: false };
  const isGeneral = meta.kind === "general";
  const current = versions.find((v) => v.id === baseVersionId) ?? null;
  const addCount = countAddMarkers(doc);

  // 자동 임시 저장(src/lib/resumes/edit-draft-autosave.ts): 입력이 멈추고 약 3초 뒤, '임시 저장' 버튼, 화면을 떠날 때(keepalive).
  // 보낼 내용은 저장하는 순간의 화면 상태다 — 렌더 뒤에 갱신하는 ref로 읽는다.
  const snapshotRef = useRef<DraftSnapshot>({ document: doc, templateId: meta.templateId, baseVersionId: conflict ? conflict.draftBaseVersionId : baseVersionId });
  useEffect(() => {
    snapshotRef.current = { document: doc, templateId: meta.templateId, baseVersionId: conflict ? conflict.draftBaseVersionId : baseVersionId };
  });
  const [autosaver] = useState(() =>
    createDraftAutosaver<void>({
      onStatus: setAutosave,
      save: async (_unused, { keepalive }) => {
        const snap = snapshotRef.current;
        const body = JSON.stringify({ ...snap, expectedUpdatedAt: draftAtRef.current });
        // keepalive 한도(64KiB, UTF-8 바이트)를 넘으면 브라우저가 요청을 거부한다: 그때는 보통 요청으로 보낸다(문서가 내려가면 끊길 수
        // 있어 탭 닫기·새로고침은 beforeunload에서 경고한다).
        const res = await fetch(`/api/resumes/${initialResume.id}/draft`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: keepalive && utf8ByteLength(body) <= EDIT_DRAFT_KEEPALIVE_MAX_BYTES,
        });
        if (res.status === 409) {
          const clash = (await res.json().catch(() => null)) as ResumeEditDraftClash | null;
          if (clash?.code === RESUME_EDIT_DRAFT_CHANGED) setDraftClashAt(clash.draftUpdatedAt);
          return false;
        }
        if (!res.ok) return false;
        const data = (await res.json().catch(() => null)) as ResumeEditDraftResponse | null;
        if (!data?.draft) return false;
        markDraft(data.draft.updatedAt);
        // 그사이 다른 곳(AI 다듬기 적용·다른 탭)에서 새 버전이 저장됐다: 덮어쓰지 않고 사용자에게 고르게 한다.
        if (data.currentVersionId !== snap.baseVersionId) {
          setConflict((c) => c ?? { draftBaseVersionId: snap.baseVersionId, latestVersionId: data.currentVersionId });
          setLoadedDraftAt(null);
        }
        return true;
      },
    }),
  );

  // 새로 만든 이력서의 AI 초안 메모(sessionStorage로 한 번만 넘어온다). 저장소는 마운트 뒤에만 읽을 수 있다.
  useEffect(() => {
    const n = takeDraftNotes(meta.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 외부 저장소(sessionStorage)에서 한 번 읽는다
    if (n) setDraftNotes(n);
  }, [meta.id]);

  // 화면을 떠날 때: 임시 저장하지 않은 변경은 keepalive 요청으로 저장한다. 마지막 임시 저장이 실패했을 때만 떠나기 전에 확인한다.
  useEffect(() => {
    // unloading: 문서가 내려간다(탭 닫기·새로고침·다른 사이트) — 진행 중인 보통 요청도 끊기므로 keepalive로 다시 보낸다.
    const flushOnLeave = (unloading = false) => {
      if (skipLeaveWarnRef.current) return;
      const s = autosaver.status();
      if (s.pending || (unloading && s.saving)) void autosaver.flush({ keepalive: true, unloading });
    };
    const fitsKeepalive = () => utf8ByteLength(JSON.stringify(snapshotRef.current)) <= EDIT_DRAFT_KEEPALIVE_MAX_BYTES;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = autosaver.status();
      if (skipLeaveWarnRef.current) return;
      if (shouldWarnBeforeLeave(s, { fitsKeepalive: s.pending || s.saving ? fitsKeepalive() : true })) e.preventDefault();
      else flushOnLeave(true);
    };
    const onPageHide = () => flushOnLeave(true);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flushOnLeave();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    // 앱 안 링크(next/link 사이드바 등)는 클라이언트 라우팅이라 beforeunload가 뜨지 않는다: 캡처 단계에서 먼저 가로채 확인한다.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return; // 다른 사이트는 문서를 내리므로 beforeunload가 맡는다
      if (url.pathname === window.location.pathname && url.search === window.location.search) return; // 같은 화면(해시 이동)
      if (shouldWarnBeforeLeave(autosaver.status()) && !window.confirm(LEAVE_CONFIRM)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      flushOnLeave();
    };
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("click", onClick, true);
      // 화면을 닫을 때(다른 화면으로 이동) 남은 변경을 보낸다.
      flushOnLeave();
      autosaver.dispose();
    };
  }, [autosaver]);

  function edit(next: ResumeDocument) {
    setDoc(next);
    setDirty(true);
    setNotice(null);
    autosaver.change();
  }

  /** 저장된 버전을 서버에서 다시 읽는다(충돌 정리·작업본 버리기). 실패하면 null. */
  async function fetchCommitted(): Promise<ResumeDetail | null> {
    try {
      const res = await fetch(`/api/resumes/${meta.id}`, { cache: "no-store" });
      return res.ok ? ((await res.json().catch(() => null)) as ResumeDetail | null) : null;
    } catch {
      return null;
    }
  }

  /** '임시 저장 버리기': 작업본을 지우고 마지막으로 저장한 버전(서버의 현재 버전)을 불러온다. */
  async function discardDraft() {
    if (busy !== null || !window.confirm(DISCARD_CONFIRM)) return;
    setError(null);
    setNotice(null);
    autosaver.cancel();
    setBusy("discard");
    try {
      await autosaver.idle();
      const res = await fetch(`/api/resumes/${meta.id}/draft`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        setError(await readError(res, "임시 저장본을 버리지 못했습니다."));
        autosaver.change(); // 화면의 변경은 그대로 — 다시 임시 저장 대상으로
        return;
      }
      markDraft(null);
      setDraftClashAt(null);
      setLoadedDraftAt(null);
      setConflict(null);
      const detail = await fetchCommitted();
      if (!detail) {
        setError("임시 저장본은 버렸지만 저장된 버전을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
        return;
      }
      setVersions(detail.versions);
      setBaseVersionId(detail.current?.versionId ?? detail.resume.currentVersionId);
      setDoc(detail.current?.document ?? initialDocument);
      setMeta((m) => ({ ...m, ...detail.resume }));
      setSavedTemplateId(detail.resume.templateId);
      setDirty(false);
      setNotice(detail.current ? `임시 저장본을 버리고 v${detail.current.versionNo}을(를) 불러왔습니다.` : "임시 저장본을 버렸습니다.");
    } catch {
      setError("서버에 연결하지 못했습니다.");
      autosaver.change();
    } finally {
      setBusy(null);
    }
  }

  /** 충돌 '임시 저장본 유지': 최신 버전을 기준으로 삼는다 — 다음 '저장(새 버전)'은 최신 버전 위에 새 버전으로 저장된다. */
  async function keepDraft() {
    if (busy !== null) return;
    setError(null);
    setBusy("view");
    try {
      const detail = await fetchCommitted();
      if (!detail) {
        setError("최신 버전을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setVersions(detail.versions);
      setBaseVersionId(detail.current?.versionId ?? detail.resume.currentVersionId);
      setSavedTemplateId(detail.resume.templateId);
      setMeta((m) => ({ ...m, ...detail.resume, templateId: m.templateId })); // 화면에서 고른 양식은 그대로
      setConflict(null);
      setLoadedDraftAt(null);
      setDirty(true);
      autosaver.change(); // 새 기준 버전으로 작업본을 다시 임시 저장
      setNotice(
        `임시 저장본을 유지합니다. ‘저장(새 버전)’을 누르면 ${detail.current ? `최신 버전(v${detail.current.versionNo})` : "최신 버전"} 위에 새 버전으로 저장됩니다.`,
      );
    } finally {
      setBusy(null);
    }
  }

  /** 작업본 충돌(다른 탭·기기) '이 화면 내용으로 덮어쓰기': 서버의 작업본 시각을 기준으로 삼아 지금 내용을 다시 임시 저장한다. */
  function overwriteClashedDraft() {
    if (draftClashAt === null) return;
    draftAtRef.current = draftClashAt;
    setDraftClashAt(null);
    autosaver.change();
    void autosaver.flush();
  }

  /** 작업본 충돌 '다른 곳의 임시 저장본 불러오기': 이 화면의 변경을 버리고 새로고침해 서버의 작업본으로 연다. */
  function loadClashedDraft() {
    if (!window.confirm("이 화면에서 고친 내용(임시 저장되지 않은 변경)을 버리고, 다른 탭·기기에서 임시 저장한 내용을 불러올까요?")) return;
    skipLeaveWarnRef.current = true;
    autosaver.cancel();
    window.location.reload();
  }

  /** 새 버전으로 저장. 성공하면 그 버전, 실패하면 null. */
  async function save(): Promise<ResumeVersionMeta | null> {
    setError(null);
    setNotice(null);
    if (conflict) {
      setError("임시 저장본 이후에 새 버전이 저장됐습니다. 위 알림에서 임시 저장본을 유지할지 버릴지 먼저 골라 주세요.");
      return null;
    }
    if (draftClashAt !== null) {
      setError("다른 탭이나 기기에서 임시 저장본이 바뀌었습니다. 위 알림에서 어느 내용을 남길지 먼저 골라 주세요.");
      return null;
    }
    const parsed = ResumeDocumentSchema.safeParse(doc);
    if (!parsed.success) {
      setError("입력한 내용 중 너무 긴 항목이 있습니다. 길이를 줄여 주세요.");
      return null;
    }
    const templateId = meta.templateId;
    setBusy("save");
    // 기다리던 임시 저장은 보내지 않고, 이미 보낸 것은 끝날 때까지 기다린다(새 버전 저장 뒤에 작업본이 되살아나지 않게).
    autosaver.cancel();
    let committed = false;
    try {
      await autosaver.idle();
      // 양식은 버전 저장과 함께 이력서에 반영한다(저장이 충돌로 취소되면 양식도 그대로).
      const res = await fetch(`/api/resumes/${meta.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: parsed.data,
          note: note.trim() || undefined,
          baseVersionId,
          templateId: templateId !== savedTemplateId ? templateId : undefined,
        }),
      });
      if (!res.ok) {
        setError(await readError(res, "저장하지 못했습니다."));
        return null;
      }
      const { version } = (await res.json()) as { version: ResumeVersionMeta };
      committed = true;
      // 서버가 이 저장과 함께 임시 저장본을 지웠다.
      markDraft(null);
      setLoadedDraftAt(null);
      setVersions((vs) => [version, ...vs]);
      setBaseVersionId(version.id);
      setSavedTemplateId(templateId);
      setDirty(false);
      setNote("");
      setNotice(`v${version.versionNo}로 저장했습니다.`);
      setMeta((m) => ({ ...m, currentVersionId: version.id, updatedAt: version.createdAt }));
      return version;
    } catch {
      setError("서버에 연결하지 못했습니다.");
      return null;
    } finally {
      setBusy(null);
      // 저장하지 못했으면 화면의 변경을 다시 임시 저장 대상으로 둔다.
      if (!committed) autosaver.change();
    }
  }

  /**
   * '지원 완료'는 마지막으로 저장한 버전을 제출본으로 고정한다. 저장하지 않은 변경이 있으면 먼저 저장할지 묻고,
   * 저장하지 않겠다면 상태를 바꾸지 않는다(옛 버전이 말없이 제출본이 되지 않게).
   */
  async function confirmSavedBeforeSubmit(): Promise<boolean> {
    if (!dirty) return true;
    if (busy !== null) return false;
    const ok = window.confirm(
      "저장하지 않은 변경이 있습니다. '지원 완료'는 저장된 버전을 제출본으로 고정합니다.\n지금 내용을 새 버전으로 저장한 뒤 지원 완료로 바꿀까요? (취소하면 상태를 바꾸지 않습니다)",
    );
    if (!ok) return false;
    return (await save()) !== null;
  }

  /** PDF 내려받기: 저장하지 않은 변경이 있으면 먼저 새 버전으로 저장하고 그 버전으로 만든다. */
  async function downloadPdf() {
    let versionId = baseVersionId;
    if (dirty) {
      const v = await save();
      if (!v) return;
      versionId = v.id;
    }
    if (!versionId) {
      setError("저장된 버전이 없습니다. 먼저 저장해 주세요.");
      return;
    }
    // download 속성 링크로 받는다(페이지 이동이 아니라서 '떠나기' 확인이 뜨지 않는다).
    const a = document.createElement("a");
    a.href = pdfHref(versionId);
    a.download = "";
    document.body.append(a);
    a.click();
    a.remove();
  }

  /** PDF 주소: 화면에서 고른 양식으로 만든다. */
  function pdfHref(versionId: string) {
    return `/api/resumes/${meta.id}/pdf?version=${encodeURIComponent(versionId)}&template=${encodeURIComponent(meta.templateId)}`;
  }

  /** 지원 정보(회사·직무·제목·JD) 수정. 양식은 여기서 바꾸지 않고 버전 저장과 함께 저장한다. */
  async function patchMeta(body: Record<string, unknown>): Promise<boolean> {
    setError(null);
    setBusy("meta");
    try {
      const res = await fetch(`/api/resumes/${meta.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readError(res, "변경하지 못했습니다."));
        return false;
      }
      const { resume } = (await res.json()) as { resume: ResumeMeta };
      // 저장하지 않은 양식 선택은 그대로 둔다.
      setMeta((m) => ({ ...resume, templateId: m.templateId }));
      setSavedTemplateId(resume.templateId);
      return true;
    } catch {
      setError("서버에 연결하지 못했습니다.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  /** 양식 바꾸기: 미리보기·편집 화면은 바로 바뀌고, 저장하지 않은 변경으로 표시해 다음 버전 저장 때 함께 저장한다. */
  // 안정된 참조라 memo된 TemplatePicker가 글자 입력마다 다시 그려지지 않는다.
  const changeTemplate = useCallback(
    (id: ResumeTemplateId) => {
      setMeta((m) => (m.templateId === id ? m : { ...m, templateId: id }));
      setNotice(null);
      autosaver.change(); // 양식 선택도 임시 저장한다
    },
    [autosaver],
  );

  async function saveMeta(e: React.FormEvent) {
    e.preventDefault();
    // 공용 이력서는 회사·직무·JD가 없다(제목만 바꾼다).
    const ok = await patchMeta(
      isGeneral
        ? { title: metaForm.title }
        : {
            company: metaForm.company,
            roleTitle: metaForm.roleTitle,
            title: metaForm.title,
            jdText: metaForm.jdText.trim() ? metaForm.jdText : null,
          },
    );
    if (ok) {
      setMetaOpen(false);
      setNotice(isGeneral ? "제목을 바꿨습니다." : "지원 정보를 바꿨습니다.");
      router.refresh();
    }
  }

  async function viewVersion(v: ResumeVersionMeta) {
    setError(null);
    setBusy("view");
    try {
      const res = await fetch(`/api/resumes/${meta.id}/versions/${v.id}`);
      if (!res.ok) {
        setError(await readError(res, "버전을 불러오지 못했습니다."));
        return;
      }
      const data = (await res.json()) as { version: ResumeVersionMeta; document: ResumeDocument };
      setViewing(data);
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function restore(v: ResumeVersionMeta) {
    if (dirty && !window.confirm("새 버전으로 저장하지 않은 변경(임시 저장본 포함)이 있습니다. 버리고 이 버전을 복원할까요?")) return;
    setError(null);
    setBusy("restore");
    // 복원은 작업본을 지운다(서버가 복원과 함께). 기다리던 임시 저장은 보내지 않는다.
    const hadChanges = dirty;
    autosaver.cancel();
    let restored = false;
    try {
      await autosaver.idle();
      const res = await fetch(`/api/resumes/${meta.id}/versions/${v.id}/restore`, { method: "POST" });
      if (!res.ok) {
        setError(await readError(res, "복원하지 못했습니다."));
        return;
      }
      const { version } = (await res.json()) as { version: ResumeVersionMeta };
      restored = true;
      markDraft(null);
      setDraftClashAt(null);
      setLoadedDraftAt(null);
      setConflict(null);
      const docRes = await fetch(`/api/resumes/${meta.id}/versions/${version.id}`);
      const data = docRes.ok ? ((await docRes.json().catch(() => null)) as { document: ResumeDocument } | null) : null;
      setVersions((vs) => [version, ...vs]);
      setMeta((m) => ({ ...m, currentVersionId: version.id, updatedAt: version.createdAt }));
      if (!data?.document) {
        // 복원은 됐지만 화면 내용은 옛 편집 그대로다: 저장된 것처럼 표시하지 않고 다시 읽게 한다.
        setError(`v${version.versionNo}로 복원했지만 내용을 불러오지 못했습니다. 페이지를 새로고침해 주세요.`);
        return;
      }
      setBaseVersionId(version.id);
      setDoc(data.document);
      setMeta((m) => ({ ...m, templateId: savedTemplateId })); // 저장하지 않은 양식 선택도 버린다
      setDirty(false);
      setViewing(null);
      setNotice(`v${v.versionNo}을(를) v${version.versionNo}로 복원했습니다.`);
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
      if (!restored && hadChanges) autosaver.change();
    }
  }

  async function remove() {
    if (!window.confirm("이 이력서를 삭제할까요? 모든 버전이 함께 사라지며 되돌릴 수 없습니다.")) return;
    setError(null);
    setBusy("delete");
    autosaver.cancel(); // 작업본은 이력서와 함께 지워진다
    try {
      await autosaver.idle();
      const res = await fetch(`/api/resumes/${meta.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        setError(await readError(res, "삭제하지 못했습니다."));
        setBusy(null);
        return;
      }
      setDirty(false);
      router.push("/app/resumes");
      router.refresh();
    } catch {
      setError("서버에 연결하지 못했습니다.");
      setBusy(null);
    }
  }

  async function startDiagnosis() {
    // 진단에는 지금 내용이 넘어간다. 이 이력서의 변경은 임시 저장본으로 남는다(화면을 떠날 때 보낸다) — 임시 저장이 실패했을 때만 묻는다.
    if (
      shouldWarnBeforeLeave(autosaver.status()) &&
      !window.confirm("임시 저장에 실패한 변경이 있습니다. 이대로 진단 화면으로 이동할까요? (진단에는 지금 내용이 들어가지만 이 이력서에는 남지 않을 수 있습니다)")
    ) {
      return;
    }
    const prefill: DiagnosisPrefill = {
      resumeText: resumeToText(doc, meta.templateId),
      targetRole: meta.roleTitle,
      jdText: meta.jdText ?? "",
    };
    // 첨부 포트폴리오도 함께 넘긴다(파일은 뽑아 둔 글, 링크는 주소, 적어 둔 설명). 못 읽으면 포트폴리오 없이 진행한다.
    if (meta.portfolio?.kind === "url" && meta.portfolio.url) prefill.portfolioUrl = meta.portfolio.url;
    if (meta.portfolio?.description) prefill.portfolioNote = meta.portfolio.description;
    if (meta.portfolio && portfolioHasText(meta.portfolio.kind)) {
      setBusy("view");
      try {
        const res = await fetch(`/api/resumes/${meta.id}/portfolio?include=text`);
        const data = res.ok ? ((await res.json().catch(() => null)) as { text?: string } | null) : null;
        if (data?.text) {
          prefill.portfolioText = data.text;
          prefill.portfolioFileName = meta.portfolio.fileName ?? (meta.portfolio.kind === "graph" ? `${meta.portfolio.title}.md` : undefined);
        }
      } catch {
        // 포트폴리오 없이 진행
      } finally {
        setBusy(null);
      }
    }
    const ok = saveDiagnosisPrefill(prefill);
    if (!ok) {
      setError("브라우저 저장소를 쓸 수 없어 내용을 넘기지 못했습니다. '텍스트 복사'로 복사해 붙여넣어 주세요.");
      return;
    }
    router.push("/app/new");
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(resumeToText(doc, meta.templateId));
      setNotice("이력서 텍스트를 복사했습니다.");
    } catch {
      setError("복사하지 못했습니다.");
    }
  }

  const isPerformance = meta.templateId === "performance";
  const draftStatus = draftStatusText(autosave, dirty ? draftSavedAt : null);
  const hasDraftWork = dirty || draftSavedAt !== null;
  // 다시 생성 배너: 지금 버전이 다시 생성 버전이면 그 바로 앞 버전과 비교·되돌리기를 보인다.
  const regenCurrent = regenBanner ? versions.find((v) => v.id === baseVersionId && isRegeneratedVersion(v)) : undefined;
  const regenPrevious = regenCurrent ? versions.filter((v) => v.versionNo < regenCurrent.versionNo).sort((a, b) => b.versionNo - a.versionNo)[0] : undefined;
  const versionLabel = (id: string | null) => {
    const v = id ? versions.find((x) => x.id === id) : undefined;
    return v ? `v${v.versionNo}` : null;
  };

  /** 다듬기 제안을 적용해 서버가 저장한 새 버전으로 화면을 맞춘다(되돌리기는 버전 목록의 복원). */
  function polishApplied(result: PolishApplied) {
    const previousId = baseVersionId;
    setDoc(result.document);
    setDirty(false);
    setVersions((vs) => [result.version, ...vs]);
    setBaseVersionId(result.version.id);
    setMeta((m) => ({ ...m, currentVersionId: result.version.id, updatedAt: result.version.createdAt }));
    setError(null);
    const message = `AI 제안을 적용해 v${result.version.versionNo}로 저장했습니다.`;
    setNotice(message);
    setPolishUndo(previousId ? { previousId, appliedId: result.version.id, notice: message } : null);
  }

  /** 다듬기 제안의 칸으로 이동(시트 편집 칸만 찾을 수 있다 — 입력 폼이면 시트로 바꾼 뒤 찾는다). */
  function jumpToPolishField(path: string) {
    if (isPerformance && perfPane !== "sheet") setPerfPane("sheet");
    window.setTimeout(() => {
      if (!highlightPolishField(path)) setNotice("이 칸은 성과 중심 양식의 ‘시트에서 편집’ 화면에서 찾을 수 있어요.");
    }, 80);
  }

  /** 방금 적용한 다듬기를 되돌린다: 적용 전 버전을 복원한다(복원은 새 버전을 만든다). */
  function undoPolish() {
    const prev = polishUndo ? versions.find((v) => v.id === polishUndo.previousId) : undefined;
    setPolishUndo(null);
    if (prev) void restore(prev);
  }

  function statusChanged(result: ChangeResumeStatusResult, message: string) {
    // 저장하지 않은 양식 선택은 그대로 둔다.
    setMeta((m) => ({ ...result.resume, templateId: m.templateId }));
    if (result.postingStatus) setPosting((p) => (p ? { ...p, status: result.postingStatus! } : p));
    setError(null);
    setNotice(message);
  }

  return (
    <div className="space-y-5">
      {/* 머리글 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900">{meta.title}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
            {isGeneral ? (
              <>
                <Badge tone="accent">공용 이력서</Badge>
                <span>회사 지정 없음</span>
              </>
            ) : (
              <span>
                {meta.company} · {meta.roleTitle}
              </span>
            )}
            {!isGeneral && (
              <ResumeStatusControl
                resumeId={meta.id}
                kind={meta.kind}
                status={meta.applyStatus}
                hasPosting={!!posting}
                hasApplication={!!meta.submittedApplicationId}
                onChanged={statusChanged}
                beforeSubmit={confirmSavedBeforeSubmit}
                size="sm"
              />
            )}
            {current && <Badge tone="neutral">v{current.versionNo}</Badge>}
            {draftStatus ? (
              <span role="status" aria-live="polite">
                <Badge tone={draftStatus.tone}>{draftStatus.text}</Badge>
              </span>
            ) : (
              dirty && <Badge tone="warning">저장 안 된 변경</Badge>
            )}
            {addCount > 0 && <Badge tone="warning">채울 칸 {addCount}개</Badge>}
            <button type="button" onClick={() => setMetaOpen((o) => !o)} className="font-medium text-indigo-700 hover:underline">
              {isGeneral ? "제목" : "지원 정보"} {metaOpen ? "닫기" : "수정"}
            </button>
            {isGeneral && (
              <Link href={`/app/resumes/new?from=${encodeURIComponent(meta.id)}`} className="font-medium text-indigo-700 hover:underline">
                이 공고용으로 복제
              </Link>
            )}
          </p>
          {posting && (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-500">
              <span>연결 공고</span>
              <Link href={`/app/postings/${posting.id}`} className="font-medium text-slate-800 hover:text-indigo-700 hover:underline">
                {posting.company} · {posting.roleTitle}
              </Link>
              <Badge tone={posting.status === "applied" ? "positive" : "neutral"}>{POSTING_STATUS_LABELS[posting.status]}</Badge>
              <SourceLink url={posting.url} />
              {meta.submittedApplicationId && (
                <Link
                  href={`/app/applications?open=${encodeURIComponent(meta.submittedApplicationId)}`}
                  className="font-medium text-indigo-700 hover:underline"
                >
                  지원 기록 보기
                </Link>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={downloadPdf}
            loading={busy === "save"}
            disabled={busy !== null || (!dirty && !baseVersionId)}
            title={dirty ? "저장하지 않은 변경을 새 버전으로 저장한 뒤 내려받습니다" : undefined}
          >
            {dirty ? "저장하고 PDF 내려받기" : "PDF 내려받기"}
          </Button>
          <Button variant="secondary" onClick={copyText}>
            텍스트 복사
          </Button>
          <Button variant="secondary" onClick={startDiagnosis} disabled={busy !== null}>
            이 이력서로 진단
          </Button>
          {regenerate && (
            <Button
              variant="secondary"
              onClick={() => (regenerate.runningHref ? router.push(regenerate.runningHref) : setRegenOpen(true))}
              disabled={busy !== null}
              title={regenerate.runningHref ? "이 이력서를 다시 생성하고 있습니다 — 진행 화면을 엽니다" : "경험 그래프로 이 이력서를 다시 써서 새 버전으로 저장합니다"}
            >
              {regenerate.runningHref ? "다시 생성 중…" : "다시 생성"}
            </Button>
          )}
          {hasDraftWork && (
            <Button variant="ghost" onClick={discardDraft} loading={busy === "discard"} disabled={busy !== null}>
              임시 저장 버리기
            </Button>
          )}
          <Button
            variant="secondary"
            onClick={() => void autosaver.flush()}
            loading={autosave.saving}
            disabled={!autosave.pending && !autosave.failed}
            title="새 버전을 만들지 않고 지금 내용을 작업본으로 저장합니다(입력을 멈추면 자동으로도 저장됩니다)"
          >
            임시 저장
          </Button>
          <Button
            onClick={save}
            loading={busy === "save"}
            disabled={!dirty || busy !== null || conflict !== null || draftClashAt !== null}
            title={conflict || draftClashAt !== null ? "임시 저장본을 어떻게 할지 먼저 골라 주세요" : "지금 내용을 새 버전으로 저장합니다(임시 저장본은 지워집니다)"}
          >
            저장(새 버전)
          </Button>
        </div>
      </div>

      {/* 양식 고르기: 가로로 스크롤되는 카드 */}
      <section aria-labelledby="template-picker-title" className="min-w-0">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <h2 id="template-picker-title" className="text-sm font-semibold text-slate-800">
            양식 <span className="font-normal text-slate-500">· {template.name}</span>
          </h2>
          <p className="text-xs text-slate-500">
            {meta.templateId !== savedTemplateId ? "바꾼 양식은 저장할 때 함께 저장됩니다." : "양식을 고르면 아래 화면이 바로 바뀝니다."}
          </p>
        </div>
        <TemplatePicker value={meta.templateId} onChange={changeTemplate} disabled={busy === "save" || busy === "restore"} />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {photoUrl ? (
            <label className="inline-flex items-center gap-2 text-slate-700">
              <input
                type="checkbox"
                checked={meta.includePhoto}
                disabled={busy !== null}
                onChange={(e) => void patchMeta({ includePhoto: e.target.checked })}
                className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
              />
              사진 넣기
              <span className="text-xs text-slate-500">머리글에 프로필 사진을 넣습니다(미리보기·PDF). 바로 저장됩니다.</span>
            </label>
          ) : (
            <p className="text-xs text-slate-500">
              <Link href="/app/account" className="font-medium text-indigo-700 hover:underline">
                계정 설정
              </Link>
              에서 프로필 사진을 올리면 이력서 머리글에 사진을 넣을 수 있습니다.
            </p>
          )}
        </div>
      </section>

      {metaOpen && (
        <Card className="p-4 sm:p-5">
          <form onSubmit={saveMeta} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              {(isGeneral
                ? ([["title", "제목"]] as const)
                : ([
                    ["company", "회사명"],
                    ["roleTitle", "직무"],
                    ["title", "제목"],
                  ] as const)
              ).map(([k, label]) => (
                <label key={k} className="block">
                  <span className="block text-sm font-medium text-slate-800">{label}</span>
                  <input
                    value={metaForm[k]}
                    maxLength={MAX_RESUME_META_CHARS}
                    onChange={(e) => setMetaForm((f) => ({ ...f, [k]: e.target.value }))}
                    className={inputClass}
                  />
                </label>
              ))}
            </div>
            {!isGeneral && (
            <label className="block">
              <span className="block text-sm font-medium text-slate-800">채용 공고(JD)</span>
              <textarea
                value={metaForm.jdText}
                maxLength={MAX_RESUME_JD_CHARS}
                rows={5}
                onChange={(e) => setMetaForm((f) => ({ ...f, jdText: e.target.value }))}
                className={textareaClass}
              />
            </label>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setMetaOpen(false)}>
                취소
              </Button>
              <Button type="submit" loading={busy === "meta"} disabled={busy !== null}>
                {isGeneral ? "제목 저장" : "지원 정보 저장"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {draftNotes && (
        <Alert tone="info" title="AI 초안을 만들었습니다">
          {draftNotes.missingInfo.length > 0 && (
            <>
              <p>
                채워야 할 정보가 있습니다. 본문의 <mark className="rounded bg-yellow-200 px-0.5">[ADD: …]</mark> 자리를 채워 주세요.
              </p>
              <ul className="mt-1 list-disc pl-5">
                {draftNotes.missingInfo.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          )}
          {draftNotes.notes.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-indigo-800/80">
              {draftNotes.notes.map((q, i) => (
                <li key={i}>{q}</li>
              ))}
            </ul>
          )}
          <button type="button" onClick={() => setDraftNotes(null)} className="mt-2 text-xs font-medium underline">
            닫기
          </button>
        </Alert>
      )}
      {regenerate?.runningHref && (
        <Alert tone="info" title="이 이력서를 다시 생성하고 있습니다">
          끝나면 새 버전으로 저장하고 알림으로 알려 드립니다.{" "}
          <Link href={regenerate.runningHref} className="font-medium underline">
            진행 상황 보기
          </Link>
        </Alert>
      )}
      {regenCurrent && (
        <Alert tone="info" title={`AI가 이력서를 다시 생성해 v${regenCurrent.versionNo}로 저장했습니다`}>
          <p>지원 동기·이름·연락처·링크는 이전 버전 값을 그대로 두었습니다. 이전 버전은 아래 버전 목록에 남아 있습니다.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {regenPrevious && (
              <>
                <Button size="sm" variant="secondary" onClick={() => void viewVersion(regenPrevious)} loading={busy === "view"} disabled={busy !== null}>
                  이전 버전과 비교
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void restore(regenPrevious)} loading={busy === "restore"} disabled={busy !== null}>
                  이전 버전(v{regenPrevious.versionNo})으로 되돌리기
                </Button>
              </>
            )}
            <Button size="sm" variant="ghost" onClick={() => setRegenBanner(false)}>
              닫기
            </Button>
          </div>
        </Alert>
      )}
      {conflict && (
        <Alert tone="warning" title="임시 저장본 이후에 새 버전이 저장됐습니다">
          <p>
            지금 편집 중인 임시 저장본은 {versionLabel(conflict.draftBaseVersionId) ?? "이전 버전"}을(를) 바탕으로 했는데, 그 뒤에{" "}
            {versionLabel(conflict.latestVersionId) ?? "새 버전"}이(가) 저장됐습니다(AI 다듬기 적용·AI 다시 생성·다른 탭에서 저장 등). 어느 쪽도 말없이 덮어쓰지 않습니다.
          </p>
          <p className="mt-1">
            임시 저장본을 유지하면 ‘저장(새 버전)’ 때 최신 버전 위에 이 내용으로 새 버전이 저장됩니다(그 사이 버전은 버전 목록에 남습니다).
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => void keepDraft()} loading={busy === "view"} disabled={busy !== null}>
              임시 저장본 유지
            </Button>
            <Button size="sm" variant="secondary" onClick={() => void discardDraft()} loading={busy === "discard"} disabled={busy !== null}>
              임시 저장본 버리고 최신 버전 보기
            </Button>
          </div>
        </Alert>
      )}
      {draftClashAt !== null && (
        <Alert tone="warning" title="다른 탭이나 기기에서 임시 저장본이 바뀌었습니다">
          <p>
            이 이력서의 임시 저장본이 {formatDraftClock(draftClashAt)}에 다른 곳에서 저장돼, 이 화면의 변경은 임시 저장하지 않았습니다. 어느 쪽도 말없이
            덮어쓰지 않습니다.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" onClick={overwriteClashedDraft} disabled={busy !== null}>
              이 화면 내용으로 덮어쓰기
            </Button>
            <Button size="sm" variant="secondary" onClick={loadClashedDraft} disabled={busy !== null}>
              다른 곳의 임시 저장본 불러오기
            </Button>
          </div>
        </Alert>
      )}
      {loadedDraftAt !== null && !conflict && (
        <Alert tone="info" title={`임시 저장본을 불러왔습니다 (${formatDraftClock(loadedDraftAt)})`}>
          <p>아직 새 버전으로 저장하지 않은 작업본입니다. PDF·공유 링크·지원 제출본은 마지막으로 저장한 버전을 씁니다.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" onClick={() => void discardDraft()} loading={busy === "discard"} disabled={busy !== null}>
              버리고 저장된 버전 보기
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setLoadedDraftAt(null)}>
              닫기
            </Button>
          </div>
        </Alert>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      {notice && !error && (
        <Alert tone="info">
          {notice}
          {polishUndo && polishUndo.notice === notice && polishUndo.appliedId === baseVersionId && (
            <button type="button" onClick={undoPolish} disabled={busy !== null} className="ml-2 text-xs font-medium underline disabled:opacity-50">
              되돌리기
            </button>
          )}
        </Alert>
      )}

      <ResumePortfolioCard
        resumeId={meta.id}
        portfolio={meta.portfolio}
        library={portfolios}
        upload={upload}
        onChange={(resume) => setMeta((m) => ({ ...resume, templateId: m.templateId }))}
      />

      <ResumeWritingTips
        resumeId={meta.id}
        kind={meta.kind}
        document={doc}
        jdAvailable={meta.kind === "company" && (!!meta.jdText?.trim() || !!meta.postingId)}
        jdKey={`${meta.company}\n${meta.roleTitle}\n${meta.jdText ?? ""}\n${meta.postingId ?? ""}`}
      />

      {/* 지원 동기: 지원처별 이력서만(사용자가 쓰고, AI는 쓸 거리만 추천). */}
      {!isGeneral && <MotivationEditor resumeId={meta.id} value={doc.motivation} onChange={(motivation) => edit({ ...doc, motivation })} />}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className="text-xs text-slate-500">이력서 전체를 두고 AI에게 묻거나, 문장 하나를 골라 문구를 다듬을 수 있어요.</span>
        <Button size="sm" variant="secondary" onClick={() => setPolish({ target: polish?.target ?? POLISH_DOCUMENT_PATH })}>
          AI로 다듬기
        </Button>
      </div>

      {isPerformance ? (
        // 성과 중심 양식: 원본처럼 A4 시트 위에서 바로 고치거나, 구조화 폼으로 고친다(같은 문서 상태).
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <SegmentedTabs
              label="편집 방식"
              value={perfPane}
              onChange={setPerfPane}
              options={[
                { value: "sheet", label: "시트에서 편집" },
                { value: "form", label: "입력 폼" },
              ]}
            />
            <p className="text-xs text-slate-500">
              {perfPane === "sheet"
                ? "대괄호 항목을 클릭해 내 경험으로 바꾸세요. 빈 칸은 PDF에 찍히지 않습니다."
                : "입력한 내용은 시트에 그대로 반영됩니다."}
            </p>
          </div>
          {perfPane === "sheet" ? (
            <PolishHoverLayer onPolish={(target) => setPolish({ target })}>
              <PerformanceSheet document={doc} onChange={edit} photoUrl={headerPhoto} />
            </PolishHoverLayer>
          ) : (
            <div className="max-w-3xl">
              <ResumeDocumentForm value={doc} onChange={edit} sectionOrder={template.sectionOrder} />
            </div>
          )}
          <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
            <label className="block min-w-0 flex-1">
              <span className="block text-xs font-medium text-slate-600">버전 메모 (선택)</span>
              <input
                value={note}
                maxLength={200}
                onChange={(e) => setNote(e.target.value)}
                placeholder="예: 정산 성과 수치 보강"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
              />
            </label>
            <Button onClick={save} loading={busy === "save"} disabled={!dirty || busy !== null || conflict !== null || draftClashAt !== null}>
              새 버전으로 저장
            </Button>
          </Card>
          <AutosaveHint />
        </div>
      ) : (
        <>
          {/* 모바일: 편집/미리보기 전환, 넓은 화면: 나란히 */}
          <div className="lg:hidden">
            <SegmentedTabs
              label="보기"
              value={pane}
              onChange={setPane}
              options={[
                { value: "edit", label: "편집" },
                { value: "preview", label: "미리보기" },
              ]}
            />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <div className={cn("min-w-0 space-y-3", pane !== "edit" && "hidden lg:block")}>
              <ResumeDocumentForm value={doc} onChange={edit} sectionOrder={template.sectionOrder} />
              <Card className="flex flex-col gap-2 p-4 sm:flex-row sm:items-end">
                <label className="block min-w-0 flex-1">
                  <span className="block text-xs font-medium text-slate-600">버전 메모 (선택)</span>
                  <input
                    value={note}
                    maxLength={200}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="예: 정산 성과 수치 보강"
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
                  />
                </label>
                <Button onClick={save} loading={busy === "save"} disabled={!dirty || busy !== null || conflict !== null || draftClashAt !== null}>
                  새 버전으로 저장
                </Button>
              </Card>
              <AutosaveHint />
            </div>
            <div className={cn("min-w-0", pane !== "preview" && "hidden lg:block")}>
              <div className="lg:sticky lg:top-4">
                <p className="mb-2 text-xs text-slate-500">
                  {template.name} 양식 미리보기 ·{" "}
                  {dirty ? "PDF를 내려받으면 지금 내용을 먼저 새 버전으로 저장한 뒤 그 버전으로 만듭니다." : "PDF는 이 내용으로 만듭니다."}
                </p>
                <ResumePreview
                  document={doc}
                  templateId={meta.templateId}
                  photoUrl={headerPhoto}
                  className="max-h-none lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto"
                />
              </div>
            </div>
          </div>
        </>
      )}

      {/* 버전 */}
      <Card>
        <div className="px-5 pt-5">
          <h2 className="text-base font-semibold text-slate-900">버전 {versions.length}개</h2>
          <p className="mt-1 text-sm text-slate-500">저장할 때마다 새 버전이 생깁니다. 복원하면 그 내용으로 새 버전을 만듭니다.</p>
        </div>
        <ul className="mt-3 divide-y divide-slate-100">
          {versions.map((v) => (
            <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-slate-900">
                  v{v.versionNo}
                  {v.id === baseVersionId && <Badge tone="accent">현재</Badge>}
                  <Badge tone={v.source === "ai" ? "info" : "neutral"}>{versionSourceLabel(v)}</Badge>
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  <time dateTime={new Date(v.createdAt).toISOString()}>{formatDateTime(v.createdAt)}</time>
                  {v.note ? ` · ${v.note}` : ""}
                </p>
              </div>
              <div className="flex gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => viewVersion(v)} disabled={busy !== null}>
                  보기
                </Button>
                <a href={pdfHref(v.id)} download className={buttonClass("ghost", "sm")}>
                  PDF
                </a>
                {v.id !== baseVersionId && (
                  <Button size="sm" variant="secondary" onClick={() => restore(v)} disabled={busy !== null}>
                    복원
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {viewing && (
        <Card id="resume-version-preview" className="scroll-mt-4 p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold text-slate-900">v{viewing.version.versionNo} 미리보기</h2>
            <div className="flex gap-2">
              {viewing.version.id !== baseVersionId && (
                <Button size="sm" onClick={() => restore(viewing.version)} loading={busy === "restore"} disabled={busy !== null}>
                  이 버전 복원
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setViewing(null)}>
                닫기
              </Button>
            </div>
          </div>
          <ResumePreview document={viewing.document} templateId={meta.templateId} photoUrl={headerPhoto} />
        </Card>
      )}

      <div className="flex justify-end border-t border-slate-200 pt-4">
        <Button variant="danger" onClick={remove} loading={busy === "delete"} disabled={busy !== null && busy !== "delete"}>
          이력서 삭제
        </Button>
      </div>

      {regenerate && (
        <RegenerateDialog
          open={regenOpen}
          onClose={() => setRegenOpen(false)}
          resumeId={meta.id}
          kind={meta.kind}
          jdText={meta.jdText ?? ""}
          templateId={savedTemplateId}
          agentAvailable={regenerate.agentAvailable}
          hasUnsavedWork={hasDraftWork}
          onSaveFirst={async () => (await save()) !== null}
        />
      )}

      {polish && (
        <PolishPanel
          resumeId={meta.id}
          versionId={baseVersionId}
          document={doc}
          dirty={dirty}
          target={polish.target}
          onTargetChange={(target) => setPolish({ target })}
          onClose={() => setPolish(null)}
          onApplied={polishApplied}
          onJump={jumpToPolishField}
        />
      )}
    </div>
  );
}

/** 임시 저장 안내(버전 메모 칸 아래). */
function AutosaveHint() {
  return (
    <p className="text-xs text-slate-500">
      입력을 멈추면 몇 초 뒤 자동으로 임시 저장됩니다(새 버전을 만들지 않음). 임시 저장본은 나만 보는 작업본이며, PDF·공유·지원 제출에는 저장된 버전만
      쓰입니다.
    </p>
  );
}

/** 다시 생성으로 저장한 버전(source 'ai', 메모 'AI 다시 생성 (…)'). */
function isRegeneratedVersion(v: Pick<ResumeVersionMeta, "source" | "note">): boolean {
  return v.source === "ai" && (Object.values(REGENERATE_VERSION_NOTES) as string[]).includes(v.note ?? "");
}

/** 버전 배지: AI로 다듬기로 만든 버전(메모 'AI로 다듬기 · …')은 'AI 다듬기', 다시 생성은 'AI 다시 생성', 그 밖의 AI 버전은 'AI 초안'. */
function versionSourceLabel(v: Pick<ResumeVersionMeta, "source" | "note">): string {
  if (v.source !== "ai") return "직접 저장";
  if (isRegeneratedVersion(v)) return "AI 다시 생성";
  return v.note?.startsWith("AI로 다듬기") ? "AI 다듬기" : "AI 초안";
}
