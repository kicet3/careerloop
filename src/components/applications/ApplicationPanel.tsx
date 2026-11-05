"use client";

/**
 * 지원 기록 오른쪽 패널: 새 지원 폼, 또는 기존 지원의 수정·단계 변경·단계 이력·제출본·삭제.
 * 수정은 바뀐 칸만 PATCH로 보낸다(원본 이력서를 지워 버전만 남은 지원도 다른 칸을 고칠 수 있게).
 */
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { inputClass, labelClass, textareaClass } from "@/components/resumes/styles";
import type { ApplicationFormOptions } from "@/lib/applications/options";
import {
  APPLICATION_LIMITS,
  APPLICATION_STAGE_LABELS,
  APPLICATION_STAGES,
  type ApplicationDetail,
  type ApplicationStage,
  type JobApplication,
} from "@/lib/domain/applications";
import { POSTING_STATUS_LABELS } from "@/lib/domain/postings";
import { formatKstDate, kstDate } from "@/lib/time/kst";
import { STAGE_TONE } from "./stage-style";

export type PanelTarget = { mode: "new"; postingId: string | null } | { mode: "edit"; id: string };

interface FormState {
  postingId: string;
  company: string;
  roleTitle: string;
  stage: ApplicationStage;
  appliedAt: string;
  nextStep: string;
  nextDate: string;
  note: string;
  favorite: boolean;
  resumeId: string;
  resumeVersionId: string;
  diagnosisId: string;
}

interface VersionOption {
  id: string;
  versionNo: number;
  note: string | null;
  createdAt: number;
}

const EMPTY: FormState = {
  postingId: "",
  company: "",
  roleTitle: "",
  stage: "applied",
  appliedAt: "",
  nextStep: "",
  nextDate: "",
  note: "",
  favorite: false,
  resumeId: "",
  resumeVersionId: "",
  diagnosisId: "",
};

function fromApplication(a: JobApplication): FormState {
  return {
    postingId: a.postingId ?? "",
    company: a.company,
    roleTitle: a.roleTitle,
    stage: a.stage,
    appliedAt: a.appliedAt ?? "",
    nextStep: a.nextStep,
    nextDate: a.nextDate ?? "",
    note: a.note,
    favorite: a.favorite,
    resumeId: a.resumeId ?? "",
    resumeVersionId: a.resumeVersionId ?? "",
    diagnosisId: a.diagnosisId ?? "",
  };
}

/** 폼 값 → API 값(빈 문자열은 null). */
function toPayload(f: FormState) {
  return {
    postingId: f.postingId || null,
    company: f.company.trim(),
    roleTitle: f.roleTitle.trim(),
    appliedAt: f.appliedAt || null,
    nextStep: f.nextStep.trim(),
    nextDate: f.nextDate || null,
    note: f.note,
    favorite: f.favorite,
    resumeId: f.resumeId || null,
    resumeVersionId: f.resumeId ? f.resumeVersionId || null : null,
    diagnosisId: f.diagnosisId || null,
  };
}

const stripEvents = ({ events: _events, ...a }: ApplicationDetail): JobApplication => (void _events, a);

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

