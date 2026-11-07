/**
 * 이력서별 '사진 넣기'(company_resumes.include_photo, PGlite + 로컬 저장소, 세션은 가짜):
 * 새 이력서는 켜짐(사진이 있으면 들어감), PATCH로 끄고 켠다, PDF 라우트는 켜져 있고 세션 사용자의 사진이 있을 때만 넣는다.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";
import { makeSampleResume } from "./__fixtures__/sample";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ user: { id: "ua" } as { id: string } | null }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));

let tdb: TestDb;
let resumes: typeof import("./service");
let photo: typeof import("@/lib/account/photo");
let pdfRoute: typeof import("@/app/api/resumes/[id]/pdf/route");
let itemRoute: typeof import("@/app/api/resumes/[id]/route");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-include-photo-")), "storage");
  tdb = await createTestDb();
  resumes = await import("./service");
  photo = await import("@/lib/account/photo");
  pdfRoute = await import("@/app/api/resumes/[id]/pdf/route");
  itemRoute = await import("@/app/api/resumes/[id]/route");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  state.user = { id: "ua" };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const hasImage = async (res: Response) => /\/Subtype\s*\/Image/.test(Buffer.from(await res.arrayBuffer()).toString("latin1"));
const patch = (id: string, body: unknown) =>
  itemRoute.PATCH(new Request(`http://localhost/api/resumes/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx(id));

describe("사진 넣기", () => {
  it("새 이력서는 켜짐, PATCH로 끄고 켠다(남의 이력서는 404)", async () => {
    const { resume } = await resumes.createResume("ua", { templateId: "classic", document: emptyResumeDocument(), source: "manual", company: "a", roleTitle: "b" });
    expect(resume.includePhoto).toBe(true);
    const off = await patch(resume.id, { includePhoto: false });
    expect(((await off.json()) as { resume: { includePhoto: boolean } }).resume.includePhoto).toBe(false);
    expect((await patch(resume.id, { includePhoto: "no" })).status).toBe(400);
    state.user = { id: "ub" };
    expect((await patch(resume.id, { includePhoto: true })).status).toBe(404);
    expect((await resumes.getResumeMeta("ua", resume.id))!.includePhoto).toBe(false);
  });

  it("복제는 원본의 '사진 넣기' 값을 이어받는다(끈 이력서를 복제해도 사진이 다시 켜지지 않는다)", async () => {
    const { resume } = await resumes.createResume("ua", { templateId: "classic", document: emptyResumeDocument(), source: "manual", company: "a", roleTitle: "b" });
    await patch(resume.id, { includePhoto: false });
    const off = await resumes.copyResume("ua", resume.id, { kind: "company", company: "c", roleTitle: "d" });
    expect(off!.resume.includePhoto).toBe(false);
    await patch(resume.id, { includePhoto: true });
    const on = await resumes.copyResume("ua", resume.id, { kind: "general" });
    expect(on!.resume.includePhoto).toBe(true);
  });

  it("PDF: 켜져 있고 사진이 있을 때만 머리글에 넣는다, 다른 사용자의 사진은 쓰지 않는다", async () => {
    const { resume } = await resumes.createResume("ua", { templateId: "performance", document: makeSampleResume(), source: "manual", company: "a", roleTitle: "b" });
    const pdf = () => pdfRoute.GET(new Request(`http://localhost/api/resumes/${resume.id}/pdf`), ctx(resume.id));

    // 사진 없음
    expect(await hasImage(await pdf())).toBe(false);
    // 다른 사용자(ub)만 사진이 있다 — ua의 PDF에는 들어가지 않는다
    const jpeg = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#456" } }).jpeg().toBuffer();
    await photo.setProfilePhoto("ub", jpeg);
    expect(await hasImage(await pdf())).toBe(false);
    // ua 사진 → 들어간다
    await photo.setProfilePhoto("ua", jpeg);
    expect(await hasImage(await pdf())).toBe(true);
    // 끄면 빠진다
    await resumes.updateResumeMeta("ua", resume.id, { includePhoto: false });
    expect(await hasImage(await pdf())).toBe(false);
    // 남의 이력서 PDF는 404
    state.user = { id: "ub" };
    expect((await pdf()).status).toBe(404);
  }, 60_000);

  it("제출 사본 PDF: 사본을 만들 때 '사진 넣기'가 켜져 있었으면 세션 사용자 자신의 사진을 넣는다", async () => {
    const apps = await import("@/lib/applications/service");
    const submittedPdf = await import("@/app/api/applications/[id]/submitted/pdf/route");
    const { ApplicationCreateInputSchema } = await import("@/lib/domain/applications");
    const jpeg = await sharp({ create: { width: 300, height: 400, channels: 3, background: "#456" } }).jpeg().toBuffer();
    await photo.setProfilePhoto("ua", jpeg);

    const on = (await resumes.createResume("ua", { templateId: "classic", document: makeSampleResume(), source: "manual", company: "a", roleTitle: "b" })).resume;
    const off = (await resumes.createResume("ua", { templateId: "classic", document: makeSampleResume(), source: "manual", company: "c", roleTitle: "d" })).resume;
    await resumes.updateResumeMeta("ua", off.id, { includePhoto: false });
    const appOn = await apps.createApplication("ua", ApplicationCreateInputSchema.parse({ company: "a", roleTitle: "b" }));
    const appOff = await apps.createApplication("ua", ApplicationCreateInputSchema.parse({ company: "c", roleTitle: "d" }));
    await apps.freezeSubmittedCopy("ua", appOn.id, on.id, null);
    await apps.freezeSubmittedCopy("ua", appOff.id, off.id, null);
    const get = (id: string) => submittedPdf.GET(new Request(`http://localhost/api/applications/${id}/submitted/pdf`), ctx(id));

    expect((await apps.getSubmittedCopy("ua", appOn.id))!.includePhoto).toBe(true);
    expect(await hasImage(await get(appOn.id))).toBe(true);
    expect(await hasImage(await get(appOff.id))).toBe(false);
    // 사진을 지우면 사본 PDF에서도 빠진다(사진은 고정하지 않는다).
    await photo.deleteProfilePhoto("ua");
    expect(await hasImage(await get(appOn.id))).toBe(false);
    // 남의 지원 기록은 404
    state.user = { id: "ub" };
    expect((await get(appOn.id)).status).toBe(404);
  }, 60_000);
});
