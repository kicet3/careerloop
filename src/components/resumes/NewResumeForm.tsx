"use client";
/**
 * 새 이력서 폼.
 * 1) 지원할 자리: 내 보관함 공고 고르기(검색) / 공고 링크로 가져오기(끝나면 자동 선택, 이미 있는 공고·공고 찾기의 공고는 바로 선택) /
 *    공용 이력서(회사 지정 없음). 회사·직무·JD는 직접 입력하지 않고 공고에서 가져온다(서버가 공고 값으로 채운다).
 * 2) 초안 출처: 경험 그래프·진단 재작성본(AI) / 공용 이력서 내용으로 시작(복사, AI 없음) / 빈 문서.
 *    AI 초안은 서버가 백그라운드 작업으로 쓴다(202 { draftJob }) — 바로 진행 화면(/app/resumes/drafts/[id])으로 옮긴다.
 * 양식은 편집 화면 위쪽에서 고른다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { formatDateTime } from "@/components/app/stages";
import { usePostingImports } from "@/components/postings/import-jobs";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { isPostingImportActive, POSTING_IMPORT_STATUS_LABELS, POSTING_STATUS_LABELS, type JobPosting, type PostingStatus } from "@/lib/domain/postings";
import { NO_ENGINE_MESSAGE, PROVIDER_DATA_DESTINATION, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { DEFAULT_RESUME_TEMPLATE } from "@/lib/domain/resumes";
import type { StartResumeDraftResponse } from "@/lib/resumes/draft-job-types";
import type { StartResumeAgentResponse } from "@/lib/resume-agent/job-types";
import { saveDraftNotes } from "@/lib/resumes/prefill";
import {
  RESUME_DRAFT_SOURCE_KINDS,
  RESUME_DRAFT_SOURCE_LABELS,
  type CreateResumeRequest,
  type CreateResumeResponse,
  type ResumeDraftSourceKind,
} from "@/lib/resumes/types";
import { inputClass } from "./styles";

export interface RewriteOption {
  id: string;
  title: string;
  targetRole: string;
  createdAt: number;
}

/** 지원할 자리로 고를 수 있는 보관함 공고(목록에 필요한 값만). */
export interface PostingPickOption {
  id: string;
  company: string;
  roleTitle: string;
  status: PostingStatus;
  deadline: string;
  updatedAt: number;
}

/** '공용 이력서 내용으로 시작'의 원본. */
export interface GeneralResumeOption {
  id: string;
  title: string;
  updatedAt: number;
}

export type TargetMode = "library" | "url" | "general";
/** 초안 출처(화면): API의 출처 + 'copy'(공용 이력서 내용 복사). */
export type FormSourceKind = ResumeDraftSourceKind | "copy";

const TARGET_MODES: { key: TargetMode; name: string; description: string }[] = [
  { key: "library", name: "내 보관함에서", description: "보관한 공고를 검색해 고릅니다." },
  { key: "url", name: "공고 링크로", description: "링크를 넣으면 보관함에 담고 바로 고릅니다." },
  { key: "general", name: "공용 이력서", description: "회사 지정 없이 여러 곳에 쓰는 기본 이력서." },
];

export const COPY_SOURCE_LABEL = { name: "공용 이력서 내용으로 시작", description: "고른 공용 이력서의 현재 버전을 복사해 시작합니다(AI 없음)." };

/**
 * POST /api/resumes 본문. 회사·직무·JD는 비워 보내고 서버가 공고 값으로 채운다. 양식은 기본 양식(성과 중심)으로 시작한다
 * (복사면 원본 양식).
 */
