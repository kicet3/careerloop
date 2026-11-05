"use client";
/**
 * 공고 직접 추가·수정 폼(메타·JD 원문). 수정은 바뀐 필드만 PATCH로 보낸다. 같은 URL의 공고가 이미 있으면(409) 그 공고 링크를 보여 준다.
 * 저장하면 서버가 JD를 제목 기준으로 바로 구역에 나눈다. AI 엔진이 있으면 'AI로 섹션 정리'(기본 켜짐)를 골라 저장 뒤
 * 부모가 POST /api/postings/[id]/structure를 부르게 한다(onSaved의 structure).
 */
import Link from "next/link";
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  CAREER_LEVEL_LABELS,
  CAREER_LEVELS,
  DEADLINE_KIND_LABELS,
  DEADLINE_KINDS,
  EMPLOYMENT_TYPE_LABELS,
  EMPLOYMENT_TYPES,
  POSTING_LIMITS,
  POSTING_STATUS_LABELS,
  POSTING_STATUSES,
  WORK_TYPE_LABELS,
  WORK_TYPES,
  postingDeadlineError,
  type JobPosting,
} from "@/lib/domain/postings";
import { inputClass, labelClass, readApiError, textareaClass, type ApiError } from "./shared";

type Fields = Pick<
  JobPosting,
  | "company"
  | "roleTitle"
  | "url"
  | "status"
  | "jdText"
  | "deadline"
  | "deadlineTime"
  | "deadlineKind"
  | "employmentType"
  | "workType"
  | "location"
  | "careerLevel"
  | "note"
>;

const EMPTY: Fields = {
  company: "",
  roleTitle: "",
  url: "",
  status: "saved",
  jdText: "",
  deadline: "",
  deadlineTime: "",
  deadlineKind: "unspecified",
  employmentType: "unknown",
  workType: "unknown",
  location: "",
  careerLevel: "unknown",
  note: "",
};

