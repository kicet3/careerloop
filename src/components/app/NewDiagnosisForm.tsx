"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { NO_ENGINE_MESSAGE, PROVIDER_DATA_DESTINATION, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import type { Situation } from "@/lib/domain/schemas";
import { formatMb, SELF_HOSTED_UPLOAD_LIMITS, totalUploadError, uploadLimitMessage, type UploadLimits } from "@/lib/ingest/upload-limits";
import { PORTFOLIO_KIND_LABELS, portfolioHasText, portfolioSourceLabel, type PortfolioInfo, type PortfolioPickOption } from "@/lib/domain/portfolios";
import { portfolioNoteText, prefillPortfolioFileName, takeDiagnosisPrefill } from "@/lib/resumes/prefill";
import { saveCreationWarnings } from "./creation-warnings";
import { FileDrop, UPLOAD_ACCEPT, UPLOAD_FORMATS_LABEL } from "./FileDrop";
import { SegmentedTabs } from "./Tabs";
import { fetchPosting, PostingTargetPicker } from "@/components/postings/PostingTargetPicker";
import type { PostingPickOption } from "@/components/resumes/NewResumeForm";
import type { JobPosting } from "@/lib/domain/postings";
import { resumeToText } from "@/lib/resumes/layout";
import type { ResumeDetail } from "@/lib/resumes/types";

/** '서류에서 선택'으로 고를 수 있는 내 이력서(목록에 필요한 값만). */
export interface DiagnosisResumeOption {
  id: string;
  title: string;
  /** 'general'(공용) 또는 회사 지정. */
  kind: "general" | "company";
  company: string;
  roleTitle: string;
  updatedAt: number;
}

const RESUME_ACCEPT = UPLOAD_ACCEPT;
const JD_ACCEPT = UPLOAD_ACCEPT;
const PORTFOLIO_ACCEPT = UPLOAD_ACCEPT;
/** 서버 상한(src/lib/diagnoses/form.ts MAX_PORTFOLIO_NOTE_CHARS)과 같게 둔다. */
const PORTFOLIO_NOTE_MAX = 5000;

/**
 * POST /api/diagnoses multipart 필드 이름.
 * 이력서는 resumeFile 또는 resumeText 중 하나, JD는 jdFile 또는 jdText 중 하나(둘 다 없으면 JD 없음).
 * 포트폴리오(선택)는 portfolioFile과 portfolioText(링크·설명)를 함께 보낼 수 있다.
 */
export const DIAGNOSIS_FORM_FIELDS = {
  resumeFile: "resumeFile",
  resumeText: "resumeText",
  targetRole: "targetRole",
  jdText: "jdText",
  jdFile: "jdFile",
  situation: "situation",
  notes: "notes",
  portfolioFile: "portfolioFile",
  portfolioText: "portfolioText",
  provider: "provider",
  postingId: "postingId",
} as const;

const STATUS_FALLBACK: Record<number, string> = {
  400: "입력 내용을 확인해 주세요.",
  401: "로그인이 필요합니다.",
  409: "이미 진행 중인 진단이 있습니다. 끝난 뒤 다시 시도해 주세요.",
  429: "오늘 진단 가능 횟수를 모두 사용했습니다. 내일 다시 시도해 주세요.",
};

type Mode = "file" | "text";
/** 이력서 넣는 방법: 파일 / 서류(내 이력서)에서 선택 / 직접 붙여넣기. */
type ResumeMode = Mode | "saved";
/** 지원할 자리 고르는 방법: 직무·JD 직접 입력 / 내 보관함 공고 / 공고 링크로 가져오기. */
type TargetMode = "manual" | "library" | "url";
/** 포트폴리오 넣는 방법: 파일 올리기 / 포트폴리오 보관함에서 선택. */
type PortfolioMode = "file" | "library";
/** 포트폴리오 칸을 자동으로 채우는 곳: 서류에서 고른 이력서의 첨부, 보관함에서 고른 포트폴리오, 이력서 화면의 "이 이력서로 진단". */
type PortfolioFillSource = "saved" | "library" | "prefill";

const TARGET_MODES: { key: TargetMode; name: string; description: string }[] = [
  { key: "manual", name: "직접 입력", description: "직무와 JD를 직접 넣습니다." },
  { key: "library", name: "공고 보관함", description: "보관한 공고를 검색해 고릅니다." },
  { key: "url", name: "공고 링크로", description: "링크를 넣으면 보관함에 담고 바로 고릅니다." },
];

