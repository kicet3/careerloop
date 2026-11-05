import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ResumeEditor } from "@/components/resumes/ResumeEditor";
import { Alert } from "@/components/ui/Alert";
import { requireUser } from "@/lib/auth/session";
import { FeatureError } from "@/lib/api/errors";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { uploadLimitsFor } from "@/lib/ingest/upload-limits";
import { getResumeDetail, getResumeMeta, getResumePostingLink, listVersions } from "@/lib/resumes/service";
import type { ResumeDetail } from "@/lib/resumes/types";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser(`/app/resumes/${id}`);
  const meta = await getResumeMeta(user.id, id);
  return { title: meta?.title ?? "이력서" };
}

export default async function ResumePage({ params }: Props) {
  const { id } = await params;
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

  return (
    <div className="space-y-4">
      <Link href="/app/resumes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 이력서 목록
      </Link>
      {loadError && <Alert tone="error">{loadError}</Alert>}
      <ResumeEditor
        resume={detail.resume}
        versions={detail.versions}
        initialDocument={detail.current?.document ?? emptyResumeDocument()}
        currentVersionId={detail.current?.versionId ?? detail.resume.currentVersionId}
        posting={detail.posting}
        uploadLimits={uploadLimitsFor()}
      />
    </div>
  );
}
