/**
 * 요청 스코프(§3): 요청 하나의 상태 묶음 — ctx·snapshot·registry·검증 WeakSet·출처 재조회 캐시·도구 호출 카운터.
 * runAgentQa가 만들고 함수가 끝나면 버린다(모듈 전역에 두지 않는다). LLM 대화록에는 이 스코프의 validateBatch를 통과한
 * ValidatedResult만 renderForLlm으로 들어간다 — 타입(브랜드)과 런타임(WeakSet) 두 겹.
 */
import { CHAT_TAGS } from "@/lib/domain/chat";
import type { AuthContext } from "./auth-context";
import type { AuthoritativeSource, SourceExistsElsewhere, SourceReader } from "./chunks/authoritative";
import type { ChunkSourceType } from "./chunks/build";
import { SecurityViolation } from "./errors";
import type { Evidence, EvidenceRegistry } from "./registry";
import { safeText } from "./render";
import type { OwnedSnapshot } from "./snapshot";
import { type RawItem, validateBatch, type ValidatedResult, type ValidationScope } from "./validator";

export interface ScopeSources {
  readSource: SourceReader;
  sourceExistsElsewhere: SourceExistsElsewhere;
}

export class RequestScope implements ValidationScope {
  readonly validated = new WeakSet<object>();
  readonly #sources = new Map<string, Promise<AuthoritativeSource | null>>();
  readonly calls = { total: 0, byTool: new Map<string, number>() };

  constructor(
    readonly ctx: AuthContext,
    readonly snapshot: OwnedSnapshot,
    readonly registry: EvidenceRegistry,
    private readonly sources: ScopeSources,
  ) {
    if (snapshot.principalUserId !== ctx.principalUserId) throw new SecurityViolation("unowned_node");
  }

  /** 같은 출처는 요청 안에서 한 번만 읽는다(요청 지역 캐시). */
  readSource(sourceType: ChunkSourceType, sourceId: string): Promise<AuthoritativeSource | null> {
    const k = `${sourceType}:${sourceId}`;
    let p = this.#sources.get(k);
    if (!p) {
      p = this.sources.readSource(this.ctx.principalUserId, sourceType, sourceId);
      this.#sources.set(k, p);
    }
    return p;
  }

  sourceExistsElsewhere(sourceType: ChunkSourceType, sourceId: string): Promise<boolean> {
    return this.sources.sourceExistsElsewhere(sourceType, sourceId, this.ctx.principalUserId);
  }

  validateBatch(raw: readonly RawItem[]): Promise<ValidatedResult> {
    return validateBatch(this, raw);
  }

  /** 검증 결과 → 근거 발급. WeakSet에 없는 객체(캐스트로 만든 가짜)는 SecurityViolation('unknown_kind'). */
  issue(v: ValidatedResult): Evidence[] {
    if (!v || typeof v !== "object" || !this.validated.has(v)) throw new SecurityViolation("unknown_kind");
    return this.registry.issue(v, v.items, this.validated);
  }

  /** 검증 결과 → LLM에 보일 근거 블록들(서버가 붙인 머리줄 + 무력화한 본문). */
  renderForLlm(v: ValidatedResult): { evidence: Evidence[]; text: string } {
    const evidence = this.issue(v);
    return { evidence, text: evidence.map((e) => this.renderEvidence(e)).join("\n") };
  }

  renderEvidence(e: Evidence): string {
    const head = [`[${e.evidenceId}]${e.handle ? ` ${e.handle}` : ""}`, kindName(e.kind)];
    if (e.meta?.matchedBy) head.push(`일치=${e.meta.matchedBy}`);
    if (e.linkedNodeIds?.length) {
      const linked = e.linkedNodeIds
        .map((id) => {
          const n = this.snapshot.nodes.get(id);
          const h = n ? this.registry.nodeHandle(id, n.label) : null;
          return h && n ? `${h}(${safeText(n.title, 40)})` : null;
        })
        .filter(Boolean);
      if (linked.length) head.push(`연결 노드 ${linked.join(", ")}`);
    }
    return `<${CHAT_TAGS.evidence}>\n${head.join(" · ")}\n${e.content}\n</${CHAT_TAGS.evidence}>`;
  }

  countCall(tool: string): { total: number; tool: number } {
    this.calls.total += 1;
    const n = (this.calls.byTool.get(tool) ?? 0) + 1;
    this.calls.byTool.set(tool, n);
    return { total: this.calls.total, tool: n };
  }
}

const KIND_NAME: Record<Evidence["kind"], string> = {
  node: "노드",
  edge: "관계",
  path: "경로",
  aggregate: "집계",
  chunk: "문서 조각",
  "source-span": "원문 구간",
  derived: "파생",
};
const kindName = (k: Evidence["kind"]) => KIND_NAME[k];
