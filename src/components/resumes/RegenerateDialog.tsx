"use client";

/**
 * '다시 생성' 대화 상자: 이미 만든 이력서를 AI로 다시 쓴다(결과는 이 이력서의 새 버전 — 새 이력서가 아니다).
 * 방식(AI 에이전트 — 심사위원 검토 / 빠른 초안), JD 그대로 또는 고쳐 쓰기, 양식, 강조할 점을 고른다.
 * 저장하지 않은 변경(임시 저장본)이 있으면 먼저 새 버전으로 저장할지 묻는다 — 다시 생성은 작업본을 지우지 않고,
 * 새 버전이 저장되면 편집 화면이 기준 버전이 바뀌었다고 알린다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, type ResumeKind, type ResumeTemplateId } from "@/lib/domain/resumes";
import {
  MAX_RESUME_EMPHASIS_CHARS,
  MAX_RESUME_JD_CHARS,
  type RegenerateResumeRequest,
  type RegenerateResumeResponse,
} from "@/lib/resumes/types";
import { inputClass, textareaClass } from "./styles";

type Mode = "agent" | "single";

/** 보낼 본문(순수 — 테스트에서 직접 부른다). JD는 고쳐 쓰기를 골랐을 때만, 양식은 바꿨을 때만 보낸다. */
export function regenerateRequestBody(form: {
  mode: Mode;
  kind: ResumeKind;
  editJd: boolean;
  jdText: string;
  templateId: ResumeTemplateId;
  currentTemplateId: ResumeTemplateId;
  note: string;
}): RegenerateResumeRequest {
  return {
    mode: form.mode,
    ...(form.kind === "company" && form.editJd ? { jdText: form.jdText } : {}),
    ...(form.templateId !== form.currentTemplateId ? { templateId: form.templateId } : {}),
    note: form.note.trim(),
  };
}