export function createResumeRequestBody(f: {
  target: { kind: "posting"; postingId: string } | { kind: "general" };
  source: FormSourceKind;
  diagnosisId: string;
  provider: ProviderId | null;
  sourceResumeId: string | null;
  /** 경험 그래프 출처의 작성 방식(에이전트 / 빠른 초안). 그 밖의 출처면 무시한다. */
  writeMode?: WriteMode;
}): CreateResumeRequest {
  const copy = f.source === "copy" && !!f.sourceResumeId;
  const source: CreateResumeRequest["source"] =
    f.source === "diagnosis" ? { kind: "diagnosis", diagnosisId: f.diagnosisId } : f.source === "graph" ? { kind: "graph" } : { kind: "blank" };
  return {
    kind: f.target.kind === "general" ? "general" : "company",
    company: "",
    roleTitle: "",
    jdText: "",
    templateId: DEFAULT_RESUME_TEMPLATE,
    title: "",
    source,
    provider: copy ? null : f.provider,
    postingId: f.target.kind === "posting" ? f.target.postingId : null,
    sourceResumeId: copy ? f.sourceResumeId : null,
    ...(f.source === "graph" && f.writeMode ? { mode: f.writeMode } : {}),
  };
}

/** 경험 그래프 출처의 작성 방식. */
export type WriteMode = "agent" | "single";

export const WRITE_MODE_LABELS: Record<WriteMode, { name: string; description: string }> = {
  agent: {
    name: "AI 에이전트로 작성 (권장)",
    description: "JD 요건별로 경험 그래프의 근거를 찾고, 심사위원 심사를 통과할 때까지 근거 안에서만 다듬습니다. 보통 8~15분.",
  },
  single: { name: "빠른 초안", description: "AI가 한 번에 초안을 씁니다. 1~3분." },
};

/** 보관함 공고 검색(회사·직무 부분 일치, 대소문자 무시). */
export function searchPostingOptions(options: PostingPickOption[], query: string, limit = 8): PostingPickOption[] {
  const q = query.trim().toLowerCase();
  const hits = q ? options.filter((p) => `${p.company} ${p.roleTitle}`.toLowerCase().includes(q)) : options;
  return hits.slice(0, limit);
}

function toPickOption(p: Pick<JobPosting, "id" | "company" | "roleTitle" | "status" | "deadline" | "updatedAt">): PostingPickOption {
  return { id: p.id, company: p.company, roleTitle: p.roleTitle, status: p.status, deadline: p.deadline, updatedAt: p.updatedAt };
}

