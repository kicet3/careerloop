/** 포트폴리오 원본: 형식 판별(매직 바이트), 상한, 글 뽑기(이미지·실패는 원본만), 내려줄 때 헤더(HTML은 실행되지 않게). */
import { readFileSync } from "node:fs";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { portfolioOriginalView, portfolioReadable } from "@/lib/domain/portfolios";

vi.mock("server-only", () => ({}));

const original = await import("./original");

const TEXT = "결제 정산 배치를 Kotlin으로 다시 만들었습니다. 처리 시간을 4시간에서 40분으로 줄였습니다.\n".repeat(3);
const enc = (s: string) => new TextEncoder().encode(s);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const WEBP = enc("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const MB = 1024 * 1024;

describe("detectPortfolioFile", () => {
  it("확장자와 매직 바이트가 맞으면 서버가 정한 MIME을 준다", () => {
    expect(original.detectPortfolioFile("a.png", PNG).mime).toBe("image/png");
    expect(original.detectPortfolioFile("a.JPEG", JPG)).toMatchObject({ ext: "jpg", mime: "image/jpeg", image: true });
    expect(original.detectPortfolioFile("a.webp", WEBP).ext).toBe("webp");
    expect(original.detectPortfolioFile("a.pdf", enc("%PDF-1.7\n")).mime).toBe("application/pdf");
    expect(original.detectPortfolioFile("a.htm", enc("<p>x</p>")).ext).toBe("html");
    expect(original.detectPortfolioFile("a.markdown", enc("# x")).ext).toBe("md");
  });

  it("확장자와 내용이 다르거나 모르는 형식이면 415", () => {
    const err = (name: string, b: Uint8Array) => {
      try {
        original.detectPortfolioFile(name, b);
      } catch (e) {
        return (e as { status?: number }).status;
      }
      return null;
    };
    expect(err("a.png", JPG)).toBe(415);
    expect(err("a.pdf", enc("<html>"))).toBe(415);
    expect(err("a.txt", PNG)).toBe(415); // NUL이 있으면 글 파일이 아니다
    expect(err("a.docx", enc("not zip"))).toBe(415);
    expect(err("a.exe", enc("MZ"))).toBe(415);
    expect(err("a.svg", enc("<svg/>"))).toBe(415);
    expect(err("a.gif", enc("GIF89a"))).toBe(415);
  });
});

describe("상한", () => {
  it("파일 상한은 PORTFOLIO_MAX_UPLOAD_MB(기본 30, 1~100)", () => {
    expect(original.portfolioMaxFileBytes({})).toBe(30 * MB);
    expect(original.portfolioMaxFileBytes({ PORTFOLIO_MAX_UPLOAD_MB: "12" })).toBe(12 * MB);
    expect(original.portfolioMaxFileBytes({ PORTFOLIO_MAX_UPLOAD_MB: "999" })).toBe(100 * MB);
    expect(original.portfolioMaxFileBytes({ PORTFOLIO_MAX_UPLOAD_MB: "x" })).toBe(30 * MB);
  });
  it("서버로 바로 받는 상한: Vercel은 4MB, 자체 호스팅은 파일 상한", () => {
    expect(original.portfolioDirectMaxBytes({ VERCEL: "1" })).toBe(4 * MB);
    expect(original.portfolioDirectMaxBytes({})).toBe(30 * MB);
  });
});

describe("ingestPortfolioFile", () => {
  it("글 파일은 글을 뽑는다", async () => {
    const r = await original.ingestPortfolioFile({ name: "a.md", bytes: enc(TEXT) }, MB);
    expect(r.spec.mime).toBe("text/markdown");
    expect(r.text).toContain("40분");
  });

  it("한국어 PDF에서 글을 뽑는다", async () => {
    const bytes = new Uint8Array(readFileSync(path.join(import.meta.dirname, "../ingest/__fixtures__/korean-cid.pdf")));
    const r = await original.ingestPortfolioFile({ name: "포트폴리오.pdf", bytes }, 10 * MB);
    expect(r.spec.mime).toBe("application/pdf");
    expect(r.text.length).toBeGreaterThan(10);
  }, 30_000);

  it("이미지는 글을 뽑지 않고(빈 글) AI가 못 읽는다는 경고를 준다", async () => {
    const r = await original.ingestPortfolioFile({ name: "a.png", bytes: PNG }, MB);
    expect(r.text).toBe("");
    expect(r.warnings.join()).toContain("AI");
  });

  it("글을 뽑지 못한 파일(너무 짧음·손상)은 거절하지 않고 원본만(빈 글 + 경고)", async () => {
    const short = await original.ingestPortfolioFile({ name: "a.txt", bytes: enc("짧음") }, MB);
    expect(short.text).toBe("");
    expect(short.warnings[0]).toContain("원본 파일은 그대로 보관");
    const broken = await original.ingestPortfolioFile({ name: "a.pdf", bytes: enc("%PDF-1.4 broken") }, MB);
    expect(broken.text).toBe("");
  });

  it("크기 초과 413, 빈 파일 400, 형식 거절 415", async () => {
    await expect(original.ingestPortfolioFile({ name: "a.md", bytes: enc(TEXT) }, 10)).rejects.toMatchObject({ status: 413 });
    await expect(original.ingestPortfolioFile({ name: "a.md", bytes: new Uint8Array() }, MB)).rejects.toMatchObject({ status: 400 });
    await expect(original.ingestPortfolioFile({ name: "a.png", bytes: enc(TEXT) }, MB)).rejects.toMatchObject({ status: 415 });
  });
});

describe("originalResponseHeaders", () => {
  const h = (mime: string, download = false, fileName = "포트폴리오 최종.pdf") =>
    original.originalResponseHeaders({ mime, size: 10, fileName, download });

  it("PDF는 inline(브라우저 PDF 보기), nosniff·private no-store, 다른 출처에 끼워 넣지 못한다", () => {
    const x = h("application/pdf");
    expect(x.get("Content-Type")).toBe("application/pdf");
    expect(x.get("Content-Disposition")).toBe(`inline; filename="portfolio.pdf"; filename*=UTF-8''${encodeURIComponent("포트폴리오 최종.pdf")}`);
    expect(x.get("X-Content-Type-Options")).toBe("nosniff");
    expect(x.get("Cache-Control")).toBe("private, no-store");
    expect(x.get("Content-Security-Policy")).toBe("frame-ancestors 'self'");
    expect(x.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
  });

  it("HTML은 text/html로 내려주지 않는다: 첨부 + octet-stream + CSP sandbox", () => {
    const x = h("text/html", false, "a.html");
    expect(x.get("Content-Type")).toBe("application/octet-stream");
    expect(x.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(x.get("Content-Security-Policy")).toMatch(/^sandbox;/);
  });

  it("이미지·글은 inline + sandbox, DOCX·HWP는 첨부, download=1이면 늘 첨부", () => {
    expect(h("image/png").get("Content-Disposition")).toMatch(/^inline;/);
    expect(h("image/png").get("Content-Security-Policy")).toMatch(/^sandbox;/);
    expect(h("text/markdown").get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(h("application/vnd.openxmlformats-officedocument.wordprocessingml.document").get("Content-Disposition")).toMatch(/^attachment;/);
    expect(h("application/x-hwp").get("Content-Disposition")).toMatch(/^attachment;/);
    expect(h("application/pdf", true).get("Content-Disposition")).toMatch(/^attachment;/);
    expect(h("application/pdf", true).get("Content-Security-Policy")).toMatch(/^sandbox;/);
  });

  it("모르는 MIME(DB 값)은 octet-stream 첨부, 파일 이름의 따옴표·줄바꿈은 지운다", () => {
    const x = h("text/javascript", false, 'a"\r\nb.js');
    expect(x.get("Content-Type")).toBe("application/octet-stream");
    expect(x.get("Content-Disposition")).toMatch(/^attachment; filename="portfolio\.bin"; filename\*=UTF-8''a%20b\.js$/);
  });
});

describe("보기 방식·AI 읽기", () => {
  it("MIME → 보기 방식", () => {
    expect(portfolioOriginalView("application/pdf")).toBe("pdf");
    expect(portfolioOriginalView("image/webp")).toBe("image");
    expect(portfolioOriginalView("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(portfolioOriginalView("text/html")).toBe("text");
    expect(portfolioOriginalView("application/zip")).toBe("download");
  });
  it("글을 뽑지 못한 파일(chars 0)은 설명이 없으면 AI가 못 읽는다", () => {
    expect(portfolioReadable({ kind: "file", description: null, chars: 0 })).toBe(false);
    expect(portfolioReadable({ kind: "file", description: "역할", chars: 0 })).toBe(true);
    expect(portfolioReadable({ kind: "file", description: null, chars: null })).toBe(true);
    expect(portfolioReadable({ kind: "url", description: null })).toBe(false);
  });
});

describe("docxToHtmlDocument", () => {
  const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const drawing = `<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="p"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="p"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rImg"/></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
  const docxWithImage = (img: Uint8Array) =>
    zipSync({
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`,
      ),
      "word/media/image1.png": img,
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>본문 글</w:t></w:r></w:p><w:p><w:r>${drawing}</w:r></w:p></w:body></w:document>`,
      ),
    });
  const img = new Uint8Array([...PNG, ...new Uint8Array(2000)]);

  it("그림은 상한 안에서 data URI로 넣는다", async () => {
    const html = await original.docxToHtmlDocument(docxWithImage(img), "a.docx");
    expect(html).toContain("본문 글");
    expect(html).toMatch(/<img src="data:image\/png;base64,/);
    expect(html).not.toContain("미리보기에서 뺐습니다");
  });

  it("그림 합계가 상한을 넘으면 그림을 빼고 안내를 남긴다(응답이 Vercel 4.5MB를 넘지 않게)", async () => {
    const html = await original.docxToHtmlDocument(docxWithImage(img), "a.docx", { maxImageBytes: 100 });
    expect(html).toContain("본문 글");
    expect(html).not.toContain("data:image/png");
    expect(html).toContain("그림 1개는 미리보기에서 뺐습니다");
    expect(original.DOCX_HTML_IMAGE_BUDGET_BYTES).toBeLessThan(original.DOCX_HTML_MAX_BYTES);
    expect(original.DOCX_HTML_MAX_BYTES).toBeLessThan(4.5 * MB);
  });
});