export function RegenerateDialog({
  open,
  onClose,
  resumeId,
  kind,
  jdText,
  templateId,
  agentAvailable,
  hasUnsavedWork,
  onSaveFirst,
}: {
  open: boolean;
  onClose: () => void;
  resumeId: string;
  kind: ResumeKind;
  jdText: string;
  /** 지금 이력서(저장된) 양식. */
  templateId: ResumeTemplateId;
  agentAvailable: boolean;
  /** 새 버전으로 저장하지 않은 변경(임시 저장본 포함)이 있다. */
  hasUnsavedWork: boolean;
  /** 지금 내용을 새 버전으로 저장한다(성공하면 true). */
  onSaveFirst: () => Promise<boolean>;
}) {
  const router = useRouter();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<Mode>(agentAvailable ? "agent" : "single");
  const [editJd, setEditJd] = useState(false);
  const [jd, setJd] = useState(jdText);
  const [template, setTemplate] = useState<ResumeTemplateId>(templateId);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"save" | "start" | null>(null);
  const [error, setError] = useState<{ message: string; href?: string } | null>(null);
  const isCompany = kind === "company";

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      // 열 때마다 지금 이력서 값으로 맞춘다.
      setJd(jdText);
      setTemplate(templateId);
      setError(null);
      d.showModal();
    }
    if (!open && d.open) d.close();
  }, [open, jdText, templateId]);

  async function saveFirst() {
    setBusy("save");
    setError(null);
    try {
      const ok = await onSaveFirst();
      if (!ok) setError({ message: "새 버전으로 저장하지 못했습니다. 편집 화면의 안내를 확인해 주세요." });
    } finally {
      setBusy(null);
    }
  }

  async function start() {
    setBusy("start");
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${encodeURIComponent(resumeId)}/regenerate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regenerateRequestBody({ mode, kind, editJd, jdText: jd, templateId: template, currentTemplateId: templateId, note })),
      });
      const data = (await res.json().catch(() => null)) as (Partial<RegenerateResumeResponse> & { error?: string; jobHref?: string; agentJobId?: string }) | null;
      if (res.status === 202 && data?.href) {
        router.push(data.modeFallback === "agent_unavailable" ? `${data.href}?fallback=agent` : data.href);
        return;
      }
      const href = data?.jobHref ?? (data?.agentJobId ? "/app/resumes" : undefined); // 동시 작업 상한: 진행 중인 작업이 모두 보이는 목록으로
      setError({ message: data?.error ?? "다시 생성을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.", href });
    } catch {
      setError({ message: "서버에 연결하지 못했습니다. 네트워크를 확인해 주세요." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-auto w-[min(36rem,calc(100vw-2rem))] rounded-xl border border-slate-200 p-0 shadow-xl backdrop:bg-slate-900/40"
    >
      <div className="max-h-[85vh] space-y-4 overflow-y-auto p-5 text-sm text-slate-700">
        <div>
          <h2 id={titleId} className="text-base font-semibold text-slate-900">
            이력서 다시 생성
          </h2>
          <p className="mt-1 text-slate-600">
            경험 그래프로 이 이력서를 다시 씁니다. 결과는 <strong>이 이력서의 새 버전</strong>으로 저장되고, 이전 버전은 버전 목록에 그대로 남습니다. 지원 동기·이름·연락처·링크와
            사진 넣기 설정은 지금 값을 그대로 둡니다.
          </p>
        </div>

        {hasUnsavedWork && (
          <Alert tone="warning" title="새 버전으로 저장하지 않은 변경이 있습니다">
            <p>다시 생성은 임시 저장본을 지우지 않습니다. 새 버전이 저장되면 편집 화면이 &lsquo;기준 버전이 바뀌었다&rsquo;고 알려 주고, 작업본을 유지할지 고를 수 있습니다.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="secondary" loading={busy === "save"} disabled={busy !== null} onClick={() => void saveFirst()}>
                먼저 새 버전으로 저장
              </Button>
            </div>
          </Alert>
        )}

        <fieldset className="space-y-2">
          <legend className="font-medium text-slate-900">작성 방식</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="regen-mode" value="agent" checked={mode === "agent"} disabled={!agentAvailable} onChange={() => setMode("agent")} className="mt-0.5 size-4" />
            <span>
              AI 에이전트(심사위원 검토)
              <span className="block text-xs text-slate-500">
                {agentAvailable ? "JD 요건별 근거를 고르고 심사위원 심사·수정을 거칩니다. 몇 분 걸립니다." : "지금은 쓸 수 없습니다(경험 그래프가 비어 있거나 에이전트가 꺼져 있음)."}
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="regen-mode" value="single" checked={mode === "single"} onChange={() => setMode("single")} className="mt-0.5 size-4" />
            <span>
              빠른 초안
              <span className="block text-xs text-slate-500">AI가 한 번에 씁니다(보통 1~5분). 하루 30회까지(새로 만들기와 함께 셉니다).</span>
            </span>
          </label>
        </fieldset>

        {isCompany && (
          <fieldset className="space-y-2">
            <legend className="font-medium text-slate-900">채용 공고(JD)</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="regen-jd" checked={!editJd} onChange={() => setEditJd(false)} className="size-4" />
              <span>지금 JD 그대로{jdText.trim() ? "" : " (비어 있음 — 직무 기준으로 씁니다)"}</span>
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="regen-jd" checked={editJd} onChange={() => setEditJd(true)} className="size-4" />
              <span>JD를 고쳐서 다시 생성(완료되면 이력서의 JD 칸도 바뀝니다)</span>
            </label>
            {editJd && (
              <textarea
                aria-label="다시 생성에 쓸 JD"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                maxLength={MAX_RESUME_JD_CHARS}
                rows={6}
                className={textareaClass}
                placeholder="채용 공고의 자격 요건·우대 사항을 붙여넣어 주세요."
              />
            )}
          </fieldset>
        )}

        <label className="block">
          <span className="font-medium text-slate-900">양식</span>
          <select value={template} onChange={(e) => setTemplate(e.target.value as ResumeTemplateId)} className={inputClass}>
            {RESUME_TEMPLATE_IDS.map((id) => (
              <option key={id} value={id}>
                {RESUME_TEMPLATES[id].name}
                {id === templateId ? " (지금 양식)" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="font-medium text-slate-900">강조할 점(선택)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={MAX_RESUME_EMPHASIS_CHARS}
            rows={3}
            className={textareaClass}
            placeholder="예: 결제 시스템 성능 개선 경험을 앞에, 팀 리드 경험을 더 자세히"
          />
          <span className="mt-1 block text-xs text-slate-500">무엇을 앞에 둘지 정하는 참고입니다. 여기 적은 사실은 근거로 쓰지 않으니, 새 경험은 경험 그래프에 정리해 주세요.</span>
        </label>

        {error && (
          <Alert tone="error">
            {error.message}
            {error.href && (
              <>
                {" "}
                <Link href={error.href} className="font-medium underline">
                  진행 상황 보기
                </Link>
              </>
            )}
          </Alert>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 pt-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy !== null}>
            취소
          </Button>
          <Button type="button" loading={busy === "start"} disabled={busy !== null} onClick={() => void start()}>
            {hasUnsavedWork ? "그대로 다시 생성" : "다시 생성"}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
