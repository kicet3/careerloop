"use client";

/**
 * 작성 팁 패널의 'JD 맞춤 팁' 탭. GET /api/resumes/[id]/tips로 저장된 팁을 읽고, 없거나 JD가 바뀌었으면 '만들기'·'다시 만들기'(POST).
 * 키워드 포함 여부는 지금 편집 중인 문서로 다시 센다(resumeKeywordCoverage — 서버와 같은 결정적 비교).
 * 화면 묶음은 JdTipsView(순수 — 정적 렌더 시험용).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/components/ui/cn";
import {
  JD_SUMMARY_KIND_LABELS,
  JD_TIP_SECTIONS,
  type KeywordCoverage,
  type ResumeJdTipsResponse,
  resumeKeywordCoverage,
} from "@/lib/domain/resume-jd-tips";
import type { ResumeDocument } from "@/lib/domain/resumes";

type Loaded = Extract<ResumeJdTipsResponse, { status: "ready" | "stale" }>;

export interface JdTipsViewProps {
  /** null이면 처음 불러오는 중. */
  data: ResumeJdTipsResponse | null;
  coverage: KeywordCoverage[];
  generating: boolean;
  error: string | null;
  onGenerate: (force: boolean) => void;
  onRetryLoad?: () => void;
}

export function JdTipsView({ data, coverage, generating, error, onGenerate, onRetryLoad }: JdTipsViewProps) {
  if (!data) {
    return error ? (
      <div className="space-y-2" role="alert">
        <p className="text-rose-700">{error}</p>
        {onRetryLoad && (
          <button type="button" className="text-xs text-indigo-700 hover:underline" onClick={onRetryLoad}>
            다시 불러오기
          </button>
        )}
      </div>
    ) : (
      <p className="text-slate-500" aria-live="polite">
        JD 맞춤 팁을 불러오는 중…
      </p>
    );
  }
  if (data.status === "no_jd") {
    return (
      <p className="text-slate-600">
        {data.reason === "general"
          ? "공용 이력서에는 공고가 없어 JD 맞춤 팁을 만들지 않습니다. 다른 탭의 기본 작성 팁을 참고하세요."
          : "이력서에 채용 공고(JD)가 없어 맞춤 팁을 만들 수 없습니다. JD를 붙여 넣거나 공고를 연결하면 공고에 맞춘 팁을 만들 수 있습니다."}
      </p>
    );
  }
  const errorLine = error && (
    <p className="text-xs text-rose-700" role="alert">
      {error}
    </p>
  );
  if (data.status === "none") {
    return (
      <div className="space-y-2">
        <p>이 공고(JD)에 맞춘 작성 팁을 아직 만들지 않았습니다. 공고의 핵심 업무·요건을 요약하고, 구역별로 무엇을 고치면 좋을지와 넣을 키워드를 알려 드립니다.</p>
        <button
          type="button"
          disabled={generating}
          onClick={() => onGenerate(false)}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
        >
          {generating ? "만드는 중…" : "JD 맞춤 팁 만들기"}
        </button>
        {errorLine}
      </div>
    );
  }
  return <LoadedTips data={data} coverage={coverage} generating={generating} onRegenerate={() => onGenerate(true)} errorLine={errorLine} />;
}

