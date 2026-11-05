"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { NO_ENGINE_MESSAGE, PROVIDER_DATA_DESTINATION, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { SITUATION_LABELS } from "@/lib/domain/reviewers";
import { SITUATIONS, type Situation } from "@/lib/domain/schemas";
import { formatMb, SELF_HOSTED_UPLOAD_LIMITS, totalUploadError, uploadLimitMessage, type UploadLimits } from "@/lib/ingest/upload-limits";
import { takeDiagnosisPrefill } from "@/lib/resumes/prefill";
import { saveCreationWarnings } from "./creation-warnings";
import { FileDrop, UPLOAD_ACCEPT, UPLOAD_FORMATS_LABEL } from "./FileDrop";
import { SegmentedTabs } from "./Tabs";

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

const SITUATION_HINTS: Record<Situation, string> = {
  general: "같은 직무·업계로 지원",
  career_change: "다른 직무나 업계로 옮기려는 경우",
  new_grad: "인턴·프로젝트·학업 위주 이력서",
  rewrite_check: "한 번 손본 이력서를 다시 확인",
};

const STATUS_FALLBACK: Record<number, string> = {
  400: "입력 내용을 확인해 주세요.",
  401: "로그인이 필요합니다.",
  409: "이미 진행 중인 진단이 있습니다. 끝난 뒤 다시 시도해 주세요.",
  429: "오늘 진단 가능 횟수를 모두 사용했습니다. 내일 다시 시도해 주세요.",
};

type Mode = "file" | "text";