function pick(p: JobPosting): Fields {
  const out = { ...EMPTY };
  for (const k of Object.keys(EMPTY) as (keyof Fields)[]) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

export function PostingForm({
  posting,
  onSaved,
  onCancel,
  aiAvailable = false,
}: {
  /** 있으면 수정, 없으면 새 공고. */
  posting?: JobPosting;
  /** structure: 저장 뒤 AI로 구역을 정리할지(사용자가 고르고 JD가 새로 들어왔거나 바뀐 경우). */
  onSaved: (posting: JobPosting, opts: { structure: boolean }) => void;
  onCancel: () => void;
  /** AI 엔진을 쓸 수 있으면 'AI로 섹션 정리' 선택지를 보인다. */
  aiAvailable?: boolean;
}) {
  const initial = posting ? pick(posting) : EMPTY;
  const [v, setV] = useState<Fields>(initial);
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [aiStructure, setAiStructure] = useState(true);
  const jdTouched = v.jdText.trim() !== "" && v.jdText !== initial.jdText;
  const set = <K extends keyof Fields>(k: K, value: Fields[K]) => setV((prev) => ({ ...prev, [k]: value }));

  function setDeadline(deadline: string) {
    // 날짜를 넣으면 종류는 '마감일', 지우면 '마감일 미공개'(시각도 함께 지운다).
    setV((prev) => ({
      ...prev,
      deadline,
      deadlineKind: deadline ? "date" : prev.deadlineKind === "date" ? "unspecified" : prev.deadlineKind,
      deadlineTime: deadline ? prev.deadlineTime : "",
    }));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!v.company.trim() || !v.roleTitle.trim()) {
      setError({ error: "회사 이름과 직무를 입력하세요." });
      return;
    }
    const deadlineErr = postingDeadlineError(v);
    if (deadlineErr) {
      setError({ error: deadlineErr });
      return;
    }
    const body: Partial<Fields> = posting
      ? Object.fromEntries((Object.keys(v) as (keyof Fields)[]).filter((k) => v[k] !== initial[k]).map((k) => [k, v[k]]))
      : v;
    if (posting && Object.keys(body).length === 0) {
      onCancel();
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(posting ? `/api/postings/${posting.id}` : "/api/postings", {
        method: posting ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await readApiError(res, "공고를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요."));
        setSaving(false);
        return;
      }
      const data = (await res.json()) as { posting: JobPosting };
      onSaved(data.posting, { structure: aiAvailable && aiStructure && jdTouched });
    } catch {
      setError({ error: "서버에 연결하지 못했습니다. 네트워크를 확인해 주세요." });
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {error && (
        <Alert tone="error">
          {error.error}
          {error.existingId && (
            <>
              {" "}
              <Link href={`/app/postings/${error.existingId}`} className="font-medium underline">
                기존 공고 열기
              </Link>
            </>
          )}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pf-company" className={labelClass}>
            회사 <span className="text-red-600">*</span>
          </label>
          <input id="pf-company" className={inputClass} value={v.company} maxLength={POSTING_LIMITS.company} onChange={(e) => set("company", e.target.value)} />
        </div>
        <div>
          <label htmlFor="pf-role" className={labelClass}>
            직무 <span className="text-red-600">*</span>
          </label>
          <input id="pf-role" className={inputClass} value={v.roleTitle} maxLength={POSTING_LIMITS.roleTitle} onChange={(e) => set("roleTitle", e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pf-url" className={labelClass}>
            공고 주소
          </label>
          <input
            id="pf-url"
            type="url"
            inputMode="url"
            className={inputClass}
            value={v.url}
            maxLength={POSTING_LIMITS.url}
            placeholder="https://"
            onChange={(e) => set("url", e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="pf-status" className={labelClass}>
            상태
          </label>
          <select id="pf-status" className={inputClass} value={v.status} onChange={(e) => set("status", e.target.value as Fields["status"])}>
            {POSTING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {POSTING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pf-kind" className={labelClass}>
            마감 종류
          </label>
          <select
            id="pf-kind"
            className={inputClass}
            value={v.deadlineKind}
            onChange={(e) => {
              const kind = e.target.value as Fields["deadlineKind"];
              setV((prev) => ({ ...prev, deadlineKind: kind, ...(kind === "date" ? {} : { deadline: "", deadlineTime: "" }) }));
            }}
          >
            {DEADLINE_KINDS.map((k) => (
              <option key={k} value={k}>
                {DEADLINE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pf-deadline" className={labelClass}>
            마감일 <span className="font-normal text-slate-500">(한국 시간)</span>
          </label>
          <input id="pf-deadline" type="date" className={inputClass} value={v.deadline} onChange={(e) => setDeadline(e.target.value)} />
        </div>
        <div>
          <label htmlFor="pf-time" className={labelClass}>
            마감 시각 <span className="font-normal text-slate-500">(선택)</span>
          </label>
          <input
            id="pf-time"
            type="time"
            className={inputClass}
            value={v.deadlineTime}
            disabled={!v.deadline}
            onChange={(e) => set("deadlineTime", e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="pf-emp" className={labelClass}>
            고용 형태
          </label>
          <select id="pf-emp" className={inputClass} value={v.employmentType} onChange={(e) => set("employmentType", e.target.value as Fields["employmentType"])}>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {EMPLOYMENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pf-career" className={labelClass}>
            경력 조건
          </label>
          <select id="pf-career" className={inputClass} value={v.careerLevel} onChange={(e) => set("careerLevel", e.target.value as Fields["careerLevel"])}>
            {CAREER_LEVELS.map((t) => (
              <option key={t} value={t}>
                {CAREER_LEVEL_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pf-work" className={labelClass}>
            근무 형태
          </label>
          <select id="pf-work" className={inputClass} value={v.workType} onChange={(e) => set("workType", e.target.value as Fields["workType"])}>
            {WORK_TYPES.map((t) => (
              <option key={t} value={t}>
                {WORK_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="pf-location" className={labelClass}>
            근무지
          </label>
          <input id="pf-location" className={inputClass} value={v.location} maxLength={POSTING_LIMITS.location} onChange={(e) => set("location", e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pf-note" className={labelClass}>
            메모
          </label>
          <textarea
            id="pf-note"
            rows={4}
            className={textareaClass}
            value={v.note}
            maxLength={POSTING_LIMITS.note}
            placeholder="지원 이유, 확인할 조건, 추천인 등"
            onChange={(e) => set("note", e.target.value)}
          />
        </div>
        <div className="sm:col-span-2">
          <label htmlFor="pf-jd" className={labelClass}>
            JD 원문
          </label>
          <textarea
            id="pf-jd"
            rows={8}
            className={textareaClass}
            value={v.jdText}
            maxLength={POSTING_LIMITS.jdText}
            placeholder="주요 업무·자격 요건·우대 사항을 붙여넣으면 진단과 경력 대조에 씁니다."
            onChange={(e) => set("jdText", e.target.value)}
          />
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            {aiAvailable && jdTouched ? (
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={aiStructure}
                  onChange={(e) => setAiStructure(e.target.checked)}
                  className="size-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                저장 뒤 AI로 섹션 정리
              </label>
            ) : (
              <span className="text-xs text-slate-500">저장하면 제목(자격 요건·우대 사항 등) 기준으로 구역을 나눠 보여 줍니다.</span>
            )}
            <p className="ml-auto text-xs text-slate-500">
              {v.jdText.length.toLocaleString("ko-KR")} / {POSTING_LIMITS.jdText.toLocaleString("ko-KR")}자
            </p>
          </div>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          취소
        </Button>
        <Button type="submit" loading={saving}>
          {posting ? "저장" : "공고 추가"}
        </Button>
      </div>
    </form>
  );
}