function LoadedTips({
  data,
  coverage,
  generating,
  onRegenerate,
  errorLine,
}: {
  data: Loaded;
  coverage: KeywordCoverage[];
  generating: boolean;
  onRegenerate: () => void;
  errorLine: React.ReactNode;
}) {
  const { tips } = data;
  const missing = coverage.filter((c) => !c.included).length;
  const groups = JD_TIP_SECTIONS.map((s) => ({
    ...s,
    tips: tips.sections.find((x) => x.section === s.id)?.tips ?? [],
    experiences: tips.experiences.filter((e) => e.section === s.id),
  })).filter((g) => g.tips.length > 0 || g.experiences.length > 0);

  return (
    <div className="space-y-3">
      {data.status === "stale" && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
          이 팁을 만든 뒤 JD(회사·직무·공고)가 바뀌었습니다. 아래는 예전 공고 기준입니다. &lsquo;다시 만들기&rsquo;로 지금 공고에 맞추세요.
        </p>
      )}
      {data.reused && <p className="text-xs text-slate-500">같은 공고로 만든 다른 내 이력서의 팁을 다시 썼습니다.</p>}
      {tips.notices.map((n) => (
        <p key={n} className="text-xs text-slate-500">
          {n}
        </p>
      ))}

      {tips.summary.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-900">JD 요약</p>
          <ul className="mt-1 space-y-0.5">
            {tips.summary.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-[11px] text-slate-600 ring-1 ring-slate-200">{JD_SUMMARY_KIND_LABELS[l.kind]}</span>
                <span>{l.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {coverage.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-900">
            넣을 키워드 <span className="font-normal text-slate-500">· 포함 {coverage.length - missing}/{coverage.length}</span>
          </p>
          <ul className="mt-1 flex flex-wrap gap-1.5" aria-label="공고 키워드">
            {coverage.map((c) => (
              <li
                key={c.keyword}
                className={cn(
                  "rounded-full px-2 py-0.5 text-xs ring-1 ring-inset",
                  c.included ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-white text-amber-800 ring-amber-300",
                )}
              >
                {c.keyword} <span className="text-[11px]">{c.included ? "✓ 포함" : "추가 필요"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[11px] text-slate-500">실제로 해 본 일만 넣으세요. 해 보지 않은 기술을 키워드로만 채우지 않습니다.</p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.id} className="rounded-lg bg-white px-3 py-2 ring-1 ring-slate-200">
          <p className="text-xs font-semibold text-indigo-900">{g.label}</p>
          {g.tips.length > 0 && (
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {g.tips.map((t, i) => (
                <li key={i}>
                  {t.tip}
                  <span className="block text-[11px] text-slate-500">공고: &ldquo;{t.jdQuote}&rdquo;</span>
                </li>
              ))}
            </ul>
          )}
          {g.experiences.length > 0 && (
            <div className="mt-1.5 text-xs">
              <p className="font-medium text-slate-700">내 경험에서 쓸 만한 것</p>
              <ul className="mt-0.5 space-y-0.5">
                {g.experiences.map((e, i) => (
                  <li key={i}>
                    <span className="font-medium text-slate-900">{e.name}</span> <span className="text-slate-500">({e.kind})</span> — {e.why}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
      {groups.length === 0 && <p className="text-slate-500">공고에서 근거를 찾은 구역별 팁이 없습니다. &lsquo;다시 만들기&rsquo;를 눌러 보세요.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={generating}
          onClick={onRegenerate}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-60",
            data.status === "stale" ? "bg-indigo-600 text-white hover:bg-indigo-700" : "bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50",
          )}
        >
          {generating ? "만드는 중…" : "다시 만들기"}
        </button>
        {data.createdAt > 0 && <span className="text-[11px] text-slate-500">{new Date(data.createdAt).toLocaleString("ko-KR")} 기준</span>}
      </div>
      {errorLine}
      <p className="text-[11px] text-slate-500">AI가 공고에서 뽑은 제안입니다. 공고 인용과 내 경험이 맞는지 확인하고, 경험에 없는 내용은 쓰지 마세요.</p>
    </div>
  );
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : fallback;
  } catch {
    return fallback;
  }
}

export function JdTipsTab({ resumeId, document, jdKey }: { resumeId: string; document: ResumeDocument; jdKey: string }) {
  const [data, setData] = useState<ResumeJdTipsResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/resumes/${encodeURIComponent(resumeId)}/tips`, { signal: ctrl.signal, cache: "no-store" });
        if (!res.ok) throw new Error(await readError(res, "JD 맞춤 팁을 불러오지 못했습니다."));
        const body = (await res.json()) as ResumeJdTipsResponse;
        setData(body);
        setLoadError(null);
      } catch (err) {
        if (ctrl.signal.aborted) return;
        setData(null);
        setLoadError((err as Error).message || "JD 맞춤 팁을 불러오지 못했습니다.");
      }
    })();
    return () => ctrl.abort();
  }, [resumeId, jdKey, reload]);

  const generate = useCallback(
    async (force: boolean) => {
      setGenerating(true);
      setGenError(null);
      try {
        const res = await fetch(`/api/resumes/${encodeURIComponent(resumeId)}/tips`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        });
        if (!res.ok) throw new Error(await readError(res, "JD 맞춤 팁을 만들지 못했습니다. 잠시 뒤 다시 시도해 주세요."));
        setData((await res.json()) as ResumeJdTipsResponse);
      } catch (err) {
        setGenError((err as Error).message || "JD 맞춤 팁을 만들지 못했습니다.");
      } finally {
        setGenerating(false);
      }
    },
    [resumeId],
  );

  const keywords = data && (data.status === "ready" || data.status === "stale") ? data.tips.keywords : null;
  const coverage = useMemo(() => (keywords ? resumeKeywordCoverage(document, keywords) : []), [document, keywords]);

  return (
    <JdTipsView
      data={data}
      coverage={coverage}
      generating={generating}
      error={data ? genError : loadError}
      onGenerate={generate}
      onRetryLoad={() => {
        setLoadError(null);
        setReload((n) => n + 1);
      }}
    />
  );
}
