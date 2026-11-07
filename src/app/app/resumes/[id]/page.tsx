import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResumeEditor } from "@/components/resumes/ResumeEditor";
import { AgentReport } from "@/components/resumes/agent/AgentReport";
import { Alert } from "@/components/ui/Alert";
import { requireUser } from "@/lib/auth/session";
import { FeatureError } from "@/lib/api/errors";
import { toPortfolioPickOption } from "@/lib/domain/portfolios";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { uploadLimitsFor } from "@/lib/ingest/upload-limits";
import { getProfilePhotoUrl } from "@/lib/account/photo";
import { portfolioUploadLimits } from "@/lib/portfolios/http";
import { listPortfolios } from "@/lib/portfolios/service";
import { getEditDraft } from "@/lib/resumes/edit-draft";
import { getResumeDetail, getResumeMeta, getResumePostingLink, listVersions } from "@/lib/resumes/service";
import { resumeToText } from "@/lib/resumes/layout";
import { agentAvailableFor, getAgentReportForResume } from "@/lib/resume-agent/jobs";
import { graphEnabled } from "@/lib/graph/service";
import { findActiveRegenerate, regenerateJobHref } from "@/lib/resumes/regenerate";
import type { ResumeDetail } from "@/lib/resumes/types";

type Props = { params: Promise<{ id: string }>; searchParams?: Promise<{ report?: string | string[]; reportJob?: string | string[]; regenerated?: string | string[] }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser(`/app/resumes/${id}`);
  const meta = await getResumeMeta(user.id, id);
  return { title: meta?.title ?? "이력서" };
}

export default async function ResumePage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = (await searchParams) ?? {};
  const user = await requireUser(`/app/resumes/${id}`);

  let detail: ResumeDetail | null;
  let loadError: string | null = null;
  try {
    detail = await getResumeDetail(user.id, id);
  } catch (err) {
    // 현재 버전 본문이 저장소에서 사라진 경우: 빈 문서로 열고 버전 목록에서 복원할 수 있게 한다.
    if (!(err instanceof FeatureError)) throw err;
    const meta = await getResumeMeta(user.id, id);
    const versions = meta ? await listVersions(user.id, id) : null;
    detail = meta && versions ? { resume: meta, versions, current: null, posting: await getResumePostingLink(user.id, meta.postingId) } : null;
    loadError = err.message;
  }
  if (!detail) notFound();
  const reportJob = typeof sp.reportJob === "string" ? sp.reportJob.slice(0, 64) : null;
  const canRegenerate = graphEnabled();
  const [portfolios, photoUrl, agent, editDraft, agentAvailable, regenerating] = await Promise.all([
    listPortfolios(user.id),
    getProfilePhotoUrl(user.id),
    getAgentReportForResume(user.id, detail.resume.id, reportJob),
    // 임시 저장본(새 버전으로 저장하지 않은 작업본)이 있으면 편집 화면이 그 내용으로 연다.
    getEditDraft(user.id, detail.resume.id),
    canRegenerate ? agentAvailableFor(user).catch(() => false) : Promise.resolve(false),
    canRegenerate ? findActiveRegenerate(user.id, detail.resume.id).catch(() => null) : Promise.resolve(null),
  ]);
  const r = detail.resume;

  return (
    <div className="space-y-4">
      <Link href="/app/resumes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 이력서 목록
      </Link>
      {loadError && <Alert tone="error">{loadError}</Alert>}
      {agent && (
        <AgentReport
          report={agent.report}
          currentText={detail.current ? resumeToText(detail.current.document, r.templateId) : ""}
          defaultOpen={sp.report === "1" || reportJob !== null}
          shownJobId={agent.jobId}
          history={agent.history.map((h) => ({ ...h, href: `/app/resumes/${encodeURIComponent(r.id)}?reportJob=${encodeURIComponent(h.jobId)}` }))}
          rerun={{ kind: r.kind, company: r.company, roleTitle: r.roleTitle, jdText: r.jdText ?? "", postingId: r.postingId, templateId: r.templateId }}
        />
      )}
      <ResumeEditor
        resume={detail.resume}
        versions={detail.versions}
        initialDocument={detail.current?.document ?? emptyResumeDocument()}
        currentVersionId={detail.current?.versionId ?? detail.resume.currentVersionId}
        posting={detail.posting}
        uploadLimits={uploadLimitsFor()}
        portfolioUpload={portfolioUploadLimits().config}
        portfolios={portfolios.map(toPortfolioPickOption)}
        photoUrl={photoUrl}
        initialDraft={editDraft?.draft ?? null}
        regenerate={canRegenerate ? { agentAvailable, runningHref: regenerating ? regenerateJobHref(regenerating) : null } : null}
        regenerated={sp.regenerated === "1"}
      />
    </div>
  );
}