async function fetchPostingOption(id: string): Promise<PostingPickOption | null> {
  try {
    const res = await fetch(`/api/postings/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!res.ok) return null;
    return toPickOption(((await res.json()) as { posting: JobPosting }).posting);
  } catch {
    return null;
  }
}

export function NewResumeForm({
  providers,
  defaultProvider,
  graphAvailable,
  agentAvailable = false,
  diagnoses,
  postings = [],
  generalResumes = [],
  posting = null,
  sourceResumeId: initialSourceResumeId = null,
  initialTarget,
}: {
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
  graphAvailable: boolean;
  /** 그래프 이력서 에이전트를 쓸 수 있는가(RESUME_AGENT 플래그 + 그래프 저장소). 아니면 작성 방식 선택을 숨긴다. */
  agentAvailable?: boolean;
  diagnoses: RewriteOption[];
  /** 내 보관함 공고(최근 수정 순). */
  postings?: PostingPickOption[];
  /** 내 공용 이력서('공용 이력서 내용으로 시작'). */
  generalResumes?: GeneralResumeOption[];
  /** 공고 상세의 "이 공고용 이력서"에서 왔으면 그 공고(미리 고른다). */
  posting?: PostingPickOption | null;
  /** 이력서 목록의 "이 공고용으로 복제"에서 왔으면 그 공용 이력서(출처를 '공용 이력서 내용으로 시작'으로 둔다). */
  sourceResumeId?: string | null;
  /** 처음 고를 지원 대상(?target=general). */
  initialTarget?: TargetMode;
}) {
  const router = useRouter();
  const [options, setOptions] = useState<PostingPickOption[]>(() =>
    posting && !postings.some((p) => p.id === posting.id) ? [posting, ...postings] : postings,
  );
  const [mode, setMode] = useState<TargetMode>(initialTarget ?? (posting || postings.length > 0 ? "library" : "url"));
  const [selected, setSelected] = useState<PostingPickOption | null>(posting);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [urlNote, setUrlNote] = useState<string | null>(null);
  const canCopy = generalResumes.length > 0;
  const fromCopy = !!initialSourceResumeId && generalResumes.some((r) => r.id === initialSourceResumeId);
  const [source, setSource] = useState<FormSourceKind>(
    fromCopy ? "copy" : graphAvailable ? "graph" : diagnoses.length ? "diagnosis" : "blank",
  );
  const [copyId, setCopyId] = useState(fromCopy ? initialSourceResumeId! : (generalResumes[0]?.id ?? ""));
  const [diagnosisId, setDiagnosisId] = useState(diagnoses[0]?.id ?? "");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [error, setError] = useState<string | null>(null);
  const [errorLink, setErrorLink] = useState<{ href: string; label: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [writeMode, setWriteMode] = useState<WriteMode>(agentAvailable ? "agent" : "single");

  const choose = (p: PostingPickOption) => {
    setOptions((prev) => [p, ...prev.filter((x) => x.id !== p.id)]);
    setSelected(p);
    setMode("library");
    setError(null);
  };

  const imports = usePostingImports({
    onCompleted: async (job) => {
      if (!job.postingId) return;
      const p = await fetchPostingOption(job.postingId);
      if (p) {
        choose(p);
        setUrlNote(job.fromShared ? "공고 찾기에 있던 공고를 보관함에 담고 골랐습니다." : "공고를 보관함에 담고 골랐습니다.");
      } else setUrlError("가져온 공고를 읽지 못했습니다. 내 보관함에서 골라 주세요.");
    },
    // 리다이렉트 뒤 최종 주소가 이미 보관한 공고였으면 작업은 실패로 끝나고 postingId에 그 공고가 실린다 — 그 공고를 고른다.
    onFailed: async (job) => {
      if (!job.postingId) return;
      const p = await fetchPostingOption(job.postingId);
      if (!p) return;
      choose(p);
      imports.dismiss(job.id);
      setUrlNote("이미 보관함에 있는 공고라 그 공고를 골랐습니다.");
    },
  });
  const urlJob = imports.jobs[0];
  const importing = !!urlJob && isPostingImportActive(urlJob.status);

  async function importUrl() {
    const value = url.trim();
    setUrlError(null);
    setUrlNote(null);
    if (!value) {
      setUrlError("공고 상세 페이지 주소를 붙여넣으세요.");
      return;
    }
    const result = await imports.start(value);
    if (result.ok) {
      setUrl("");
      return;
    }
    if (result.error.existingId) {
      // 이미 보관한 공고: 다시 가져오지 않고 그 공고를 고른다.
      const p = await fetchPostingOption(result.error.existingId);
      if (p) {
        choose(p);
        setUrl("");
        setUrlNote("이미 보관함에 있는 공고라 그 공고를 골랐습니다.");
        return;
      }
    }
    setUrlError(result.error.error);
  }

  const general = mode === "general";
  const usesAi = source === "graph" || source === "diagnosis";
  const selectedProvider = providers.find((p) => p.id === provider);
  const destination = provider ? PROVIDER_DATA_DESTINATION[provider] : null;
  const sourceDisabled = (k: FormSourceKind) =>
    k === "graph" ? !graphAvailable : k === "diagnosis" ? diagnoses.length === 0 : k === "copy" ? !canCopy : false;
  const results = useMemo(() => searchPostingOptions(options, query), [options, query]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setErrorLink(null);
    if (!general && !selected) {
      setError(mode === "url" ? "공고 링크를 가져와 지원할 공고를 정해 주세요." : "지원할 공고를 골라 주세요.");
      return;
    }
    if (source === "diagnosis" && !diagnosisId) {
      setError("재작성본을 가져올 진단을 골라 주세요.");
      return;
    }
    if (source === "copy" && !copyId) {
      setError("내용을 가져올 공용 이력서를 골라 주세요.");
      return;
    }
    if (usesAi && (!provider || !selectedProvider?.ready)) {
      setError(selectedProvider?.reason ?? (providers.some((p) => p.ready) ? "사용할 AI 엔진을 골라 주세요." : NO_ENGINE_MESSAGE));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          createResumeRequestBody({
            target: general ? { kind: "general" } : { kind: "posting", postingId: selected!.id },
            source,
            diagnosisId,
            provider: usesAi ? provider : null,
            sourceResumeId: source === "copy" ? copyId : null,
            writeMode: agentAvailable ? writeMode : "single",
          }),
        ),
      });
      const data = (await res.json().catch(() => null)) as
        | (Partial<CreateResumeResponse & StartResumeDraftResponse & StartResumeAgentResponse> & { error?: string; code?: string; agentJobId?: string })
        | null;
      if (res.status === 401) {
        router.push("/login?next=/app/resumes/new");
        return;
      }
      // 에이전트: 서버가 단계별로 이어서 쓴다 — 에이전트 진행 화면으로.
      const agentJobId = res.ok ? data?.agentJob?.id : undefined;
      if (agentJobId) {
        router.push(`/app/resumes/agent/${encodeURIComponent(agentJobId)}`);
        return;
      }
      if (res.status === 409 && data?.code === "busy") {
        setError(data.error ?? "진행 중인 에이전트 작업이 많습니다. 끝난 뒤 다시 시도해 주세요.");
        // 동시 작업 상한(3개)이라 막은 작업이 하나가 아니다 — 진행 중인 작업이 모두 보이는 목록으로 보낸다.
        setErrorLink({ href: "/app/resumes", label: "진행 중인 작업 목록 보기" });
        setSubmitting(false);
        return;
      }
      // AI 초안: 서버가 백그라운드에서 쓴다 — 바로 진행 화면으로 옮긴다(화면을 떠나도 계속되고, 끝나면 알림).
      const draftJobId = res.ok ? data?.draftJob?.id : undefined;
      if (draftJobId) {
        // 에이전트를 골랐지만 지금 쓸 수 없어 빠른 초안으로 만들었으면 진행 화면이 그 사실을 알린다.
        router.push(`/app/resumes/drafts/${encodeURIComponent(draftJobId)}${data?.modeFallback ? "?fallback=agent" : ""}`);
        return;
      }
      if (!res.ok || !data?.id) {
        setError(data?.error ?? "이력서를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
        setSubmitting(false);
        return;
      }
      saveDraftNotes(data.id, { notes: data.notes ?? [], missingInfo: data.missingInfo ?? [] });
      router.push(`/app/resumes/${data.id}`);
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
      setSubmitting(false);
    }
  }

  const sourceKinds: FormSourceKind[] = [...RESUME_DRAFT_SOURCE_KINDS.filter((k) => k !== "blank"), "copy", "blank"];
  const submitLabel = usesAi ? "초안 만들기" : source === "copy" ? "복사해서 만들기" : "빈 문서로 만들기";

  // 양식은 여기서 고르지 않는다(편집 화면 상단의 가로 스크롤 양식 고르기에서 바꾼다).
  return (
    <form onSubmit={onSubmit} className="grid gap-6" noValidate>
      <Card className="p-5 sm:p-6">
        <fieldset>
          <legend className="text-base font-semibold text-slate-900">지원할 자리</legend>
          <p className="mt-1 text-sm text-slate-500">회사·직무·JD는 고른 공고에서 가져옵니다. 양식은 다음 화면(편집) 위쪽에서 고르고 언제든 바꿀 수 있습니다.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="지원 대상 고르는 방법">
            {TARGET_MODES.map((t) => (
              <label
                key={t.key}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60"
              >
                <input type="radio" name="target" value={t.key} checked={mode === t.key} onChange={() => setMode(t.key)} className="mt-1 accent-indigo-600" />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900">{t.name}</span>
                  <span className="block text-xs text-slate-500">{t.description}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {!general && selected && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-indigo-700">고른 공고</p>
              <p className="truncate text-sm font-semibold text-slate-900">
                {selected.company} · {selected.roleTitle}
              </p>
            </div>
            <div className="flex items-center gap-3 text-sm">
              <Link href={`/app/postings/${selected.id}`} target="_blank" className="text-slate-500 hover:text-slate-800 hover:underline">
                공고 보기 ↗
              </Link>
              <button type="button" onClick={() => setSelected(null)} className="font-medium text-indigo-700 hover:underline">
                다른 공고 고르기
              </button>
            </div>
          </div>
        )}

        {mode === "library" && !selected && (
          <div className="mt-4">
            <label htmlFor="posting-query" className="block text-sm font-medium text-slate-800">
              보관함 공고 검색
            </label>
            <input
              id="posting-query"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="회사·직무 검색"
              className={inputClass}
            />
            {options.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">
                보관한 공고가 없습니다. &lsquo;공고 링크로&rsquo;를 고르거나{" "}
                <Link href="/app/postings/explore" className="font-medium text-indigo-700 hover:underline">
                  공고 찾기
                </Link>
                에서 공고를 담아 주세요.
              </p>
            ) : results.length === 0 ? (
              <p className="mt-3 text-sm text-slate-500">검색 결과가 없습니다.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200">
                {results.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => choose(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-indigo-50/50">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium text-slate-900">{p.company}</span>
                        <span className="block truncate text-xs text-slate-500">{p.roleTitle}</span>
                      </span>
                      <Badge tone="neutral">{POSTING_STATUS_LABELS[p.status]}</Badge>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {mode === "url" && (
          <div className="mt-4">
            <label htmlFor="resume-posting-url" className="block text-sm font-medium text-slate-800">
              공고 링크
            </label>
            <div className="mt-1.5 flex flex-col gap-2 sm:flex-row">
              <input
                id="resume-posting-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!importing) void importUrl();
                  }
                }}
                placeholder="채용 공고 상세 주소 붙여넣기"
                className={cn(inputClass, "mt-0 min-w-0 flex-1")}
              />
              <Button type="button" variant="secondary" loading={importing} disabled={importing} onClick={() => void importUrl()}>
                가져와서 고르기
              </Button>
            </div>
            <p className="mt-1.5 text-xs text-slate-500">
              이미 보관함에 있거나 공고 찾기에 있는 공고는 AI 없이 바로 고릅니다. 새 링크는 AI가 정리하는 데 30초~2분 걸립니다.
            </p>
            {importing && urlJob && (
              <p className="mt-2 flex items-center gap-2 text-sm text-indigo-800" role="status">
                <Spinner size="sm" /> {POSTING_IMPORT_STATUS_LABELS[urlJob.status]}…
              </p>
            )}
            {urlJob?.status === "failed" && <p className="mt-2 text-sm text-red-700">{urlJob.error ?? "공고를 가져오지 못했습니다."}</p>}
            {urlError && <p className="mt-2 text-sm text-red-700">{urlError}</p>}
          </div>
        )}
        {urlNote && !general && selected && <p className="mt-2 text-sm text-emerald-700">{urlNote}</p>}

        {general && (
          <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
            회사·직무를 정하지 않은 공용 이력서를 만듭니다. 나중에 이력서 목록에서 &lsquo;이 공고용으로 복제&rsquo;로 지원처별 이력서를 바로 만들 수 있습니다.
          </p>
        )}
      </Card>

      <Card className="p-5 sm:p-6">
        <fieldset>
          <legend className="text-base font-semibold text-slate-900">초안 출처</legend>
          <div className="mt-4 grid gap-2">
            {sourceKinds.map((k) => {
              const disabled = sourceDisabled(k);
              const label = k === "copy" ? COPY_SOURCE_LABEL : RESUME_DRAFT_SOURCE_LABELS[k];
              const hint =
                k === "graph" && !graphAvailable
                  ? "경험 그래프 저장소가 설정되지 않아 쓸 수 없습니다."
                  : k === "diagnosis" && diagnoses.length === 0
                    ? "다시 쓴 이력서가 있는 진단이 아직 없습니다."
                    : k === "copy" && !canCopy
                      ? "공용 이력서가 아직 없습니다. 지원할 자리에서 '공용 이력서'로 먼저 만들 수 있습니다."
                      : label.description;
              return (
                <label
                  key={k}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60",
                    disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  )}
                >
                  <input
                    type="radio"
                    name="source"
                    value={k}
                    checked={source === k}
                    disabled={disabled}
                    onChange={() => setSource(k)}
                    className="mt-1 accent-indigo-600"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-900">{label.name}</span>
                    <span className="block text-xs text-slate-500">{hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {source === "graph" && agentAvailable && (
            <fieldset className="mt-4 rounded-lg bg-slate-50 p-3">
              <legend className="px-1 text-sm font-medium text-slate-900">작성 방식</legend>
              <div className="mt-1 grid gap-2">
                {(["agent", "single"] as const).map((m) => (
                  <label key={m} className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5 has-[:checked]:border-indigo-500">
                    <input type="radio" name="writeMode" value={m} checked={writeMode === m} onChange={() => setWriteMode(m)} className="mt-1 accent-indigo-600" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{WRITE_MODE_LABELS[m].name}</span>
                      <span className="block text-xs text-slate-500">{WRITE_MODE_LABELS[m].description}</span>
                    </span>
                  </label>
                ))}
              </div>
              {writeMode === "agent" && general && <p className="mt-2 text-xs text-slate-500">공고가 없으면 직무명으로 요건을 추정합니다.</p>}
            </fieldset>
          )}
          {source === "graph" && (
            <p className="mt-3 text-sm text-slate-500">
              그래프가 비어 있다면{" "}
              <Link href="/app/graph" className="font-medium text-indigo-700 hover:underline">
                경험 그래프
              </Link>
              에서 먼저 경력·경험을 정리해 주세요.
            </p>
          )}
          {source === "diagnosis" && diagnoses.length > 0 && (
            <div className="mt-4">
              <label htmlFor="diagnosisId" className="block text-sm font-medium text-slate-800">
                진단 고르기
              </label>
              <select id="diagnosisId" value={diagnosisId} onChange={(e) => setDiagnosisId(e.target.value)} className={inputClass}>
                {diagnoses.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title} · {formatDateTime(d.createdAt)}
                  </option>
                ))}
              </select>
            </div>
          )}
          {source === "copy" && canCopy && (
            <div className="mt-4">
              <label htmlFor="copyResumeId" className="block text-sm font-medium text-slate-800">
                공용 이력서 고르기
              </label>
              <select id="copyResumeId" value={copyId} onChange={(e) => setCopyId(e.target.value)} className={inputClass}>
                {generalResumes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.title} · {formatDateTime(r.updatedAt)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
      </Card>

      {usesAi && providers.length > 1 && (
        <Card className="p-5 sm:p-6">
          <fieldset>
            <legend className="text-base font-semibold text-slate-900">AI 엔진</legend>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {providers.map((p) => (
                <label
                  key={p.id}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60",
                    p.ready ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                  )}
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
        </Card>
      )}

      {usesAi && !providers.some((p) => p.ready) && (
        <Alert tone="error" title="사용할 수 있는 AI 엔진이 없습니다">
          {NO_ENGINE_MESSAGE} 빈 문서로는 지금 시작할 수 있습니다.
        </Alert>
      )}

      {usesAi && (
        <Alert tone="info">
          {destination
            ? `초안을 쓰기 위해 ${source === "graph" ? "경험 그래프" : "진단의 재작성본"}${general ? "" : "와 공고 JD"}가 ${destination}(으)로 전송됩니다. `
            : "초안을 쓰기 위해 자료가 선택한 AI 엔진으로 전송됩니다. "}
          AI는 자료에 있는 사실만 쓰고, 모르는 내용은 <strong>[ADD: …]</strong> 자리표시로 남깁니다.
        </Alert>
      )}

      {error && (
        <Alert tone="error" title="이력서를 만들지 못했습니다">
          {error}
          {errorLink && (
            <>
              {" "}
              <Link href={errorLink.href} className="font-medium underline">
                {errorLink.label}
              </Link>
            </>
          )}
        </Alert>
      )}

      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
        {usesAi && (
          <p className="text-sm text-slate-500 sm:mr-auto">AI 초안은 보통 1~5분 걸립니다. 진행 화면을 떠나도 계속 쓰고, 끝나면 알림으로 알려 드립니다.</p>
        )}
        <Button type="submit" size="lg" loading={submitting} disabled={importing}>
          {submitting ? (usesAi ? "초안 시작하는 중…" : "만드는 중…") : general ? `공용 이력서 ${submitLabel}` : submitLabel}
        </Button>
      </div>
    </form>
  );
}
