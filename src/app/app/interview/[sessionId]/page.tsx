import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { InterviewSessionView } from "@/components/interview/InterviewSessionView";
import { requireUser } from "@/lib/auth/session";
import { getSessionDetail } from "@/lib/interview/store";

export const metadata: Metadata = { title: "면접 연습" };
export const dynamic = "force-dynamic";

export default async function InterviewSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const user = await requireUser(`/app/interview/${sessionId}`);
  const detail = await getSessionDetail(user.id, sessionId);
  if (!detail) notFound();
  return <InterviewSessionView initial={detail} />;
}
