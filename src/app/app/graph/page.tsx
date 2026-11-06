import type { Metadata } from "next";
import { GraphWorkspace } from "@/components/graph/GraphWorkspace";
import { Alert } from "@/components/ui/Alert";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/session";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import type { CareerGraph } from "@/lib/domain/graph";
import { getCareerGraph, GraphUnavailableError, graphEnabled } from "@/lib/graph/service";
import { uploadLimitsFor } from "@/lib/ingest/upload-limits";

export const metadata: Metadata = { title: "경험 그래프" };
export const dynamic = "force-dynamic";

export default async function GraphPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser("/app/graph");
  // ?ask=… — 공고 대조의 '그래프 채팅으로 추가'가 채팅 입력을 미리 채운다(보내기는 사용자가 누른다).
  const params = await searchParams;
  const askRaw = params.ask;
  const ask = (typeof askRaw === "string" ? askRaw.trim().slice(0, MAX_CHAT_MESSAGE_CHARS) : "") || undefined;
  // ?tab=qa — '경험 질문하기' 탭으로 연다.
  const tab = params.tab === "qa" ? "qa" : undefined;

  if (!graphEnabled()) {
    return (
      <div className="space-y-6">
        <Header />
        <Card className="p-5">
          <Alert tone="warning" title="경험 그래프 저장소가 설정되지 않았습니다">
            이 서버에는 Neo4j 연결 정보(NEO4J_URI·NEO4J_USER·NEO4J_PASSWORD)가 없어 경험 그래프를 쓸 수 없습니다. 관리자라면
            .env.example의 Neo4j 항목을 채우고(개발용은 docker-compose.yml) 서버를 다시 시작해 주세요.
          </Alert>
        </Card>
      </div>
    );
  }

  // 첫 화면은 서버에서 그려 깜박임을 없앤다. Neo4j가 잠시 안 되면 오류 안내를 보이고 화면에서 다시 시도할 수 있다.
  let initialGraph: CareerGraph | null = null;
  let initialError: string | null = null;
  try {
    initialGraph = await getCareerGraph(user.id, { personName: user.name });
  } catch (err) {
    if (!(err instanceof GraphUnavailableError)) console.error("[GET /app/graph]", err);
    initialError = "경험 그래프 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  return (
    <div className="space-y-6">
      <Header />
      <GraphWorkspace
        initialGraph={initialGraph}
        initialError={initialError}
        initialMessage={ask}
        initialTab={tab}
        uploadLimits={uploadLimitsFor()}
      />
    </div>
  );
}

function Header() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">경험 그래프</h1>
      <p className="mt-1 max-w-prose text-sm text-slate-500">
        회사·직무·프로젝트·경험·기술·성과를 서로 이어 정리해 둡니다. 채팅으로 이야기하거나 이력서를 올려 채우고, 정리한 그래프에 질문해
        보세요.
      </p>
    </div>
  );
}