export function NewDiagnosisForm({
  providers,
  defaultProvider,
  uploadLimits = SELF_HOSTED_UPLOAD_LIMITS,
}: {
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
  /** 서버가 정한 업로드 상한(Vercel은 요청 본문 4.5MB 때문에 더 작다). */
  uploadLimits?: UploadLimits;
}) {
  const perFile = formatMb(uploadLimits.perFileBytes);
  const router = useRouter();
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const selected = providers.find((p) => p.id === provider);
  const destination = provider ? PROVIDER_DATA_DESTINATION[provider] : null;
  const isCli = provider === "claude-cli" || provider === "codex-cli";
  const hasCliOptions = providers.some((p) => p.id === "claude-cli" || p.id === "codex-cli");

  const [resumeMode, setResumeMode] = useState<Mode>("file");
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [jdMode, setJdMode] = useState<Mode>("text");
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [jdText, setJdText] = useState("");
  const [situation, setSituation] = useState<Situation>("general");
  const [notes, setNotes] = useState("");
  const [portfolioFile, setPortfolioFile] = useState<File | null>(null);
  const [portfolioText, setPortfolioText] = useState("");

  const [fileError, setFileError] = useState<{ resume?: string; jd?: string; portfolio?: string }>({});
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  /** 공고 보관함의 "이 공고로 진단"에서 왔으면 그 공고(진단이 공고에 연결된다). */
  const [posting, setPosting] = useState<{ id: string; label: string } | null>(null);

  // 이력서 화면의 "이 이력서로 진단"이 sessionStorage로 넘긴 값(한 번 읽고 지운다). 저장소는 마운트 뒤에만 읽을 수 있다.
  useEffect(() => {
    const p = takeDiagnosisPrefill();
    if (!p) return;
    /* eslint-disable react-hooks/set-state-in-effect -- 외부 저장소(sessionStorage)에서 한 번 읽는다 */
    if (p.postingId) setPosting({ id: p.postingId, label: p.postingLabel ?? "" });
    if (p.resumeText.trim()) {
      setResumeMode("text");
      setResumeText(p.resumeText);
    }
    if (p.targetRole.trim()) setTargetRole(p.targetRole);
    if (p.jdText.trim()) {
      setJdMode("text");
      setJdText(p.jdText);
    }
    setPrefilled(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);

  const hasResume = resumeMode === "file" ? !!resumeFile : resumeText.trim().length > 0;
  const hasJd = jdMode === "file" ? !!jdFile : jdText.trim().length > 0;
  const hasPortfolio = !!portfolioFile || portfolioText.trim().length > 0;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!hasResume) {
      setError(resumeMode === "file" ? "이력서 파일을 올려 주세요." : "이력서 내용을 붙여넣어 주세요.");
      return;
    }
    if (!targetRole.trim()) {
      setError("지원 직무를 입력해 주세요.");
      return;
    }
    if (!provider || !selected?.ready) {
      setError(selected?.reason ?? (providers.some((p) => p.ready) ? "사용할 AI 엔진을 골라 주세요." : NO_ENGINE_MESSAGE));
      return;
    }

    const tooBig = totalUploadError(
      [resumeMode === "file" ? resumeFile : null, jdMode === "file" ? jdFile : null, portfolioFile],
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
    if (jdMode === "file" && jdFile) fd.set(F.jdFile, jdFile);
    else if (jdText.trim()) fd.set(F.jdText, jdText);
    fd.set(F.situation, situation);
    if (notes.trim()) fd.set(F.notes, notes.trim());
    if (portfolioFile) fd.set(F.portfolioFile, portfolioFile);
    if (portfolioText.trim()) fd.set(F.portfolioText, portfolioText.trim());
    fd.set(F.provider, provider);
    if (posting) fd.set(F.postingId, posting.id);

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
            : "이력서 화면에서 내용을 가져와 채웠습니다. 확인한 뒤 진단을 시작하세요."}
        </Alert>
      )}
      {/* 1. 이력서 */}
      <Card data-half className="flex flex-col p-5 sm:p-6">
        <SectionTitle step={1} title="이력서" required />
        <div className="mt-4 space-y-3">
          <SegmentedTabs
            label="이력서 입력 방식"
            value={resumeMode}
            onChange={setResumeMode}
            options={[
              { value: "file", label: "파일 올리기" },
              { value: "text", label: "직접 붙여넣기" },
            ]}
          />
          {resumeMode === "file" ? (
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
          ) : (
            <textarea
              aria-label="이력서 내용"
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              rows={12}
              placeholder="이력서 전체를 붙여넣어 주세요. 문장은 고치지 말고 그대로 넣어야 심사위원이 정확히 인용합니다."
              className={textareaClass}
            />
          )}
          {fileError.resume && <p className="text-sm text-red-600">{fileError.resume}</p>}
        </div>
      </Card>

      {/* 2. 지원 직무 + JD */}
      <Card data-half className="flex flex-col p-5 sm:p-6">
        <SectionTitle step={2} title="지원할 자리" />
        <div className="mt-4 space-y-5">
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
            {!hasJd && (
              <Alert tone="warning" className="mt-3">
                JD 없이도 진단할 수 있지만, 이때는 직무명만으로 요건을 <strong>추정</strong>합니다. 적합도 점수와 키워드
                심사의 정확도가 크게 떨어지고 보고서에 &lsquo;추정&rsquo;으로 표시됩니다.
              </Alert>
            )}
          </div>
        </div>
      </Card>

      {/* 3. 상황·메모 */}
      <Card data-half className="flex flex-col p-5 sm:p-6">
        <SectionTitle step={3} title="상황과 메모" />
        <fieldset className="mt-4">
          <legend className="text-sm font-medium text-slate-800">지원 상황</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {SITUATIONS.map((s) => (
              <label
                key={s}
                className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 px-3 py-2.5 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60"
              >
                <input
                  type="radio"
                  name="situation"
                  value={s}
                  checked={situation === s}
                  onChange={() => setSituation(s)}
                  className="mt-1 accent-indigo-600"
                />
                <span>
                  <span className="block text-sm font-medium text-slate-900">{SITUATION_LABELS[s]}</span>
                  <span className="block text-xs text-slate-500">{SITUATION_HINTS[s]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="mt-5">
          <label htmlFor="notes" className="block text-sm font-medium text-slate-800">
            메모 <span className="font-normal text-slate-400">(선택)</span>
          </label>
          <textarea
            id="notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={2000}
            rows={3}
            placeholder="예: 마케팅 3년 후 데이터 분석으로 전환 중. 공백기 6개월은 부트캠프 수료."
            className={textareaClass}
          />
          <p className="mt-1 text-right text-xs text-slate-400">{notes.length}/2000</p>
        </div>
      </Card>

      {/* 4. 포트폴리오(선택) */}
      <Card data-half className="flex flex-col p-5 sm:p-6">
        <SectionTitle step={4} title="포트폴리오" optional />
        <p className="mt-2 text-sm text-slate-500">
          포트폴리오를 함께 내면 심사위원 7명과 적합도·재작성·개선 방향이 이력서와 <strong className="font-medium text-slate-700">별개 자료</strong>로
          참고합니다. 이력서에 빠진 근거를 찾아 옮길 방향을 알려 주며, 인용 확인은 이력서 원문만 대상으로 합니다.
        </p>
        <div className="mt-4 space-y-4">
          <div>
            <span className="block text-sm font-medium text-slate-800">포트폴리오 파일</span>
            <div className="mt-1.5">
              <FileDrop
                maxBytes={uploadLimits.perFileBytes}
                file={portfolioFile}
                accept={PORTFOLIO_ACCEPT}
                label="포트폴리오 파일을 끌어다 놓거나 눌러서 선택"
                hint={`${UPLOAD_FORMATS_LABEL}, ${perFile} 이하. 글자를 읽을 수 있는 파일만 반영되며, 긴 파일은 앞부분만 씁니다.`}
                onChange={(f, err) => {
                  setPortfolioFile(f);
                  setFileError((p) => ({ ...p, portfolio: err ?? undefined }));
                }}
              />
            </div>
            {fileError.portfolio && <p className="mt-2 text-sm text-red-600">{fileError.portfolio}</p>}
          </div>
          <div>
            <label htmlFor="portfolioText" className="block text-sm font-medium text-slate-800">
              링크·설명
            </label>
            <textarea
              id="portfolioText"
              value={portfolioText}
              onChange={(e) => setPortfolioText(e.target.value)}
              maxLength={PORTFOLIO_NOTE_MAX}
              rows={4}
              placeholder={"예: https://github.com/me/payments — 결제 정산 배치를 Kotlin으로 재작성, 처리 시간 4시간 → 40분.\n링크는 열어 보지 못하므로 프로젝트 내용·역할·결과를 함께 적어 주세요."}
              className={textareaClass}
            />
            <p className="mt-1 text-right text-xs text-slate-400">
              {portfolioText.length}/{PORTFOLIO_NOTE_MAX}
            </p>
          </div>
        </div>
      </Card>

      {/* 5. AI 엔진 */}
      {(providers.length > 1 || hasCliOptions) && (
        <Card className="p-5 sm:p-6">
          <SectionTitle step={5} title="AI 엔진" />
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
        <Button type="submit" size="lg" loading={submitting}>
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