export function NewDiagnosisForm({
  providers,
  defaultProvider,
  uploadLimits = SELF_HOSTED_UPLOAD_LIMITS,
  postings = [],
  resumes = [],
  portfolios = [],
}: {
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
  /** 서버가 정한 업로드 상한(Vercel은 요청 본문 4.5MB 때문에 더 작다). */
  uploadLimits?: UploadLimits;
  /** 내 보관함 공고(최근 수정 순). '공고 보관함'에서 고른다. */
  postings?: PostingPickOption[];
  /** 내 이력서(서류 탭). '서류에서 선택'에서 고르면 현재 버전 내용과 첨부 포트폴리오를 채운다. */
  resumes?: DiagnosisResumeOption[];
  /** 내 포트폴리오 보관함. '포트폴리오에서 선택'에서 고르면 뽑아 둔 글과 설명을 채운다. */
  portfolios?: PortfolioPickOption[];
}) {
  const perFile = formatMb(uploadLimits.perFileBytes);
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const selected = providers.find((p) => p.id === provider);
  const destination = provider ? PROVIDER_DATA_DESTINATION[provider] : null;
  const isCli = provider === "claude-cli" || provider === "codex-cli";
  const hasCliOptions = providers.some((p) => p.id === "claude-cli" || p.id === "codex-cli");

  const [resumeMode, setResumeMode] = useState<ResumeMode>("file");
  const [savedResumeId, setSavedResumeId] = useState("");
  const [savedLoading, setSavedLoading] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [jdMode, setJdMode] = useState<Mode>("text");
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [jdText, setJdText] = useState("");
  // 지원 상황은 화면에서 고르지 않는다(기본 '일반'). 서버 스키마는 그대로 받는다.
  const situation: Situation = "general";
  const [notes, setNotes] = useState("");
  const [portfolioFile, setPortfolioFile] = useState<File | null>(null);
  const [portfolioText, setPortfolioText] = useState("");
  const [portfolioMode, setPortfolioMode] = useState<PortfolioMode>("file");
  const [libraryPortfolioId, setLibraryPortfolioId] = useState("");
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryNote, setLibraryNote] = useState<string | null>(null);

  const [fileError, setFileError] = useState<{ resume?: string; jd?: string; portfolio?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  /** 이력서에 붙인 포트폴리오를 함께 가져왔으면 true(안내 문구용). */
  const [prefilledPortfolio, setPrefilledPortfolio] = useState(false);
  /** 공고 보관함의 "이 공고로 진단"에서 왔으면 그 공고(진단이 공고에 연결된다). */
  const [posting, setPosting] = useState<{ id: string; label: string } | null>(null);
  /** 고른 공고 전체(JD 미리보기·전송용). 직접 입력이면 null. */
  const [postingDetail, setPostingDetail] = useState<JobPosting | null>(null);
  const [targetMode, setTargetMode] = useState<TargetMode>(postings.length > 0 ? "library" : "manual");
  const [targetNote, setTargetNote] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fromPosting = targetMode !== "manual";
  /** 이력서 화면에서 공고와 함께 넘어온 JD(그 공고를 골랐을 때만 대신 쓴다). */
  const [prefillJd, setPrefillJd] = useState<{ postingId: string; text: string } | null>(null);
  /** 비동기 이력서 불러오기가 끝났을 때 최신 선택을 보려고 둔다(렌더 시점 값이 아니라). */
  const postingRef = useRef(posting);
  useEffect(() => {
    postingRef.current = posting;
  }, [posting]);
  /** 앞서 '서류에서 선택'이 채운 이력서 글(다른 이력서를 고르거나 불러오기에 실패하면 이것만 지운다). */
  const savedResumeTextRef = useRef<string | null>(null);
  /**
   * 포트폴리오 칸을 마지막으로 채운 곳('서류에서 선택'·'포트폴리오에서 선택'·이력서 화면 프리필)과 그때 넣은 값.
   * 새 출처가 채우면 이전 출처가 넣은 값(사용자가 그 뒤 고치지 않은 것)을 먼저 지운다 — 두 출처가 섞여 제출되지 않게.
   */
  const portfolioFillRef = useRef<{ source: PortfolioFillSource; file: File | null; text: string | null } | null>(null);
  /** 포트폴리오 불러오기 순번: 늦게 끝난 옛 요청이 더 최근에 고른 값을 덮지 않게(마지막으로 고른 것이 이긴다). */
  const portfolioSeqRef = useRef(0);
  const portfolioAppliedSeqRef = useRef(0);

  function selectPosting(p: JobPosting, note: string | null) {
    postingRef.current = { id: p.id, label: `${p.company} · ${p.roleTitle}` };
    setPosting(postingRef.current);
    setPostingDetail(p);
    setTargetRole(p.roleTitle);
    setTargetNote(note);
    setError(null);
  }
  /** 서류의 이력서 고르기: 현재 버전을 글로 바꿔 붙여넣기 칸에 채우고, 첨부 포트폴리오·연결 공고도 가져온다. */
  /** 앞서 불러온 이력서가 채운 값만 지운다(사용자가 그 뒤 직접 바꾼 값은 둔다). */
  function clearSavedFill() {
    const prev = savedResumeTextRef.current;
    if (prev !== null) setResumeText((cur) => (cur === prev ? "" : cur));
    savedResumeTextRef.current = null;
    clearPortfolioFill("saved");
  }

  /**
   * 마지막 출처가 채운 포트폴리오 값을 지운다(source를 주면 그 출처일 때만). 사용자가 그 뒤 고친 값은 둔다.
   * 보관함 선택이었으면 선택·안내도, 프리필이었으면 프리필 안내도 함께 지운다.
   */
  function clearPortfolioFill(source?: PortfolioFillSource) {
    const prev = portfolioFillRef.current;
    if (!prev || (source && prev.source !== source)) return;
    if (prev.file) setPortfolioFile((cur) => (cur === prev.file ? null : cur));
    if (prev.text !== null) setPortfolioText((cur) => (cur === prev.text ? "" : cur));
    portfolioFillRef.current = null;
    if (prev.source === "library") {
      setLibraryPortfolioId("");
      setLibraryNote(null);
    }
    if (prev.source === "prefill") setPrefilledPortfolio(false);
  }

  /** 새 불러오기 순번. 사용자가 직접 파일을 바꾸거나 선택을 뺄 때도 올려, 진행 중인 불러오기가 나중에 덮어쓰지 않게 한다. */
  function nextPortfolioSeq(): number {
    return ++portfolioSeqRef.current;
  }

  /**
   * seq 순번의 불러오기 결과로 포트폴리오 칸을 채운다. 그보다 나중에 고른 값이 이미 들어갔으면 false(버린다).
   * 이전 출처가 넣은 값은 지우고, 파일은 이 출처의 것으로 바꾼다(없으면 비운다). 링크·설명은 이 출처에 있을 때만 바꾼다.
   */
  function applyPortfolioFill(seq: number, source: PortfolioFillSource, file: File | null, text: string | null): boolean {
    if (seq <= portfolioAppliedSeqRef.current) return false;
    portfolioAppliedSeqRef.current = seq;
    clearPortfolioFill();
    setPortfolioFile(file);
    if (file) setFileError((p) => ({ ...p, portfolio: undefined }));
    if (text) setPortfolioText(text);
    portfolioFillRef.current = { source, file, text: text || null };
    return true;
  }

  /** 보관함 선택 빼기: 그 선택이 넣은 파일·링크·설명만 지운다(사용자가 직접 올린 파일·쓴 글은 둔다). */
  function removeLibraryPortfolio() {
    portfolioAppliedSeqRef.current = nextPortfolioSeq();
    clearPortfolioFill("library");
    setLibraryPortfolioId("");
    setLibraryNote(null);
  }

  /** 사용자가 직접 파일을 올리거나 지웠다: 진행 중인 불러오기는 버리고, 보관함 선택은 더 이상 이 파일이 아니므로 푼다. */
  function onOwnPortfolioFile(f: File | null) {
    portfolioAppliedSeqRef.current = nextPortfolioSeq();
    const prev = portfolioFillRef.current;
    if (prev) portfolioFillRef.current = { ...prev, file: null };
    if (prev?.source === "library") {
      setLibraryPortfolioId("");
      setLibraryNote(null);
    }
    setPortfolioFile(f);
  }

  /** 보관함 포트폴리오 고르기: 뽑아 둔 글은 .txt 파일로 넣고(서버가 같은 추출기로 읽는다), 링크·설명은 '링크·설명' 칸에 채운다. */
  async function loadLibraryPortfolio(id: string) {
    const seq = nextPortfolioSeq();
    // 앞서 고른 보관함 포트폴리오가 넣은 값은 바로 지운다(clearPortfolioFill이 선택을 비우므로 그 뒤에 새 선택을 둔다).
    clearPortfolioFill("library");
    setLibraryPortfolioId(id);
    setLibraryNote(null);
    setError(null);
    if (!id) {
      portfolioAppliedSeqRef.current = seq;
      return;
    }
    setLibraryLoading(true);
    // 더 나중에 고른 값이 이미 들어갔으면 이 선택은 버린다(선택 칸이 아직 이 항목이면 비운다).
    const dropSelection = () => setLibraryPortfolioId((cur) => (cur === id ? "" : cur));
    try {
      const res = await fetch(`/api/portfolios/${encodeURIComponent(id)}?include=text`, { cache: "no-store" });
      const data = res.ok ? ((await res.json().catch(() => null)) as { portfolio?: PortfolioInfo; text?: string } | null) : null;
      if (!data?.portfolio) {
        setError("포트폴리오를 불러오지 못했습니다.");
        dropSelection();
        return;
      }
      const pf = data.portfolio;
      const parts: string[] = [];
      const file = data.text ? new File([data.text], prefillPortfolioFileName(pf.fileName ?? pf.title), { type: "text/plain" }) : null;
      if (data.text) parts.push(`뽑아 둔 글 ${data.text.length.toLocaleString("ko-KR")}자`);
      const note = portfolioNoteText(pf);
      if (note) parts.push(pf.kind === "url" ? "링크·설명" : "설명");
      if (!applyPortfolioFill(seq, "library", file, note || null)) {
        dropSelection();
        return;
      }
      setLibraryPortfolioId(id);
      setLibraryNote(
        parts.length
          ? `‘${pf.title}’ 포트폴리오를 넣었습니다(${parts.join(" · ")}).`
          : `‘${pf.title}’에는 넣을 글이 없습니다. 포트폴리오 화면에서 파일을 다시 올리거나 설명을 적어 주세요.`,
      );
    } catch {
      setError("포트폴리오를 불러오지 못했습니다. 네트워크를 확인해 주세요.");
      dropSelection();
    } finally {
      setLibraryLoading(false);
    }
  }

  async function loadSavedResume(id: string) {
    setSavedResumeId(id);
    setSavedNote(null);
    setError(null);
    // 다른 이력서로 바꾸면 앞 이력서의 내용·포트폴리오가 딸려 가지 않게 지운다.
    clearSavedFill();
    if (!id) return;
    const seq = nextPortfolioSeq();
    setSavedLoading(true);
    // 실패하면 고르기를 비워 같은 이력서를 다시 고를 수 있게 한다(사용자가 쓴 글은 지우지 않는다).
    const fail = (message: string) => {
      setError(message);
      setSavedResumeId("");
    };
    try {
      const res = await fetch(`/api/resumes/${encodeURIComponent(id)}`, { cache: "no-store" });
      const detail = res.ok ? ((await res.json().catch(() => null)) as ResumeDetail | null) : null;
      if (!detail?.current) {
        fail(detail ? "이 이력서에는 저장된 버전이 없습니다. 편집 화면에서 먼저 저장해 주세요." : "이력서를 불러오지 못했습니다.");
        return;
      }
      const text = resumeToText(detail.current.document, detail.resume.templateId);
      setResumeText(text);
      savedResumeTextRef.current = text;
      const notes: string[] = [`v${detail.current.versionNo} 내용을 가져왔습니다.`];
      // 이력서에 붙인 보관함 포트폴리오: 뽑아 둔 글은 파일로, 링크·설명은 '링크·설명' 칸에.
      const pf = detail.resume.portfolio;
      // 그 사이 다른 포트폴리오를 골랐으면(보관함 선택·직접 올리기) 그것을 두고 이 이력서의 포트폴리오는 넣지 않는다.
      if (pf) {
        const note = portfolioNoteText(pf) || null;
        let file: File | null = null;
        if (portfolioHasText(pf.kind)) {
          const r = await fetch(`/api/resumes/${encodeURIComponent(id)}/portfolio?include=text`).catch(() => null);
          const data = r?.ok ? ((await r.json().catch(() => null)) as { text?: string } | null) : null;
          if (data?.text) file = new File([data.text], prefillPortfolioFileName(pf.fileName ?? pf.title), { type: "text/plain" });
        }
        if ((file || note) && applyPortfolioFill(seq, "saved", file, note)) notes.push(`첨부 포트폴리오(${pf.title})를 함께 넣었습니다.`);
      }
      // 연결 공고가 있고 아직 지원할 자리를 안 골랐으면 그 공고를 고른다(불러오는 사이 사용자가 고른 공고는 덮어쓰지 않는다).
      if (detail.resume.postingId && !postingRef.current) {
        const full = await fetchPosting(detail.resume.postingId);
        if (full && !postingRef.current) {
          setTargetMode("library");
          selectPosting(full, "이력서에 연결된 공고를 골랐습니다.");
        }
      } else if (detail.resume.roleTitle) {
        const role = detail.resume.roleTitle;
        setTargetRole((cur) => (cur.trim() ? cur : role));
      }
      setSavedNote(notes.join(" "));
    } catch {
      fail("이력서를 불러오지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setSavedLoading(false);
    }
  }

  function clearPosting() {
    postingRef.current = null;
    setPosting(null);
    setPostingDetail(null);
    setTargetNote(null);
  }

  // 이력서 화면의 "이 이력서로 진단"이 sessionStorage로 넘긴 값(한 번 읽고 지운다). 저장소는 마운트 뒤에만 읽을 수 있다.
  useEffect(() => {
    const p = takeDiagnosisPrefill();
    if (!p) return;
    /* eslint-disable react-hooks/set-state-in-effect -- 외부 저장소(sessionStorage)에서 한 번 읽는다 */
    if (p.postingId) {
      setPosting({ id: p.postingId, label: p.postingLabel ?? "" });
      setTargetMode("library");
      void fetchPosting(p.postingId).then((full) => full && setPostingDetail(full));
    }
    if (p.resumeText.trim()) {
      setResumeMode("text");
      setResumeText(p.resumeText);
    }
    if (p.targetRole.trim()) setTargetRole(p.targetRole);
    if (p.jdText.trim()) {
      setJdMode("text");
      setJdText(p.jdText);
      // 공고와 함께 왔으면 그 공고를 골랐을 때만(공고에 본문이 없으면) 이 JD를 쓴다.
      if (p.postingId) setPrefillJd({ postingId: p.postingId, text: p.jdText });
    }
    // 이력서에 붙인 포트폴리오: 뽑아 둔 글은 .txt 파일로 올리고(서버가 같은 추출기로 읽는다), 링크는 '링크·설명' 칸에 채운다.
    const prefillFile = p.portfolioText?.trim()
      ? new File([p.portfolioText], prefillPortfolioFileName(p.portfolioFileName), { type: "text/plain" })
      : null;
    const note = [p.portfolioUrl, p.portfolioNote].filter(Boolean).join("\n");
    if (prefillFile || note) {
      // 프리필도 한 출처로 기록해 두어, 뒤에 다른 포트폴리오를 고르면 이 값이 섞이지 않고 지워진다.
      applyPortfolioFill(nextPortfolioSeq(), "prefill", prefillFile, note || null);
      setPrefilledPortfolio(true);
    }
    setPrefilled(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    // 마운트 때 한 번만 읽는다(applyPortfolioFill은 상태 setter와 ref만 쓴다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasResume = resumeMode === "file" ? !!resumeFile : resumeText.trim().length > 0;
  /** 고른 공고로 보낼 JD: 공고 본문, 없으면 그 공고와 함께 넘어온 JD. 직접 입력 칸의 JD는 섞지 않는다. */
  const postingJd = fromPosting && posting ? postingDetail?.jdText?.trim() || (prefillJd?.postingId === posting.id ? prefillJd.text.trim() : "") : "";
  const hasJd = fromPosting
    ? !!postingJd
    : jdMode === "file"
      ? !!jdFile
      : jdText.trim().length > 0;
  const hasPortfolio = !!portfolioFile || portfolioText.trim().length > 0;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!hasResume) {
      setError(
        resumeMode === "file" ? "이력서 파일을 올려 주세요." : resumeMode === "saved" ? "서류에서 이력서를 골라 주세요." : "이력서 내용을 붙여넣어 주세요.",
      );
      return;
    }
    if (fromPosting && !posting) {
      setError("지원할 공고를 골라 주세요.");
      return;
    }
    if (savedLoading || libraryLoading) return;
    if (!targetRole.trim()) {
      setError("지원 직무를 입력해 주세요.");
      return;
    }
    if (!provider || !selected?.ready) {
      setError(selected?.reason ?? (providers.some((p) => p.ready) ? "사용할 AI 엔진을 골라 주세요." : NO_ENGINE_MESSAGE));
      return;
    }

    const tooBig = totalUploadError(
      [resumeMode === "file" ? resumeFile : null, !fromPosting && jdMode === "file" ? jdFile : null, portfolioFile],
      uploadLimits,
    );
    if (tooBig) {
      setError(tooBig);
      return;
    }

    const fd = new FormData();
    const F = DIAGNOSIS_FORM_FIELDS;
    if (resumeMode === "file" && resumeFile) fd.set(F.resumeFile, resumeFile);
    else fd.set(F.resumeText, resumeText);
    fd.set(F.targetRole, targetRole.trim());
    if (fromPosting) {
      // 고른 공고의 JD를 보낸다(비면 서버가 공고의 JD 원문으로 채운다). 직접 입력 칸에 남은 JD는 보내지 않는다.
      if (postingJd) fd.set(F.jdText, postingJd);
    } else if (jdMode === "file" && jdFile) fd.set(F.jdFile, jdFile);
    else if (jdText.trim()) fd.set(F.jdText, jdText);
    fd.set(F.situation, situation);
    if (notes.trim()) fd.set(F.notes, notes.trim());
    if (portfolioFile) fd.set(F.portfolioFile, portfolioFile);
    if (portfolioText.trim()) fd.set(F.portfolioText, portfolioText.trim());
    fd.set(F.provider, provider);
    if (fromPosting && posting) fd.set(F.postingId, posting.id);

    setSubmitting(true);
    try {
      const res = await fetch("/api/diagnoses", { method: "POST", body: fd });
      const data = (await res.json().catch(() => null)) as { id?: string; error?: string; warnings?: string[] } | null;
      if (res.status === 401) {
        router.push("/login?next=/app/new");
        return;
      }
      if (!res.ok || !data?.id) {
        setError(
          data?.error ??
            (res.status === 413 ? `파일이 너무 큽니다. ${uploadLimitMessage(uploadLimits)}` : STATUS_FALLBACK[res.status]) ??
            "진단을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
        );
        setSubmitting(false);
        return;
      }
      // 생성 경고(예: 채용 공고가 매우 짧음)는 진행 화면 상단에 한 번 보여 준다(URL이 아니라 sessionStorage로 넘긴다).
      saveCreationWarnings(data.id, data.warnings ?? []);
      router.push(`/app/d/${data.id}`);
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
      setSubmitting(false);
    }
  }

  // 넓은 화면(xl~)은 1·2번, 3·4번 카드를 2열로 나란히 두고 나머지(엔진·안내·제출)는 전체 폭. data-half 카드만 반 칸.
  return (
    <form onSubmit={onSubmit} className="grid gap-6 xl:grid-cols-2 xl:items-stretch [&>*]:col-span-full xl:[&>[data-half]]:col-span-1" noValidate>
      {prefilled && (
        <Alert tone="info">
          {posting
            ? `보관한 공고${posting.label ? `(${posting.label})` : ""}의 직무와 JD를 채웠습니다. 이력서를 넣고 진단을 시작하세요. 진단은 이 공고에 연결됩니다.`
            : `이력서 화면에서 내용${prefilledPortfolio ? "과 첨부 포트폴리오" : ""}를 가져와 채웠습니다. 확인한 뒤 진단을 시작하세요.`}
        </Alert>
      )}
      {/* 1. 이력서 + 포트폴리오 */}
      <Card data-half className="flex min-h-[40rem] flex-col p-5 sm:p-6">
        <SectionTitle step={1} title="이력서" required />
        <div className="mt-4 flex flex-1 flex-col gap-3">
          <SegmentedTabs
            label="이력서 입력 방식"
            value={resumeMode}
            onChange={(m) => {
              setResumeMode(m);
              setSavedNote(null);
            }}
            options={[
              { value: "file", label: "파일 올리기" },
              { value: "saved", label: "서류에서 선택" },
              { value: "text", label: "직접 붙여넣기" },
            ]}
          />
          {resumeMode === "file" && (
            <FileDrop
              maxBytes={uploadLimits.perFileBytes}
              file={resumeFile}
              accept={RESUME_ACCEPT}
              label="이력서 파일을 끌어다 놓거나 눌러서 선택"
              hint={`${UPLOAD_FORMATS_LABEL}, ${perFile} 이하. 이미지로 된 PDF와 암호·배포용 HWP는 읽지 못하니 붙여넣기를 써 주세요.`}
              onChange={(f, err) => {
                setResumeFile(f);
                setFileError((p) => ({ ...p, resume: err ?? undefined }));
              }}
            />
          )}
          {resumeMode === "saved" &&
            (resumes.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                아직 만든 이력서가 없습니다.{" "}
                <Link href="/app/resumes/new" className="font-medium text-indigo-700 hover:underline">
                  새 이력서
                </Link>
                를 만들거나 파일·붙여넣기를 써 주세요.
              </p>
            ) : (
              <div>
                <label htmlFor="saved-resume" className="block text-sm font-medium text-slate-800">
                  내 이력서
                </label>
                <select
                  id="saved-resume"
                  value={savedResumeId}
                  disabled={savedLoading}
                  onChange={(e) => void loadSavedResume(e.target.value)}
                  className={inputClass}
                >
                  <option value="">이력서를 고르세요</option>
                  {resumes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.kind === "general" ? `[공용] ${r.title}` : `${r.title} (${r.company} · ${r.roleTitle})`}
                    </option>
                  ))}
                </select>
                {savedLoading && <p className="mt-2 text-sm text-indigo-700">불러오는 중…</p>}
                {savedNote && <p className="mt-2 text-sm text-emerald-700">{savedNote}</p>}
              </div>
            ))}
          {(resumeMode === "text" || (resumeMode === "saved" && resumeText)) && (
            <textarea
              aria-label="이력서 내용"
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              rows={resumeMode === "saved" ? 10 : 16}
              placeholder="이력서 전체를 붙여넣어 주세요. 문장은 고치지 말고 그대로 넣어야 심사위원이 정확히 인용합니다."
              className={`${textareaClass} flex-1`}
            />
          )}
          {fileError.resume && <p className="text-sm text-red-600">{fileError.resume}</p>}

          <div className="mt-2 border-t border-slate-100 pt-4">
            <h3 className="text-sm font-semibold text-slate-900">
              포트폴리오 <span className="font-normal text-slate-400">(선택)</span>
            </h3>
            <p className="mt-1 text-sm text-slate-500">
              함께 내면 이력서와 <strong className="font-medium text-slate-700">별개 자료</strong>로 참고해, 이력서에 빠진 근거를 옮길 방향을 알려 줍니다.
              인용 확인은 이력서 원문만 대상으로 합니다.
            </p>
            <div className="mt-3 space-y-3">
              <SegmentedTabs
                label="포트폴리오 입력 방식"
                value={portfolioMode}
                onChange={setPortfolioMode}
                options={[
                  { value: "file", label: "파일 올리기" },
                  { value: "library", label: "포트폴리오에서 선택" },
                ]}
              />
              {portfolioMode === "file" ? (
                <>
                  <FileDrop
                    maxBytes={uploadLimits.perFileBytes}
                    file={portfolioFile}
                    accept={PORTFOLIO_ACCEPT}
                    label="포트폴리오 파일을 끌어다 놓거나 눌러서 선택"
                    hint={`${UPLOAD_FORMATS_LABEL}, ${perFile} 이하. 글자를 읽을 수 있는 파일만 반영되며, 긴 파일은 앞부분만 씁니다.`}
                    onChange={(f, err) => {
                      onOwnPortfolioFile(f);
                      setFileError((p) => ({ ...p, portfolio: err ?? undefined }));
                    }}
                  />
                  {fileError.portfolio && <p className="text-sm text-red-600">{fileError.portfolio}</p>}
                </>
              ) : portfolios.length === 0 ? (
                <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                  보관한 포트폴리오가 없습니다.{" "}
                  <Link href="/app/portfolios" className="font-medium text-indigo-700 hover:underline">
                    포트폴리오
                  </Link>
                  에서 추가하거나 파일을 올려 주세요.
                </p>
              ) : (
                <div>
                  <label htmlFor="library-portfolio" className="block text-sm font-medium text-slate-800">
                    내 포트폴리오
                  </label>
                  <select
                    id="library-portfolio"
                    value={libraryPortfolioId}
                    disabled={libraryLoading}
                    onChange={(e) => void loadLibraryPortfolio(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">포트폴리오를 고르세요</option>
                    {portfolios.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({PORTFOLIO_KIND_LABELS[p.kind]} · {portfolioSourceLabel(p)})
                      </option>
                    ))}
                  </select>
                  {libraryLoading && <p className="mt-2 text-sm text-indigo-700">불러오는 중…</p>}
                  {libraryNote && <p className="mt-2 text-sm text-emerald-700">{libraryNote}</p>}
                  {libraryPortfolioId && !libraryLoading && (
                    <p className="mt-1 text-xs text-slate-500">
                      {portfolioFile ? <>넣은 파일: {portfolioFile.name} </> : null}
                      <button type="button" onClick={removeLibraryPortfolio} className="font-medium text-indigo-700 hover:underline">
                        선택 빼기
                      </button>
                    </p>
                  )}
                </div>
              )}
              <div>
                <label htmlFor="portfolioText" className="block text-sm font-medium text-slate-800">
                  링크·설명
                </label>
                <textarea
                  id="portfolioText"
                  value={portfolioText}
                  onChange={(e) => setPortfolioText(e.target.value)}
                  maxLength={PORTFOLIO_NOTE_MAX}
                  rows={3}
                  placeholder={"예: https://github.com/me/payments — 결제 정산 배치를 Kotlin으로 재작성, 처리 시간 4시간 → 40분.\n링크는 열어 보지 못하므로 프로젝트 내용·역할·결과를 함께 적어 주세요."}
                  className={textareaClass}
                />
                <p className="mt-1 text-right text-xs text-slate-400">
                  {portfolioText.length}/{PORTFOLIO_NOTE_MAX}
                </p>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* 2. 지원 직무 + JD */}
      <Card data-half className="flex min-h-[40rem] flex-col p-5 sm:p-6">
        <SectionTitle step={2} title="지원할 자리" />
        <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="지원할 자리 고르는 방법">
          {TARGET_MODES.map((t) => (
            <label
              key={t.key}
              className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60"
            >
              <input
                type="radio"
                name="target"
                value={t.key}
                checked={targetMode === t.key}
                onChange={() => {
                  setTargetMode(t.key);
                  // 고르는 방법을 바꾸면 링크 가져오기 화면이 사라지므로 진행 중 표시도 푼다.
                  setImporting(false);
                  if (t.key === "manual") clearPosting();
                }}
                className="mt-1 accent-indigo-600"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-slate-900">{t.name}</span>
                <span className="block text-xs text-slate-500">{t.description}</span>
              </span>
            </label>
          ))}
        </div>
        {fromPosting && posting && (
          <div className="mt-4 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-medium text-indigo-700">고른 공고</p>
                <p className="truncate text-sm font-semibold text-slate-900">{posting.label || "보관한 공고"}</p>
              </div>
              <div className="flex items-center gap-3 text-sm">
                <Link href={`/app/postings/${posting.id}`} target="_blank" className="text-slate-500 hover:text-slate-800 hover:underline">
                  공고 보기 ↗
                </Link>
                <button type="button" onClick={clearPosting} className="font-medium text-indigo-700 hover:underline">
                  다른 공고 고르기
                </button>
              </div>
            </div>
            {postingDetail && (
              <p className="mt-1.5 text-xs text-slate-600">
                {postingJd
                  ? `이 공고의 JD(${postingJd.length.toLocaleString()}자)로 적합도를 분석합니다. 진단은 이 공고에 연결됩니다.`
                  : "이 공고에 JD 본문이 없어 직무명으로 요건을 추정합니다. 공고 상세에서 JD를 채우면 더 정확합니다."}
              </p>
            )}
            {targetNote && <p className="mt-1 text-xs text-emerald-700">{targetNote}</p>}
          </div>
        )}
        {fromPosting && !posting && (
          <div className="mt-4">
            <PostingTargetPicker key={targetMode} mode={targetMode} options={postings} onSelect={selectPosting} onBusyChange={setImporting} />
          </div>
        )}
        <div className={fromPosting && !posting ? "hidden" : "mt-4 space-y-5"}>
          <div>
            <label htmlFor="targetRole" className="block text-sm font-medium text-slate-800">
              지원 직무 <span className="text-red-600">*</span>
            </label>
            <input
              id="targetRole"
              required
              maxLength={200}
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
              placeholder="예: 백엔드 개발자(3년차), 퍼포먼스 마케터, 데이터 분석가"
              className={inputClass}
            />
          </div>

          {!fromPosting && (
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="block text-sm font-medium text-slate-800">
                채용 공고(JD) <span className="font-normal text-indigo-700">· 강력 권장</span>
              </span>
              <SegmentedTabs
                label="JD 입력 방식"
                value={jdMode}
                onChange={setJdMode}
                options={[
                  { value: "text", label: "붙여넣기" },
                  { value: "file", label: "파일" },
                ]}
              />
            </div>
            <p className="mt-1.5 text-sm text-slate-500">
              JD를 넣으면 공고의 필수·우대 요건을 뽑아 <strong className="font-medium text-slate-700">요건별 적합도 매트릭스</strong>를
              만들고, 서류 자동 필터가 공고 키워드 기준으로 심사하며, 개선 방향도 이 공고에 맞춰집니다.
            </p>
            <div className="mt-3">
              {jdMode === "text" ? (
                <textarea
                  aria-label="채용 공고 내용"
                  value={jdText}
                  onChange={(e) => setJdText(e.target.value)}
                  rows={8}
                  placeholder="공고 본문(주요 업무, 자격 요건, 우대 사항 등)을 그대로 붙여넣어 주세요."
                  className={textareaClass}
                />
              ) : (
                <FileDrop
                  maxBytes={uploadLimits.perFileBytes}
                  file={jdFile}
                  accept={JD_ACCEPT}
                  label="공고 파일을 끌어다 놓거나 눌러서 선택"
                  onChange={(f, err) => {
                    setJdFile(f);
                    setFileError((p) => ({ ...p, jd: err ?? undefined }));
                  }}
                />
              )}
              {fileError.jd && <p className="mt-2 text-sm text-red-600">{fileError.jd}</p>}
            </div>
          </div>
          )}
          {(!fromPosting || posting) && !hasJd && (
            <Alert tone="warning">
              JD 없이도 진단할 수 있지만, 이때는 직무명만으로 요건을 <strong>추정</strong>합니다. 적합도 점수와 키워드
              심사의 정확도가 크게 떨어지고 보고서에 &lsquo;추정&rsquo;으로 표시됩니다.
            </Alert>
          )}
        </div>
      </Card>

      {/* 3. 메모 */}
      <Card className="p-5 sm:p-6">
        <SectionTitle step={3} title="메모" optional />
        <div className="mt-4">
          <label htmlFor="notes" className="sr-only">
            메모
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="심사위원이 알아야 할 사정이 있으면 적어 주세요. 예: 마케팅 3년 후 데이터 분석으로 전환 중. 공백기 6개월은 부트캠프 수료."
            className={textareaClass}
          />
          <p className="mt-1 text-right text-xs text-slate-400">{notes.length}/2000</p>
        </div>
      </Card>

      {/* 5. AI 엔진 */}
      {(providers.length > 1 || hasCliOptions) && (
        <Card className="p-5 sm:p-6">
          <SectionTitle step={4} title="AI 엔진" />
          <fieldset className="mt-4">
            <legend className="sr-only">심사에 쓸 AI 엔진</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {providers.map((p) => (
                <label
                  key={p.id}
                  className={`flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60 ${p.ready ? "cursor-pointer" : "cursor-not-allowed opacity-60"}`}
                >
                  <input
                    type="radio"
                    name="provider"
                    value={p.id}
                    checked={provider === p.id}
                    disabled={!p.ready}
                    onChange={() => setProvider(p.id)}
                    className="mt-1 accent-indigo-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">{p.label}</span>
                    <span className="block text-xs text-slate-500">
                      {p.ready ? (p.account ? `${p.account} · ${p.description}` : p.description) : p.reason}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {hasCliOptions && (
            <p className="mt-3 text-sm text-slate-500">
              계정 로그인은{" "}
              <Link href="/app/connections" className="font-medium text-indigo-700 hover:underline">
                AI 연결
              </Link>
              에서 합니다.
            </p>
          )}
        </Card>
      )}

      {!providers.some((p) => p.ready) && (
        <Alert tone="error" title="사용할 수 있는 AI 엔진이 없습니다">
          {NO_ENGINE_MESSAGE}
        </Alert>
      )}

      <Alert tone="info" title="보내기 전에 확인해 주세요">
        {destination
          ? `이력서와 JD${hasPortfolio ? ", 포트폴리오" : ""}는 분석을 위해 ${destination}(으)로 전송됩니다. `
          : `이력서와 JD${hasPortfolio ? ", 포트폴리오" : ""}는 분석을 위해 선택한 AI 엔진으로 전송됩니다. `}
        주민등록번호, 집 주소, 전화번호 등 보내고 싶지 않은 정보는 미리 지워 주세요. 심사는 이력서에 있는 사실만 사용하며,
        모르는 내용은 지어내지 않고 질문으로 남깁니다.
      </Alert>

      {error && (
        <Alert tone="error" title="진단을 시작하지 못했습니다">
          {error}
        </Alert>
      )}

      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
        <p className="text-sm text-slate-500 sm:mr-auto">
          시작하면 약 {isCli ? "5~15분" : "3~5분"} 걸립니다. 창을 닫아도 진단은 계속됩니다.
        </p>
        <Button type="submit" size="lg" loading={submitting} disabled={importing || savedLoading}>
          {submitting ? "업로드 중…" : "심사 시작"}
        </Button>
      </div>
    </form>
  );
}

const inputClass =
  "mt-1.5 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-[15px] text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";
const textareaClass = `${inputClass} resize-y leading-relaxed`;

function SectionTitle({
  step,
  title,
  required,
  optional,
}: {
  step: number;
  title: string;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
      <span className="grid size-6 place-items-center rounded-full bg-indigo-600 text-xs font-bold text-white">
        {step}
      </span>
      {title}
      {required && <span className="text-red-600" aria-hidden>*</span>}
      {optional && <span className="text-sm font-normal text-slate-400">(선택)</span>}
    </h2>
  );
}