export function ApplicationPanel({
  target,
  options,
  onClose,
  onSaved,
  onDeleted,
}: {
  target: PanelTarget;
  options: ApplicationFormOptions;
  onClose: () => void;
  onSaved: (a: JobApplication) => void;
  onDeleted: (id: string) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const editId = target.mode === "edit" ? target.id : null;

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    if (!editId) return;
    let alive = true;
    fetch(`/api/applications/${editId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(await readError(res, "지원 기록을 불러오지 못했습니다."));
        return (await res.json()) as { application: ApplicationDetail };
      })
      .then((d) => alive && setDetail(d.application))
      .catch((err) => alive && setLoadError(err instanceof Error ? err.message : "지원 기록을 불러오지 못했습니다."));
    return () => {
      alive = false;
    };
  }, [editId]);

  const saved = useCallback(
    (d: ApplicationDetail) => {
      setDetail(d);
      onSaved(stripEvents(d));
    },
    [onSaved],
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-slate-900/40" aria-hidden onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-dvh w-full flex-col bg-white shadow-xl focus:outline-none sm:max-w-lg sm:border-l sm:border-slate-200"
      >
        <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate font-semibold text-slate-900">
              {target.mode === "new" ? "지원 기록 추가" : detail ? `${detail.company} · ${detail.roleTitle}` : "지원 기록"}
            </h2>
            {detail && (
              <p className="mt-1">
                <Badge tone={STAGE_TONE[detail.stage]}>{APPLICATION_STAGE_LABELS[detail.stage]}</Badge>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="닫기"
            className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <span aria-hidden className="text-lg leading-none">
              ×
            </span>
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {target.mode === "new" ? (
            <ApplicationForm
              key="new"
              initial={{ ...EMPTY, postingId: target.postingId && options.postings.some((p) => p.id === target.postingId) ? target.postingId : "" }}
              options={options}
              existing={null}
              onSaved={(d) => {
                onSaved(stripEvents(d));
                onClose();
              }}
            />
          ) : loadError ? (
            <Alert tone="error">{loadError}</Alert>
          ) : !detail ? (
            <div className="flex justify-center py-12">
              <Spinner label="불러오는 중" />
            </div>
          ) : (
            <div className="space-y-6">
              <StageSection detail={detail} onSaved={saved} />
              <SubmittedSection detail={detail} />
              {/* 저장·단계 변경 뒤(제출본 고정으로 버전이 바뀔 수 있다) 폼을 서버 값으로 다시 맞춘다. */}
              <ApplicationForm key={`${detail.id}-${detail.updatedAt}`} initial={fromApplication(detail)} options={options} existing={detail} onSaved={saved} />
              <EventTimeline detail={detail} />
              <DeleteSection
                detail={detail}
                onDeleted={() => {
                  onDeleted(detail.id);
                  onClose();
                }}
              />
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// 폼(추가·수정 공용)
// ---------------------------------------------------------------------------

function ApplicationForm({
  initial,
  options,
  existing,
  onSaved,
}: {
  initial: FormState;
  options: ApplicationFormOptions;
  existing: ApplicationDetail | null;
  onSaved: (d: ApplicationDetail) => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [versions, setVersions] = useState<VersionOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));
  const posting = options.postings.find((p) => p.id === form.postingId) ?? null;
  // 원본 이력서가 지워졌으면 목록에 없다 — 제출본 이름만 보여 준다.
  const resumeMissing = !!existing && !existing.resumeId && !!existing.resumeLabel;

  useEffect(() => {
    if (!form.resumeId) return;
    let alive = true;
    fetch(`/api/resumes/${form.resumeId}/versions`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ versions: VersionOption[] }>) : { versions: [] }))
      .then((d) => alive && setVersions(d.versions))
      .catch(() => alive && setVersions([]));
    return () => {
      alive = false;
    };
  }, [form.resumeId]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSavedAt(null);
    if (!form.postingId && (!form.company.trim() || !form.roleTitle.trim())) {
      setError("공고를 고르거나 회사와 직무를 입력하세요.");
      return;
    }
    const payload = toPayload(form);
    let body: Record<string, unknown>;
    if (existing) {
      // 바뀐 칸만 보낸다.
      const before = toPayload(fromApplication(existing));
      body = Object.fromEntries(Object.entries(payload).filter(([k, v]) => before[k as keyof typeof before] !== v));
      // 원본 이력서가 지워진 지원: 버전 칸은 이력서를 새로 골랐을 때만 보낸다.
      if (!payload.resumeId && !("resumeId" in body)) delete body.resumeVersionId;
      if (Object.keys(body).length === 0) {
        setSavedAt(Date.now());
        return;
      }
    } else {
      body = { ...payload, stage: form.stage };
    }
    setSubmitting(true);
    try {
      const res = await fetch(existing ? `/api/applications/${existing.id}` : "/api/applications", {
        method: existing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(await readError(res, "저장하지 못했습니다."));
      const { application } = (await res.json()) as { application: ApplicationDetail };
      setSavedAt(Date.now());
      onSaved(application);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <h3 className="text-sm font-semibold text-slate-900">{existing ? "지원 정보" : "어디에 지원했나요?"}</h3>
      <label className="block">
        <span className={labelClass}>보관한 공고</span>
        <select
          value={form.postingId}
          onChange={(e) => set("postingId", e.target.value)}
          className={inputClass}
        >
          <option value="">공고 없이 직접 입력</option>
          {options.postings.map((p) => (
            <option key={p.id} value={p.id}>
              {p.company} · {p.roleTitle} ({POSTING_STATUS_LABELS[p.status]})
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={labelClass}>회사{posting && " (비우면 공고 값)"}</span>
          <input
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
            maxLength={APPLICATION_LIMITS.company}
            placeholder={posting?.company ?? "예: 페이랩"}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className={labelClass}>직무{posting && " (비우면 공고 값)"}</span>
          <input
            value={form.roleTitle}
            onChange={(e) => set("roleTitle", e.target.value)}
            maxLength={APPLICATION_LIMITS.roleTitle}
            placeholder={posting?.roleTitle ?? "예: 백엔드 엔지니어"}
            className={inputClass}
          />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {!existing && (
          <label className="block">
            <span className={labelClass}>단계</span>
            <select value={form.stage} onChange={(e) => set("stage", e.target.value as ApplicationStage)} className={inputClass}>
              {APPLICATION_STAGES.map((s) => (
                <option key={s} value={s}>
                  {APPLICATION_STAGE_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className={labelClass}>지원일(비우면 지원 완료 시 오늘)</span>
          <input type="date" value={form.appliedAt} onChange={(e) => set("appliedAt", e.target.value)} className={inputClass} />
        </label>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className={labelClass}>다음 일정</span>
          <input
            value={form.nextStep}
            onChange={(e) => set("nextStep", e.target.value)}
            maxLength={APPLICATION_LIMITS.nextStep}
            placeholder="예: 1차 면접, 과제 제출"
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className={labelClass}>날짜</span>
          <input type="date" value={form.nextDate} onChange={(e) => set("nextDate", e.target.value)} className={inputClass} />
        </label>
      </div>

      <fieldset className="space-y-3 rounded-lg border border-slate-200 p-3">
        <legend className="px-1 text-xs font-medium text-slate-600">낸 이력서</legend>
        {resumeMissing && !form.resumeId && (
          <p className="text-sm text-slate-600">
            <Badge tone="accent">{existing.resumeLabel}</Badge> <span className="text-xs text-slate-500">원본 이력서는 지워졌고 제출본만 남아 있습니다.</span>
          </p>
        )}
        <label className="block">
          <span className={labelClass}>이력서</span>
          <select
            value={form.resumeId}
            onChange={(e) => {
              setVersions(null);
              setForm((f) => ({ ...f, resumeId: e.target.value, resumeVersionId: "" }));
            }}
            className={inputClass}
          >
            <option value="">{resumeMissing ? "그대로 두기" : "기록하지 않음"}</option>
            {options.resumes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
                {r.currentVersionNo ? ` (현재 v${r.currentVersionNo})` : ""}
              </option>
            ))}
          </select>
        </label>
        {form.resumeId && (
          <label className="block">
            <span className={labelClass}>버전</span>
            <select
              value={form.resumeVersionId}
              onChange={(e) => set("resumeVersionId", e.target.value)}
              disabled={versions === null}
              className={inputClass}
            >
              <option value="">지원 완료 시점의 현재 버전</option>
              {(versions ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNo}
                  {v.note ? ` · ${v.note}` : ""}
                </option>
              ))}
            </select>
            <span className="mt-1 block text-xs text-slate-500">버전을 고르거나 지원 완료로 바꾸면 그 본문을 제출본으로 고정합니다. 이력서를 나중에 고쳐도 제출본은 그대로입니다.</span>
          </label>
        )}
      </fieldset>

      <label className="block">
        <span className={labelClass}>참고한 진단(선택)</span>
        <select value={form.diagnosisId} onChange={(e) => set("diagnosisId", e.target.value)} className={inputClass}>
          <option value="">연결하지 않음</option>
          {options.diagnoses.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
              {d.matchScore !== null ? ` · 적합도 ${d.matchScore}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={labelClass}>메모</span>
        <textarea
          value={form.note}
          onChange={(e) => set("note", e.target.value)}
          maxLength={APPLICATION_LIMITS.note}
          rows={3}
          className={textareaClass}
        />
      </label>
      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input type="checkbox" checked={form.favorite} onChange={(e) => set("favorite", e.target.checked)} className="size-4 rounded border-slate-300 text-indigo-600" />
        즐겨찾기(보드 맨 위에 보이기)
      </label>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex items-center gap-3">
        <Button type="submit" loading={submitting}>
          {existing ? "저장" : "추가"}
        </Button>
        {savedAt && existing && !submitting && <span className="text-sm text-emerald-700">저장했습니다.</span>}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// 단계·제출본·이력·삭제
// ---------------------------------------------------------------------------

function StageSection({ detail, onSaved }: { detail: ApplicationDetail; onSaved: (d: ApplicationDetail) => void }) {
  const [stage, setStage] = useState<ApplicationStage>(detail.stage);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${detail.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage, note }),
      });
      if (!res.ok) throw new Error(await readError(res, "단계를 바꾸지 못했습니다."));
      const { application } = (await res.json()) as { application: ApplicationDetail };
      setNote("");
      onSaved(application);
    } catch (err) {
      setError(err instanceof Error ? err.message : "단계를 바꾸지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-2 rounded-lg bg-slate-50 p-3">
      <h3 className="text-sm font-semibold text-slate-900">단계 바꾸기</h3>
      <div className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 basis-32">
          <span className="sr-only">새 단계</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as ApplicationStage)} className={`${inputClass} mt-0`}>
            {APPLICATION_STAGES.map((s) => (
              <option key={s} value={s}>
                {APPLICATION_STAGE_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 flex-[2] basis-40">
          <span className="sr-only">메모</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={APPLICATION_LIMITS.eventNote}
            placeholder="메모(선택): 예) 1차 면접 통과"
            className={`${inputClass} mt-0`}
          />
        </label>
      </div>
      {error && <p className="text-sm text-red-700">{error}</p>}
      <Button size="sm" onClick={submit} loading={busy} disabled={stage === detail.stage}>
        {stage === detail.stage ? "지금 단계" : `${APPLICATION_STAGE_LABELS[stage]}(으)로 바꾸기`}
      </Button>
    </section>
  );
}

function SubmittedSection({ detail }: { detail: ApplicationDetail }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold text-slate-900">제출본</h3>
      {detail.hasSubmittedCopy ? (
        <div className="flex flex-wrap items-center gap-2">
          {detail.resumeLabel && <Badge tone="accent">{detail.resumeLabel}</Badge>}
          <a href={`/api/applications/${detail.id}/submitted/pdf`} target="_blank" rel="noopener" className={buttonClass("secondary", "sm")}>
            제출본 PDF
          </a>
          {detail.resumeId && (
            <Link href={`/app/resumes/${detail.resumeId}`} className="text-sm text-indigo-700 hover:underline">
              원본 이력서
            </Link>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-500">
          {detail.resumeId ? "지원 완료로 바꾸거나 버전을 고르면 그때의 이력서를 고정합니다." : "낸 이력서를 고르면 제출본을 고정해 둡니다."}
        </p>
      )}
      {detail.postingId && (
        <Link href={`/app/postings/${detail.postingId}`} className="inline-block text-sm text-indigo-700 hover:underline">
          연결된 공고 보기
        </Link>
      )}
    </section>
  );
}

function EventTimeline({ detail }: { detail: ApplicationDetail }) {
  const events = [...detail.events].reverse();
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-900">단계 이력</h3>
      <ol className="mt-2 space-y-2 border-l border-slate-200 pl-4">
        {events.map((e) => (
          <li key={e.id} className="relative text-sm">
            <span aria-hidden className="absolute top-1.5 -left-[1.3rem] size-2 rounded-full bg-slate-300" />
            <p className="text-slate-800">
              {e.fromStage ? (
                <>
                  {APPLICATION_STAGE_LABELS[e.fromStage]} → <strong>{APPLICATION_STAGE_LABELS[e.toStage]}</strong>
                </>
              ) : (
                <>
                  <strong>{APPLICATION_STAGE_LABELS[e.toStage]}</strong>(으)로 기록
                </>
              )}
            </p>
            <p className="text-xs text-slate-500">
              <time dateTime={new Date(e.at).toISOString()}>{formatKstDate(kstDate(e.at), { withYear: true })}</time>
              {e.note && ` · ${e.note}`}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function DeleteSection({ detail, onDeleted }: { detail: ApplicationDetail; onDeleted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function remove() {
    if (!window.confirm(`${detail.company} 지원 기록을 지울까요? 단계 이력과 제출본도 함께 지워집니다.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${detail.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(await readError(res, "지우지 못했습니다."));
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "지우지 못했습니다.");
      setBusy(false);
    }
  }
  return (
    <section className="border-t border-slate-200 pt-4">
      {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
      <Button variant="danger" size="sm" onClick={remove} loading={busy}>
        지원 기록 삭제
      </Button>
    </section>
  );
}
