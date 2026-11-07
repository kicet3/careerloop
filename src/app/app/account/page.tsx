import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { DeleteAccountButton } from "@/components/account/DeleteAccount";
import { LoginInfoCard } from "@/components/account/LoginInfoCard";
import { GithubConnection } from "@/components/account/GithubConnection";
import { MarketingConsent } from "@/components/account/MarketingConsent";
import { formatDateTime } from "@/components/app/stages";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { getAccountInfo } from "@/lib/auth/account";
import { requireUser } from "@/lib/auth/session";
import { CONSENT_DOCS, marketingAgreed, type ConsentSource } from "@/lib/legal/consents";
import { getLatestConsents, listConsentHistory } from "@/lib/legal/service";
import { getGithubStatus } from "@/lib/github/account";
import { githubErrorMessage } from "@/lib/github/types";

const SOURCE_LABEL: Record<ConsentSource, string> = { signup: "가입", gate: "재확인", account: "계정 설정" };

const HISTORY_LABEL = {
  terms: "이용약관",
  privacy: "개인정보 처리 안내",
  age14: "만 14세 이상 확인",
  marketing: "광고성 정보 수신",
} as const;

export const metadata: Metadata = { title: "계정" };
export const dynamic = "force-dynamic";

export default async function AccountPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser("/app/account");
  const [info, latest, history, github, sp] = await Promise.all([
    getAccountInfo(user.id),
    getLatestConsents(user.id),
    listConsentHistory(user.id, 20),
    getGithubStatus(user.id),
    searchParams,
  ]);
  if (!info) notFound();
  // ?github_error=는 정해 둔 코드만 문구로 바꾼다(임의 문자열을 그대로 보여 주지 않는다).
  const githubError = githubErrorMessage(sp.github_error);
  const githubFlash = githubError
    ? { tone: "error" as const, text: githubError }
    : sp.github === "connected"
      ? { tone: "ok" as const, text: "GitHub 계정을 연결했습니다." }
      : sp.github === "installed"
        ? { tone: "ok" as const, text: "GitHub에서 저장소 선택을 저장했습니다." }
        : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          계정
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          가입과 로그인은 Google 계정으로만 합니다.
        </p>
      </div>

      <LoginInfoCard email={info.email} name={info.name} googleLinked={info.googleLinked} photoUrl={info.photoUrl} />

      <Card>
        <CardHeader
          title="동의 관리"
          description={
            <>
              <Link href="/terms" className="text-indigo-700 underline underline-offset-2">
                이용약관
              </Link>{" "}
              ·{" "}
              <Link href="/privacy" className="font-semibold text-indigo-700 underline underline-offset-2">
                개인정보 처리방침
              </Link>
            </>
          }
        />
        <CardBody className="space-y-5">
          <MarketingConsent agreed={marketingAgreed(latest)} />
          {history.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:text-slate-900">동의 기록 보기</summary>
              <ul className="mt-2 divide-y divide-slate-100 text-xs text-slate-600">
                {history.map((h, i) => (
                  <li key={`${h.type}-${h.at}-${i}`} className="flex flex-wrap gap-x-3 py-1.5">
                    <span className="w-32 shrink-0 tabular-nums">{formatDateTime(h.at)}</span>
                    <span className="font-medium text-slate-800">{HISTORY_LABEL[h.type] ?? h.type}</span>
                    <span>{h.agreed ? (CONSENT_DOCS[h.type]?.kind === "consent" ? "동의" : "확인") : "철회"}</span>
                    <span className="text-slate-400">
                      {SOURCE_LABEL[h.source] ?? h.source} · {h.version}판
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardBody>
      </Card>

      <Card id="github" className="scroll-mt-6">
        <CardHeader
          title="연결된 서비스"
          description="GitHub 계정을 연결하면 경험 그래프에서 저장소를 골라 프로젝트 단위로 AI와 정리할 수 있습니다."
        />
        <CardBody>
          <GithubConnection initial={github} flash={githubFlash} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="MCP 연결"
          description="Claude Code·Cursor·Claude Desktop 같은 외부 AI 앱에서 내 경험 그래프를 읽게 하는 토큰을 만들고 관리합니다."
        />
        <CardBody>
          <Link href="/app/mcp" className="text-sm font-medium text-indigo-700 underline underline-offset-2">
            MCP 연결 관리 →
          </Link>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="회원 탈퇴"
          description="탈퇴하면 계정과 진단·이력서·공고·지원 기록, 경험 그래프, MCP 연결 토큰, GitHub 연결과 가져온 저장소 정보, 프로필 사진, 올린 파일(포트폴리오 원본 파일 포함)이 모두 삭제되며 되돌릴 수 없습니다."
        />
        <CardBody>
          <DeleteAccountButton />
        </CardBody>
      </Card>
    </div>
  );
}
