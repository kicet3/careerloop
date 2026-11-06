"use client";

/**
 * 새 면접 연습: 이력서 하나를 고르고(공용 이력서도 가능), 첨부 포트폴리오·연결 공고를 근거에 넣을지 정한다.
 * 만들면 질문 생성은 서버가 백그라운드로 하고, 세션 화면으로 옮겨 진행 상황을 보여 준다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/resumes/styles";
import { createSession, InterviewApiError } from "./api";

export interface InterviewResumeOption {
  id: string;
  title: string;
  kind: "company" | "general";
  company: string;
  roleTitle: string;
  postingId: string | null;
  hasJd: boolean;
  portfolioLabel: string | null;
  /** 파일 포트폴리오나 설명을 적은 포트폴리오만 근거로 쓴다(링크는 AI가 열어 보지 못한다). */
  portfolioReadable: boolean;
  versionNo: number | null;
}

export function NewInterviewForm({ resumes, initialResumeId }: { resumes: InterviewResumeOption[]; initialResumeId?: string | null }) {
  const router = useRouter();
  const ids = { resume: useId(), title: useId() };
  const first = resumes.find((r) => r.id === initialResumeId) ?? resumes[0] ?? null;
  const [resumeId, setResumeId] = useState(first?.id ?? "");
  const [includePortfolio, setIncludePortfolio] = useState(true);
  const [usePosting, setUsePosting] = useState(true);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = useMemo(() => resumes.find((r) => r.id === resumeId) ?? null, [resumes, resumeId]);
  const companies = resumes.filter((r) => r.kind === "company");
  const generals = resumes.filter((r) => r.kind === "general");
  const hasTarget = !!selected && (!!selected.postingId || selected.hasJd);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { session } = await createSession({
        resumeId: selected.id,
        includePortfolio,
        // 생략하면 연결 공고, null이면 공고 없이(직무 일반 질문).
        ...(hasTarget && !usePosting ? { postingId: null } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      router.push(`/app/interview/${session.id}`);
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "면접 연습을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.");
      setBusy(false);
    }
  }

  if (resumes.length === 0) {
    return (
      <p className="text-sm text-slate-600">
        먼저 이력서를 만들어 주세요. 면접 질문은 이력서의 문장을 근거로 만듭니다.{" "}
        <Link href="/app/resumes/new" className="font-medium text-indigo-700 hover:underline">
          이력서 만들기
        </Link>
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor={ids.resume} className="block text-sm font-medium text-slate-800">
          이력서
        </label>
        <select id={ids.resume} className={`${inputClass} mt-1`} value={resumeId} onChange={(e) => setResumeId(e.target.value)}>
          {companies.length > 0 && (
            <optgroup label="지원처별 이력서">
              {companies.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {r.versionNo ? ` (v${r.versionNo})` : ""}
                </option>
              ))}
            </optgroup>
          )}
          {generals.length > 0 && (
            <optgroup label="공용 이력서">
              {generals.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title}
                  {r.versionNo ? ` (v${r.versionNo})` : ""}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {selected && (
          <p className="mt-1 text-xs text-slate-500">
            {selected.kind === "general" ? "공용 이력서 · 회사 지정 없음" : [selected.company, selected.roleTitle].filter(Boolean).join(" · ")} · 현재 버전으로
            질문을 만듭니다.
          </p>
        )}
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-800">근거에 넣을 자료</legend>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" checked disabled className="mt-0.5" /> 이력서 본문(항상)
        </label>
        <label className={`flex items-start gap-2 text-sm ${selected?.portfolioReadable ? "text-slate-700" : "text-slate-400"}`}>
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={!selected?.portfolioReadable}
            checked={!!selected?.portfolioReadable && includePortfolio}
            onChange={(e) => setIncludePortfolio(e.target.checked)}
          />
          <span>
            첨부 포트폴리오
            {!selected?.portfolioLabel ? (
              " · 이 이력서에 첨부한 포트폴리오가 없습니다"
            ) : selected.portfolioReadable ? (
              <span className="text-slate-500"> · {selected.portfolioLabel}</span>
            ) : (
              " · 링크는 내용을 읽지 못해 질문에 반영되지 않습니다(파일로 올리거나 포트폴리오 설명을 적으면 근거로 씁니다)"
            )}
          </span>
        </label>
        <label className={`flex items-start gap-2 text-sm ${hasTarget ? "text-slate-700" : "text-slate-400"}`}>
          <input type="checkbox" className="mt-0.5" disabled={!hasTarget} checked={hasTarget && usePosting} onChange={(e) => setUsePosting(e.target.checked)} />
          <span>
            {selected?.postingId ? "연결된 채용 공고" : "이력서에 붙여 둔 공고(JD)"}
            {!hasTarget && " · 연결된 공고가 없어 직무 일반 질문을 함께 만듭니다"}
          </span>
        </label>
      </fieldset>

      <div>
        <label htmlFor={ids.title} className="block text-sm font-medium text-slate-800">
          제목 <span className="font-normal text-slate-500">(선택)</span>
        </label>
        <input
          id={ids.title}
          className={`${inputClass} mt-1`}
          maxLength={120}
          value={title}
          placeholder={selected ? `${selected.title} 면접 연습` : ""}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={busy} disabled={!selected}>
          예상 질문 만들기
        </Button>
        <p className="text-xs text-slate-500">AI가 서류를 읽고 질문을 만드는 데 1~3분 걸립니다. 하루 10번까지 만들 수 있습니다.</p>
      </div>
    </form>
  );
}
