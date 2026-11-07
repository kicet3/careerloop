/**
 * 근거 레지스트리(§7.5) — 요청 객체(모듈 전역 Map이 아니다). 검증을 통과한 결과에만 evidence_id를 발급한다.
 * evidence_id = 'ev_' + base64url(HMAC_SHA256(key, requestId|principal|kind|sourceKey|version)).slice(0, 22) (132비트).
 * 권위는 이 요청 Map 소속이다 — get()은 Map에 있고 HMAC 재계산이 맞고 요청·사용자가 같을 때만 값을 준다.
 * 다른 요청의 id는 requestId가 달라 HMAC이 맞지 않고 Map에도 없으므로 무효다(재사용 불신).
 * handle(N1·C1)은 요청 안 순번이다. 같은 노드·청크는 한 요청에서 늘 같은 handle을 받는다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthContext } from "./auth-context";
import type { ChunkSourceType } from "./chunks/build";
import { evidenceSecret } from "./config";
import type { AggregateGroup } from "./graph/eval-in-memory";
import type { ValidatedPlan } from "./graph/plan";
import type { SnapLabel } from "./snapshot";

export type EvidenceKind = "node" | "edge" | "path" | "aggregate" | "chunk" | "source-span" | "derived";

export interface EvidenceDisplay {
  /** 출처 라벨(노드 라벨 이름 / 출처 유형 이름). */
  label: string;
  name: string;
  snippet: string;
  pathText?: string;
  sourceType?: ChunkSourceType;
}

/** 검증기가 권위 레코드에서 새로 만든 값(원시 결과를 그대로 승격하지 않는다). */
export interface ValidatedItem {
  readonly kind: EvidenceKind;
  readonly sourceKey: string;
  readonly version: string;
  /** LLM에 보이는 본문(무력화 끝). 최종 검증의 수치·날짜·이름 대조 기준. */
  readonly content: string;
  readonly inputIds: readonly string[];
  readonly display: Readonly<EvidenceDisplay>;
  readonly nodeLabel?: SnapLabel;
  readonly linkedNodeIds?: readonly string[];
  readonly chunk?: Readonly<{ chunkId: string; sourceType: ChunkSourceType; sourceId: string; sourceVersion: string; spanStart: number; spanEnd: number; contentHash: string }>;
  readonly span?: Readonly<{ sourceType: ChunkSourceType; sourceId: string; sourceVersion: string; start: number; end: number; hash: string; parentEvidenceId: string }>;
  readonly aggregate?: Readonly<{ plan: ValidatedPlan; groups: readonly AggregateGroup[] }>;
  /** 렌더 머리말에 붙일 비데이터 정보(일치 방식·점수). */
  readonly meta?: Readonly<Record<string, string | number>>;
}

export interface Evidence extends ValidatedItem {
  readonly evidenceId: string;
  readonly handle?: string;
  readonly requestId: string;
  readonly principalUserId: string;
}

const MAX_HANDLES = 999;

export class EvidenceRegistry {
  readonly #ctx: AuthContext;
  readonly #key: Buffer;
  readonly #byId = new Map<string, Evidence>();
  readonly #nodeHandles = new Map<string, { handle: string; label: SnapLabel }>();
  readonly #handleToNode = new Map<string, { nodeId: string; label: SnapLabel }>();
  readonly #chunkHandles = new Map<string, string>();
  readonly #handleToChunk = new Map<string, string>();

  constructor(ctx: AuthContext, key: Buffer | null = evidenceSecret()) {
    if (!key) throw new Error("RAG_EVIDENCE_SECRET이 없습니다");
    this.#ctx = ctx;
    this.#key = key;
  }

  #mac(kind: EvidenceKind, sourceKey: string, version: string, requestId = this.#ctx.requestId, principal = this.#ctx.principalUserId): string {
    const h = createHmac("sha256", this.#key).update(`${requestId}|${principal}|${kind}|${sourceKey}|${version}`).digest("base64url");
    return `ev_${h.slice(0, 22)}`;
  }

  /** 테스트용: 임의 요청·사용자로 만든 id(위조·재사용 시험). */
  forgeIdForTest(kind: EvidenceKind, sourceKey: string, version: string, requestId: string, principal: string): string {
    return this.#mac(kind, sourceKey, version, requestId, principal);
  }

  /** 노드 handle(N#) — 스냅샷 노드에만(호출자 validator/scope가 스냅샷 소속을 확인한 뒤). */
  nodeHandle(nodeId: string, label: SnapLabel): string | null {
    const have = this.#nodeHandles.get(nodeId);
    if (have) return have.handle;
    if (this.#nodeHandles.size >= MAX_HANDLES) return null;
    const handle = `N${this.#nodeHandles.size + 1}`;
    this.#nodeHandles.set(nodeId, { handle, label });
    this.#handleToNode.set(handle, { nodeId, label });
    return handle;
  }

  #chunkHandle(chunkId: string): string | undefined {
    const have = this.#chunkHandles.get(chunkId);
    if (have) return have;
    if (this.#chunkHandles.size >= MAX_HANDLES) return undefined;
    const handle = `C${this.#chunkHandles.size + 1}`;
    this.#chunkHandles.set(chunkId, handle);
    this.#handleToChunk.set(handle, chunkId);
    return handle;
  }

  /**
   * 검증된 항목 → 근거. validated: 요청 스코프 WeakSet — 그 안에 있는 ValidatedResult의 항목만 받는다(scope.ts가 부른다).
   */
  issue(result: object, items: readonly ValidatedItem[], validated: WeakSet<object>): Evidence[] {
    if (!validated.has(result)) throw new Error("unvalidated");
    return items.map((it) => {
      const evidenceId = this.#mac(it.kind, it.sourceKey, it.version);
      const existing = this.#byId.get(evidenceId);
      if (existing) return existing;
      let handle: string | undefined;
      if (it.kind === "node" && it.nodeLabel) handle = this.nodeHandle(it.sourceKey, it.nodeLabel) ?? undefined;
      if (it.kind === "chunk") handle = this.#chunkHandle(it.sourceKey);
      const ev: Evidence = Object.freeze({
        ...it,
        evidenceId,
        ...(handle ? { handle } : {}),
        requestId: this.#ctx.requestId,
        principalUserId: this.#ctx.principalUserId,
      });
      this.#byId.set(evidenceId, ev);
      return ev;
    });
  }

  /** 이 요청에서 발급했고 HMAC 재계산·요청·사용자가 맞을 때만. */
  get(evidenceId: string): Evidence | null {
    if (typeof evidenceId !== "string" || !/^ev_[A-Za-z0-9_-]{22}$/.test(evidenceId)) return null;
    const ev = this.#byId.get(evidenceId);
    if (!ev) return null;
    if (ev.requestId !== this.#ctx.requestId || ev.principalUserId !== this.#ctx.principalUserId) return null;
    const expect = Buffer.from(this.#mac(ev.kind, ev.sourceKey, ev.version));
    const got = Buffer.from(evidenceId);
    if (expect.length !== got.length || !timingSafeEqual(expect, got)) return null;
    return ev;
  }

  resolveNodeHandle(handle: string): { nodeId: string; label: SnapLabel } | null {
    return this.#handleToNode.get(handle) ?? null;
  }

  resolveChunkHandle(handle: string): string | null {
    return this.#handleToChunk.get(handle) ?? null;
  }

  nodeHandleOf(nodeId: string): string | null {
    return this.#nodeHandles.get(nodeId)?.handle ?? null;
  }

  all(): Evidence[] {
    return [...this.#byId.values()];
  }
}
