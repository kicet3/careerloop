import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportModel } from "@/lib/report/types";
import { makeSampleDiagnosis, makeSampleStages } from "@/lib/report/__fixtures__/sample";

vi.mock("server-only", () => ({}));
const rendered: ReportModel[] = [];
vi.mock("@/lib/report/pdf", () => ({
  renderReportPdf: async (r: ReportModel) => {
    rendered.push(r);
    await new Promise((res) => setTimeout(res, 5));
    return new Uint8Array([37, 80, 68, 70]);
  },
}));

const { reportPdfResponse, clearPdfCache } = await import("./pdf-response");

beforeEach(() => {
  rendered.length = 0;
  clearPdfCache();
});

describe("reportPdfResponse", () => {
  const found = { diagnosis: makeSampleDiagnosis(), stages: makeSampleStages() };

  it("같은 보고서는 한 번만 렌더링한다(동시 요청 포함), ETag가 같으면 304", async () => {
    const [a, b] = await Promise.all([reportPdfResponse(found, { shared: true }), reportPdfResponse(found, { shared: true })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    await reportPdfResponse(found, { shared: true });
    expect(rendered).toHaveLength(1);

    const etag = a.headers.get("etag")!;
    const notModified = await reportPdfResponse(found, { shared: true, ifNoneMatch: etag });
    expect(notModified.status).toBe(304);
  });

  it("공유 PDF에는 진단 ID를 넣지 않는다", async () => {
    await reportPdfResponse(found, { shared: true });
    await reportPdfResponse(found);
    expect(rendered.map((r) => r.meta.diagnosisId)).toEqual(["", "dg_sample01"]);
  });

  it("실패했지만 부분 보고서가 가능하면 소유자는 PDF를 받고, 공유 링크는 409", async () => {
    const partial = {
      diagnosis: makeSampleDiagnosis({ status: "failed" }),
      stages: makeSampleStages({ omit: ["rewrite", "rescreen"] }),
    };
    expect((await reportPdfResponse(partial)).status).toBe(200);
    expect((await reportPdfResponse(partial, { shared: true })).status).toBe(409);
    const tooEarly = { diagnosis: makeSampleDiagnosis({ status: "failed" }), stages: makeSampleStages({ omit: ["fit"] }) };
    expect((await reportPdfResponse(tooEarly)).status).toBe(409);
  });
});
