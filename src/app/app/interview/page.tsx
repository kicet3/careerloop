import type { Metadata } from "next";
import { NewInterviewForm, type InterviewResumeOption } from "@/components/interview/NewInterviewForm";
import { SessionList } from "@/components/interview/SessionList";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/session";
import { listSessions } from "@/lib/interview/store";
import { listResumes } from "@/lib/resumes/service";

export const metadata: Metadata = { title: "면접 연습" };
export const dynamic = "force-dynamic";

type Search = Promise<{ [key: string]: string | string[] | undefined }>;

/** 면접 연습: 이력서를 골라 예상 질문을 만들고, 만든 연습 목록을 본다. ?resume=<id>로 이력서를 미리 고를 수 있다. */
export default async function InterviewPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("/app/interview");
  const sp = await searchParams;
  const preset = Array.isArray(sp.resume) ? sp.resume[0] : sp.resume;
  const [resumes, sessions] = await Promise.all([listResumes(user.id), listSessions(user.id)]);
  const options: InterviewResumeOption[] = resumes
    .filter((r) => r.currentVersionNo != null)
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      company: r.company,
      roleTitle: r.roleTitle,
      postingId: r.postingId,
      hasJd: !!r.jdText?.trim(),
      portfolioLabel: r.portfolio ? (r.portfolio.kind === "file" ? (r.portfolio.fileName ?? "파일") : "링크") : null,
      portfolioReadable: r.portfolio?.kind === "file",
      versionNo: r.currentVersionNo,
    }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">면접 연습</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          내 이력서·포트폴리오·지원 공고의 문장마다 면접관이 물을 질문을 만들고, 답변을 써 보며 근거·수치·본인 역할·길이·구조를 점검합니다. 질문마다 근거가 된
          서류 줄을 함께 보여 줍니다.
        </p>
      </div>

      <Card>
        <CardHeader title="새 면접 연습" description="서류 한 줄 질문, 대표 프로젝트 5단계, 빈틈 확인(PIVOT), 곤란한 질문, 지원 동기까지 한 번에 만듭니다." />
        <CardBody>
          <NewInterviewForm resumes={options} initialResumeId={preset ?? null} />
        </CardBody>
      </Card>

      <section aria-labelledby="interview-sessions" className="space-y-3">
        <h2 id="interview-sessions" className="text-base font-semibold text-slate-900">
          내 연습 <span className="font-normal text-slate-500">{sessions.length}개</span>
        </h2>
        <SessionList sessions={sessions} />
      </section>
    </div>
  );
}
