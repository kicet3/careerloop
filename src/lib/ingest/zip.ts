/**
 * ZIP(DOCX·HWPX) 안전 읽기. 중앙 디렉터리의 선언 크기는 거짓일 수 있으므로 각 항목을 maxOutputLength를 건
 * inflate로 실제로 풀어 보고 상한을 넘는 순간 멈춘다(zip bomb 방지). ZIP64·암호화 항목은 받지 않는다.
 * 실패는 호출부가 형식 이름을 붙여 안내할 수 있게 ZipLimitError로 던진다.
 */

import { inflateRawSync } from "node:zlib";

export type ZipFailure = "too-big" | "broken" | "encrypted";

export class ZipLimitError extends Error {
  constructor(readonly reason: ZipFailure) {
    super(`zip: ${reason}`);
    this.name = "ZipLimitError";
  }
}

export interface ZipLimits {
  /** 항목 하나의 압축 해제 크기 상한 */
  maxEntryBytes: number;
  /** 모든 항목 압축 해제 크기 합계 상한 */
  maxTotalBytes: number;
  maxEntries: number;
}

/**
 * 모든 항목을 실제로 풀어 크기를 확인하고, keep이 참인 항목의 풀린 내용을 이름별로 돌려준다.
 * keep을 주지 않으면 크기 검사만 한다.
 */
export function readZipWithinLimits(
  bytes: Uint8Array,
  limits: ZipLimits,
  keep: (name: string) => boolean = () => false,
): Map<string, Buffer> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (reason: ZipFailure) => new ZipLimitError(reason);

  // End of central directory 레코드: 파일 끝에서 22 + 최대 65535(주석)바이트 안에 있다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw fail("broken");
  const entries = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw fail("too-big"); // ZIP64는 받지 않는다
  if (entries > limits.maxEntries) throw fail("too-big");
  if (cdOffset + cdSize > buf.length) throw fail("broken");

  const kept = new Map<string, Buffer>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw fail("broken");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const declared = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLen > buf.length) throw fail("broken");
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 1) throw fail("encrypted");
    if (compSize === 0xffffffff || declared === 0xffffffff || localOffset === 0xffffffff) throw fail("too-big");
    if (declared > limits.maxEntryBytes) throw fail("too-big");
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) throw fail("broken");
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (dataStart + compSize > buf.length) throw fail("broken");

    const limit = Math.min(limits.maxEntryBytes, limits.maxTotalBytes - total);
    if (limit <= 0 && compSize > 0) throw fail("too-big");
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data: Buffer;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      try {
        // limit+1바이트까지만 풀도록 해서, 그만큼 나오면 상한 초과로 본다.
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, limit + 1) });
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw fail("too-big");
        throw fail("broken");
      }
    } else {
      throw fail("broken");
    }
    if (data.byteLength > limit) throw fail("too-big");
    total += data.byteLength;
    if (keep(name)) kept.set(name, Buffer.from(data));
  }
  return kept;
}
