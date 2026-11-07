/** 정규 JSON(키 정렬)과 sha256 — 노드 해시·청크 해시·근거 버전에 쓴다(순수). */
import { createHash } from "node:crypto";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
