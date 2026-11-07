/**
 * 이력서 임시 저장 라우트·서비스: 로그인(401)·같은 출처(403)·남의 이력서 404·no-store, 본문 스키마 검증·크기 한도,
 * 기준 버전 확인, 새 버전 저장·복원 때 작업본 삭제(AI 다듬기 같은 다른 저장은 남김), 충돌(currentVersionId) 표시,
 * 목록 배지(hasEditDraft), 이력서·계정 삭제 시 함께 삭제, 쓰기 횟수 제한.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { emptyResumeDocument, type ResumeDocument } from "@/lib/domain/resumes";
import type { ResumeEditDraftResponse } from "@/lib/resumes/types";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ user: null as { id: string; email: string; name: string | null } | null }));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: (req: Request) =>
    req.headers.get("origin") === "https://evil.example" ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null,
}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-edit-draft-"));
let tdb: TestDb;
let route: typeof import("./route");
let versionsRoute: typeof import("../versions/route");
let restoreRoute: typeof import("../versions/[versionId]/restore/route");
let service: typeof import("@/lib/resumes/service");
let http: typeof import("@/lib/resumes/http");

function doc(name = "홍길동"): ResumeDocument {
  const d = emptyResumeDocument();
  d.basics.name = name;
  d.summary = "결제 정산 시스템을 운영했다.";
  return d;
}

let resumeA = "";
let v1A = "";
let resumeB = "";
let v1B = "";

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(dir, "storage");
  tdb = await createTestDb();
  route = await import("./route");
  versionsRoute = await import("../versions/route");
  restoreRoute = await import("../versions/[versionId]/restore/route");
  service = await import("@/lib/resumes/service");
  http = await import("@/lib/resumes/http");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await tdb.reset();
  http.resumeDraftWriteLimiter.reset("ua");
  http.resumeDraftWriteLimiter.reset("ub");
  state.user = { id: "ua", email: "ua@x.com", name: null };
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  const a = await service.createResume("ua", { company: "토스", roleTitle: "백엔드", templateId: "performance", document: doc(), source: "manual" });
  const b = await service.createResume("ub", { company: "당근", roleTitle: "백엔드", templateId: "performance", document: doc("김비밀"), source: "manual" });
  resumeA = a.resume.id;
  v1A = a.version.id;
  resumeB = b.resume.id;
  v1B = b.version.id;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (id: string) => `http://localhost/api/resumes/${id}/draft`;
const get = (id: string) => route.GET(new Request(url(id)), ctx(id));
const put = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  route.PUT(
    new Request(url(id), { method: "PUT", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }),
    ctx(id),
  );
const del = (id: string, headers: Record<string, string> = {}) => route.DELETE(new Request(url(id), { method: "DELETE", headers }), ctx(id));
const commit = (id: string, body: unknown) =>
  versionsRoute.POST(
    new Request(`http://localhost/api/resumes/${id}/versions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    ctx(id),
  );
const draftRows = () => tdb.prisma.resumeEditDraft.findMany();

describe("인증·출처·소유권", () => {
  it("로그인이 없으면 401", async () => {
    state.user = null;
    expect((await get(resumeA)).status).toBe(401);
    expect((await put(resumeA, { document: doc(), baseVersionId: v1A })).status).toBe(401);
    expect((await del(resumeA)).status).toBe(401);
  });

  it("다른 출처의 쓰기는 403이고 아무것도 저장하지 않는다", async () => {
    const evil = { origin: "https://evil.example" };
    expect((await put(resumeA, { document: doc("바뀜"), baseVersionId: v1A }, evil)).status).toBe(403);
    expect(await draftRows()).toHaveLength(0);
    await put(resumeA, { document: doc("내 작업"), baseVersionId: v1A });
    expect((await del(resumeA, evil)).status).toBe(403);
    expect(await draftRows()).toHaveLength(1);
  });

  it("남의 이력서는 읽기·쓰기·버리기 모두 404이고 남의 작업본을 건드리지 않는다", async () => {
    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await put(resumeB, { document: doc("B의 작업"), baseVersionId: v1B })).status).toBe(200);
    state.user = { id: "ua", email: "ua@x.com", name: null };
    const r = await get(resumeB);
    expect(r.status).toBe(404);
    expect(JSON.stringify(await r.json())).not.toContain("B의 작업");
    expect((await put(resumeB, { document: doc("A가 덮어씀"), baseVersionId: v1B })).status).toBe(404);
    expect((await del(resumeB)).status).toBe(404);
    const rows = await draftRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resumeId: resumeB, userId: "ub" });
    expect(JSON.stringify(rows[0]!.document)).toContain("B의 작업");
  });

  it("응답은 no-store", async () => {
    expect((await get(resumeA)).headers.get("cache-control")).toBe("no-store");
    expect((await put(resumeA, { document: doc(), baseVersionId: v1A })).headers.get("cache-control")).toBe("no-store");
    expect((await get("nope")).headers.get("cache-control")).toBe("no-store");
  });
});

describe("저장·읽기·버리기", () => {
  it("작업본이 없으면 draft null + 현재 버전 id", async () => {
    const r = await get(resumeA);
    expect(r.status).toBe(200);
    expect((await r.json()) as ResumeEditDraftResponse).toEqual({ draft: null, currentVersionId: v1A });
  });

  it("PUT은 새 버전을 만들지 않고 덮어쓰며, GET이 그대로 돌려준다(양식 선택 포함)", async () => {
    const first = (await (await put(resumeA, { document: doc("첫 작업"), baseVersionId: v1A })).json()) as ResumeEditDraftResponse;
    expect(first.draft).toMatchObject({ baseVersionId: v1A, templateId: null });
    expect(first.currentVersionId).toBe(v1A);
    await put(resumeA, { document: doc("둘째 작업"), baseVersionId: v1A, templateId: "classic" });
    const got = (await (await get(resumeA)).json()) as ResumeEditDraftResponse;
    expect(got.draft?.document.basics.name).toBe("둘째 작업");
    expect(got.draft?.templateId).toBe("classic");
    expect(typeof got.draft?.updatedAt).toBe("number");
    expect(await draftRows()).toHaveLength(1);
    expect(await tdb.prisma.resumeVersion.count({ where: { resumeId: resumeA } })).toBe(1);
  });

  it("DELETE로 버린다(없어도 204)", async () => {
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    expect((await del(resumeA)).status).toBe(204);
    expect(await draftRows()).toHaveLength(0);
    expect((await del(resumeA)).status).toBe(204);
  });
});

describe("여러 탭·기기(expectedUpdatedAt)", () => {
  type Clash = { code: string; draftUpdatedAt: number };
  it("다른 탭이 그 사이 작업본을 바꿨으면 409 draft_changed로 거절하고 덮어쓰지 않는다", async () => {
    const tabA = (await (await put(resumeA, { document: doc("A 작업"), baseVersionId: v1A, expectedUpdatedAt: null })).json()) as ResumeEditDraftResponse;
    const atA = tabA.draft!.updatedAt;
    // 탭 B: 작업본이 없을 때 연 화면(expected null) — 이미 A가 만든 작업본을 덮지 않는다
    const b = await put(resumeA, { document: doc("B 작업"), baseVersionId: v1A, expectedUpdatedAt: null });
    expect(b.status).toBe(409);
    expect(b.headers.get("cache-control")).toBe("no-store");
    expect((await b.json()) as Clash).toMatchObject({ code: "draft_changed", draftUpdatedAt: atA });
    // 옛 시각으로도 거절
    expect((await put(resumeA, { document: doc("B 작업"), baseVersionId: v1A, expectedUpdatedAt: atA - 1 })).status).toBe(409);
    expect(JSON.stringify((await draftRows())[0]!.document)).toContain("A 작업");
    // 서버 시각을 알고(덮어쓰기를 고르고) 보내면 받는다
    await new Promise((r) => setTimeout(r, 5));
    const ok = await put(resumeA, { document: doc("B 덮어씀"), baseVersionId: v1A, expectedUpdatedAt: atA });
    expect(ok.status).toBe(200);
    const after = (await ok.json()) as ResumeEditDraftResponse;
    expect(after.draft!.updatedAt).toBeGreaterThan(atA);
    // 이제 A의 시각은 낡았다
    expect((await put(resumeA, { document: doc("A 다시"), baseVersionId: v1A, expectedUpdatedAt: atA })).status).toBe(409);
  });

  it("작업본이 없어졌으면(다른 곳에서 새 버전 저장·버리기) 이 화면의 내용으로 다시 만든다", async () => {
    const first = (await (await put(resumeA, { document: doc("작업"), baseVersionId: v1A, expectedUpdatedAt: null })).json()) as ResumeEditDraftResponse;
    expect((await del(resumeA)).status).toBe(204);
    const r = await put(resumeA, { document: doc("남은 탭"), baseVersionId: v1A, expectedUpdatedAt: first.draft!.updatedAt });
    expect(r.status).toBe(200);
    expect(JSON.stringify((await draftRows())[0]!.document)).toContain("남은 탭");
  });

  it("expectedUpdatedAt을 생략하면 확인하지 않는다(예전 화면 호환)", async () => {
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    expect((await put(resumeA, { document: doc("덮어씀"), baseVersionId: v1A })).status).toBe(200);
  });
});

describe("검증·크기", () => {
  it("문서 스키마를 어기면 400(너무 긴 칸·잘못된 모양·잘못된 양식)", async () => {
    const long = doc("가".repeat(81));
    expect((await put(resumeA, { document: long, baseVersionId: v1A })).status).toBe(400);
    expect((await put(resumeA, { document: { basics: "x" }, baseVersionId: v1A })).status).toBe(400);
    expect((await put(resumeA, { document: doc(), baseVersionId: v1A, templateId: "nope" })).status).toBe(400);
    expect((await put(resumeA, { document: doc() })).status).toBe(400); // baseVersionId 필수(null 허용)
    expect((await put(resumeA, "{not json")).status).toBe(400);
    expect(await draftRows()).toHaveLength(0);
  });

  it("예전 모양(새 필드 없음)의 문서도 보정해 받는다", async () => {
    const old = doc() as unknown as Record<string, unknown>;
    delete old.motivation;
    const r = await put(resumeA, { document: old, baseVersionId: v1A });
    expect(r.status).toBe(200);
    expect(((await r.json()) as ResumeEditDraftResponse).draft?.document.motivation).toBe("");
  });

  it("본문이 버전 저장 한도(512KB)를 넘으면 413", async () => {
    const big = { document: doc(), baseVersionId: v1A, pad: "x".repeat(http.MAX_RESUME_BODY_BYTES) };
    expect((await put(resumeA, big)).status).toBe(413);
    expect(await draftRows()).toHaveLength(0);
  });

  it("기준 버전은 이 이력서의 버전이어야 한다(남의 버전 id면 400)", async () => {
    expect((await put(resumeA, { document: doc(), baseVersionId: v1B })).status).toBe(400);
    expect((await put(resumeA, { document: doc(), baseVersionId: "missing" })).status).toBe(400);
    expect(await draftRows()).toHaveLength(0);
  });

  it("쓰기는 사용자당 분당 120회", async () => {
    for (let i = 0; i < 120; i++) http.resumeDraftWriteLimiter.hit("ua");
    const r = await put(resumeA, { document: doc(), baseVersionId: v1A });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBeTruthy();
  });
});

describe("새 버전 저장과의 관계", () => {
  it("'저장(새 버전)'(POST versions)하면 작업본을 지운다", async () => {
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    const r = await commit(resumeA, { document: doc("작업"), baseVersionId: v1A });
    expect(r.status).toBe(201);
    expect(await draftRows()).toHaveLength(0);
  });

  it("새 버전 저장이 충돌(409)로 취소되면 작업본은 남는다", async () => {
    await service.saveVersion("ua", resumeA, doc("다른 탭"), { source: "manual" });
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    expect((await commit(resumeA, { document: doc("작업"), baseVersionId: v1A })).status).toBe(409);
    expect(await draftRows()).toHaveLength(1);
  });

  it("복원하면 작업본을 지운다", async () => {
    const v2 = await service.saveVersion("ua", resumeA, doc("v2"), { source: "manual" });
    await put(resumeA, { document: doc("작업"), baseVersionId: v2!.id });
    const r = await restoreRoute.POST(new Request(`http://localhost/api/resumes/${resumeA}/versions/${v1A}/restore`, { method: "POST" }), {
      params: Promise.resolve({ id: resumeA, versionId: v1A }),
    });
    expect(r.status).toBe(201);
    expect(await draftRows()).toHaveLength(0);
  });

  it("다른 저장(AI 다듬기 적용 등)은 작업본을 남기고, 읽을 때 currentVersionId가 달라 충돌로 보인다", async () => {
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    const v2 = await service.saveVersion("ua", resumeA, doc("AI 적용"), { source: "ai", note: "AI로 다듬기 · 테스트", baseVersionId: v1A });
    const got = (await (await get(resumeA)).json()) as ResumeEditDraftResponse;
    expect(got.draft?.document.basics.name).toBe("작업");
    expect(got.draft?.baseVersionId).toBe(v1A);
    expect(got.currentVersionId).toBe(v2!.id);
    // 작업본을 이어서 저장해도(옛 기준) 받고, 응답이 충돌을 알린다.
    const again = (await (await put(resumeA, { document: doc("작업 2"), baseVersionId: v1A })).json()) as ResumeEditDraftResponse;
    expect(again.draft?.baseVersionId).toBe(v1A);
    expect(again.currentVersionId).toBe(v2!.id);
    // '유지'(최신 버전으로 기준 옮기기) 뒤에는 충돌이 없고, 새 버전 저장이 최신 위에 쌓인다.
    const kept = (await (await put(resumeA, { document: doc("작업 2"), baseVersionId: v2!.id })).json()) as ResumeEditDraftResponse;
    expect(kept.draft?.baseVersionId).toBe(kept.currentVersionId);
    expect((await commit(resumeA, { document: doc("작업 2"), baseVersionId: v2!.id })).status).toBe(201);
    expect(await draftRows()).toHaveLength(0);
  });
});

describe("목록·삭제", () => {
  it("목록에 hasEditDraft 표시", async () => {
    const other = await service.createResume("ua", { company: "네이버", roleTitle: "백엔드", templateId: "performance", document: doc(), source: "manual" });
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    const list = await service.listResumes("ua");
    expect(list.find((r) => r.id === resumeA)?.hasEditDraft).toBe(true);
    expect(list.find((r) => r.id === other.resume.id)?.hasEditDraft).toBe(false);
    // 남의 작업본은 내 목록에 영향이 없다.
    expect((await service.listResumes("ub")).every((r) => !r.hasEditDraft)).toBe(true);
  });

  it("이력서를 지우거나 탈퇴하면 작업본도 지워진다(FK cascade)", async () => {
    await put(resumeA, { document: doc("작업"), baseVersionId: v1A });
    state.user = { id: "ub", email: "ub@x.com", name: null };
    await put(resumeB, { document: doc("B 작업"), baseVersionId: v1B });
    expect(await draftRows()).toHaveLength(2);
    expect(await service.deleteResume("ua", resumeA)).toBe(true);
    expect((await draftRows()).map((r) => r.resumeId)).toEqual([resumeB]);
    await tdb.prisma.user.delete({ where: { id: "ub" } });
    expect(await draftRows()).toHaveLength(0);
  });
});
