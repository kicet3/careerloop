"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/components/app/stages";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { NO_ENGINE_MESSAGE, PROVIDER_DATA_DESTINATION, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { DEFAULT_RESUME_TEMPLATE, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, type ResumeTemplateId } from "@/lib/domain/resumes";
import { saveDraftNotes } from "@/lib/resumes/prefill";
import {
  MAX_RESUME_JD_CHARS,
  MAX_RESUME_META_CHARS,
  RESUME_DRAFT_SOURCE_KINDS,
  RESUME_DRAFT_SOURCE_LABELS,
  type CreateResumeResponse,
  type ResumeDraftSourceKind,
} from "@/lib/resumes/types";
import { inputClass, textareaClass } from "./styles";

export interface RewriteOption {
  id: string;
  title: string;
  targetRole: string;
  createdAt: number;
}

export function NewResumeForm({
  providers,
  defaultProvider,
  graphAvailable,
  diagnoses,
  posting = null,
}: {
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
  graphAvailable: boolean;
  diagnoses: RewriteOption[];
  /** 공고 보관함의 "이 공고용 이력서"에서 왔으면 그 공고(회사·직무·JD를 채우고 이력서를 공고에 연결한다). */
  posting?: { id: string; company: string; roleTitle: string; jdText: string } | null;
}) {
  const router = useRouter();
  const [company, setCompany] = useState(posting?.company ?? "");
  const [roleTitle, setRoleTitle] = useState(posting?.roleTitle ?? "");
  const [jdText, setJdText] = useState(posting?.jdText ?? "");
  const [templateId, setTemplateId] = useState<ResumeTemplateId>(DEFAULT_RESUME_TEMPLATE);
  const [source, setSource] = useState<ResumeDraftSourceKind>(graphAvailable ? "graph" : diagnoses.length ? "diagnosis" : "blank");
  const [diagnosisId, setDiagnosisId] = useState(diagnoses[0]?.id ?? "");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const usesAi = source !== "blank";
  const selectedProvider = providers.find((p) => p.id === provider);
  const destination = provider ? PROVIDER_DATA_DESTINATION[provider] : null;
  const sourceDisabled = (k: ResumeDraftSourceKind) =>
    k === "graph" ? !graphAvailable : k === "diagnosis" ? diagnoses.length === 0 : false;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!company.trim() || !roleTitle.trim()) {
      setError("회사명과 직무를 입력해 주세요.");
      return;
    }
    if (source === "diagnosis" && !diagnosisId) {
      setError("재작성본을 가져올 진단을 골라 주세요.");
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
        body: JSON.stringify({
          company: company.trim(),
          roleTitle: roleTitle.trim(),
          jdText,
          templateId,
          source: source === "diagnosis" ? { kind: "diagnosis", diagnosisId } : { kind: source },
          provider: usesAi ? provider : null,
          postingId: posting?.id ?? null,
        }),
      });
      const data = (await res.json().catch(() => null)) as (Partial<CreateResumeResponse> & { error?: string }) | null;
      if (res.status === 401) {
        router.push("/login?next=/app/resumes/new");
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

  // 넓은 화면(xl~)은 지원할 자리·양식 카드를 2열로, 나머지는 전체 폭. data-half 카드만 반 칸.
  return (
    <form onSubmit={onSubmit} className="grid gap-6 xl:grid-cols-2 xl:items-start [&>*]:col-span-full xl:[&>[data-half]]:col-span-1" noValidate>
      <Card data-half className="p-5 sm:p-6">
        <h2 className="text-base font-semibold text-slate-900">지원할 자리</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="company" className="block text-sm font-medium text-slate-800">
              회사명 <span className="text-red-600">*</span>
            </label>
            <input
              id="company"
              value={company}
              maxLength={MAX_RESUME_META_CHARS}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="예: 페이랩"
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="roleTitle" className="block text-sm font-medium text-slate-800">
              직무 <span className="text-red-600">*</span>
            </label>
            <input
              id="roleTitle"
              value={roleTitle}
              maxLength={MAX_RESUME_META_CHARS}
              onChange={(e) => setRoleTitle(e.target.value)}
              placeholder="예: 백엔드 개발자"
              className={inputClass}
            />
          </div>
        </div>
        <div className="mt-4">
          <label htmlFor="jdText" className="block text-sm font-medium text-slate-800">
            채용 공고(JD) <span className="font-normal text-slate-400">(선택)</span>
          </label>
          <textarea
            id="jdText"
            value={jdText}
            maxLength={MAX_RESUME_JD_CHARS}
            onChange={(e) => setJdText(e.target.value)}
            rows={6}
            placeholder="공고 본문을 붙여넣으면 AI 초안이 공고의 요건에 맞춰 내용을 고르고 순서를 정합니다."
            className={textareaClass}
          />
        </div>
      </Card>

      <Card data-half className="p-5 sm:p-6">
        <fieldset>
          <legend className="text-base font-semibold text-slate-900">양식</legend>
          <p className="mt-1 text-sm text-slate-500">편집 화면에서 언제든 바꿀 수 있습니다.</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {RESUME_TEMPLATE_IDS.map((id) => {
              const t = RESUME_TEMPLATES[id];
              return (
                <label
                  key={id}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60"
                >
                  <input
                    type="radio"
                    name="template"
                    value={id}
                    checked={templateId === id}
                    onChange={() => setTemplateId(id)}
                    className="mt-1 accent-indigo-600"
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-2 text-sm font-medium text-slate-900">
                      <span aria-hidden className="inline-block size-2.5 rounded-full" style={{ backgroundColor: t.style.accent }} />
                      {t.name}
                    </span>
                    <span className="block text-xs text-slate-500">{t.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      </Card>

      <Card className="p-5 sm:p-6">
        <fieldset>
          <legend className="text-base font-semibold text-slate-900">초안 출처</legend>
          <div className="mt-4 grid gap-2">
            {RESUME_DRAFT_SOURCE_KINDS.map((k) => {
              const disabled = sourceDisabled(k);
              const hint =
                k === "graph" && !graphAvailable
                  ? "경력 그래프 저장소가 설정되지 않아 쓸 수 없습니다."
                  : k === "diagnosis" && diagnoses.length === 0
                    ? "다시 쓴 이력서가 있는 진단이 아직 없습니다."
                    : RESUME_DRAFT_SOURCE_LABELS[k].description;
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
                    <span className="block text-sm font-medium text-slate-900">{RESUME_DRAFT_SOURCE_LABELS[k].name}</span>
                    <span className="block text-xs text-slate-500">{hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
          {source === "graph" && (
            <p className="mt-3 text-sm text-slate-500">
              그래프가 비어 있다면{" "}
              <Link href="/app/graph" className="font-medium text-indigo-700 hover:underline">
                경력 그래프
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
            ? `초안을 쓰기 위해 ${source === "graph" ? "경력 그래프" : "진단의 재작성본"}와 JD가 ${destination}(으)로 전송됩니다. `
            : "초안을 쓰기 위해 자료가 선택한 AI 엔진으로 전송됩니다. "}
          AI는 자료에 있는 사실만 쓰고, 모르는 내용은 <strong>[ADD: …]</strong> 자리표시로 남깁니다.
        </Alert>
      )}

      {error && (
        <Alert tone="error" title="이력서를 만들지 못했습니다">
          {error}
        </Alert>
      )}

      <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
        {usesAi && <p className="text-sm text-slate-500 sm:mr-auto">AI 초안은 보통 30초~2분 걸립니다.</p>}
        <Button type="submit" size="lg" loading={submitting}>
          {submitting ? (usesAi ? "초안 쓰는 중…" : "만드는 중…") : usesAi ? "초안 만들기" : "빈 문서로 만들기"}
        </Button>
      </div>
    </form>
  );
}
