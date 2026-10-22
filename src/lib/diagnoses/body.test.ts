import { describe, expect, it } from "vitest";
import { BodyTooLargeError, readBodyLimited, readFormDataLimited } from "./body";

/** Content-Length 없이 조각으로 흘려보내는(chunked) 요청. */
function chunkedRequest(chunks: number, chunkBytes: number, contentType = "application/octet-stream"): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= chunks) return controller.close();
      sent++;
      controller.enqueue(new Uint8Array(chunkBytes));
    },
  });
  return new Request("http://x/api", { method: "POST", body, headers: { "content-type": contentType }, duplex: "half" } as RequestInit);
}

describe("readBodyLimited", () => {
  it("Content-Length가 없어도 한도를 넘는 순간 끊는다", async () => {
    const req = chunkedRequest(1000, 1024);
    expect(req.headers.get("content-length")).toBeNull();
    await expect(readBodyLimited(req, 10 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("선언된 Content-Length가 한도를 넘으면 읽기 전에 거절", async () => {
    const req = new Request("http://x/api", { method: "POST", body: "x", headers: { "content-length": "999999" } });
    await expect(readBodyLimited(req, 10)).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  it("한도 안이면 전부 읽는다", async () => {
    expect((await readBodyLimited(chunkedRequest(3, 100), 1000)).byteLength).toBe(300);
  });

  it("multipart 폼을 읽는다", async () => {
    const fd = new FormData();
    fd.set("targetRole", "백엔드");
    const req = new Request("http://x/api", { method: "POST", body: fd });
    const form = await readFormDataLimited(req, 1024 * 1024);
    expect(form.get("targetRole")).toBe("백엔드");
  });
});
