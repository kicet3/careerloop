/**
 * HWP 5.x(한글 2002 이후 바이너리) 본문 텍스트 추출. CareerLoop(src/server/extractHwp.ts)에서 가져옴.
 * 고친 점: HWP 3.x·암호·배포용·DRM을 각각 한국어로 안내, 공인인증서 DRM 플래그 비트 정정(512→1024),
 * 압축 해제 남은 한도가 0일 때의 RangeError를 413으로 변환, 글자 상한에 닿으면 더 읽지 않음.
 * 형식 참고: 한컴 HWP 5.0 문서 구조(https://tech.hancom.com/python-hwp-parsing-2/).
 */

import * as CFB from "cfb";
import { inflateRawSync } from "node:zlib";
import { IngestError } from "./errors";

/** 압축 해제한 본문(BodyText/Section*) 합계 상한(zip bomb 방지). */
export const MAX_HWP_BODY_BYTES = 32 * 1024 * 1024;

const CFB_MAGIC = "d0cf11e0a1b11ae1";
const HWPTAG_PARA_TEXT = 67;
/** 확장·인라인 제어 문자: 코드 1개 + 부가 정보 7개 = 8 WCHAR(16바이트)를 차지한다. */
const EXTENDED_CONTROLS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);

/** FileHeader 속성 비트 */
const FLAG_COMPRESSED = 1 << 0;
const FLAG_PASSWORD = 1 << 1;
const FLAG_DISTRIBUTION = 1 << 2;
const FLAG_DRM = 1 << 4;
const FLAG_CERT_ENCRYPTED = 1 << 8;
const FLAG_CERT_DRM = 1 << 10;

const broken = (detail: string) => new IngestError(`HWP ${detail} 파일이 손상되었을 수 있습니다. PDF로 내보내 다시 올려 주세요.`);

/** 섹션 스트림(압축 해제 후)의 레코드에서 문단 텍스트(PARA_TEXT, UTF-16LE)만 읽는다. */
export function readHwpSection(section: Buffer, maxChars = Infinity): string {
  const paragraphs: string[] = [];
  let chars = 0;
  let offset = 0;
  while (offset < section.length && chars <= maxChars) {
    if (offset + 4 > section.length) throw broken("레코드 머리가 잘렸습니다.");
    const header = section.readUInt32LE(offset);
    offset += 4;
    const tag = header & 0x3ff;
    let size = header >>> 20;
    if (size === 0xfff) {
      if (offset + 4 > section.length) throw broken("확장 레코드가 잘렸습니다.");
      size = section.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > section.length) throw broken("본문 길이가 올바르지 않습니다.");
    if (tag === HWPTAG_PARA_TEXT) {
      if (size % 2) throw broken("문단 텍스트 길이가 올바르지 않습니다.");
      const units: number[] = [];
      for (let position = offset; position < offset + size; position += 2) {
        const code = section.readUInt16LE(position);
        if (code >= 32) units.push(code);
        else if (code === 10 || code === 13) units.push(10);
        else if (code === 24 || code === 30 || code === 31) units.push(32); // 하이픈·묶음 빈칸·고정폭 빈칸
        else if (EXTENDED_CONTROLS.has(code)) {
          if (position + 16 > offset + size) throw broken("제어 문자가 잘렸습니다.");
          if (code === 9) units.push(32); // 탭
          position += 14;
        }
      }
      const text = Buffer.alloc(units.length * 2);
      units.forEach((unit, index) => text.writeUInt16LE(unit, index * 2));
      const paragraph = text.toString("utf16le");
      paragraphs.push(paragraph);
      chars += paragraph.length;
    }
    offset += size;
  }
  return paragraphs.join("\n");
}

/** HWP 파일 전체에서 본문 텍스트를 뽑는다. 읽을 수 없는 종류는 이유를 담은 IngestError. */
export function extractHwp(bytes: Uint8Array, maxChars = Infinity): string {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.subarray(0, 8).toString("hex") !== CFB_MAGIC) {
    // HWP 3.x(한글 97 이전)는 CFB가 아니라 "HWP Document File V3.00" 문자열로 시작한다.
    if (buffer.toString("latin1", 0, 32).startsWith("HWP Document File V3")) {
      throw new IngestError(
        "HWP 3.x(한글 97 이전) 형식은 읽을 수 없습니다. 한글에서 HWPX 또는 PDF로 다시 저장해 올려 주세요.",
        415,
      );
    }
    throw new IngestError("HWP 파일이 아닙니다. 한글에서 HWPX 또는 PDF로 내보내 다시 올려 주세요.", 415);
  }

  let container: CFB.CFB$Container;
  try {
    container = CFB.read(buffer, { type: "buffer" });
  } catch {
    throw broken("파일 구조를 읽지 못했습니다.");
  }
  const entry = CFB.find(container, "FileHeader");
  const header = entry?.content ? Buffer.from(entry.content as Uint8Array) : null;
  if (!header || header.length < 40 || !header.toString("ascii", 0, 17).startsWith("HWP Document File")) {
    throw new IngestError("올바른 HWP 문서가 아닙니다. 한글에서 HWPX 또는 PDF로 내보내 다시 올려 주세요.", 415);
  }
  if (header[35] !== 5) {
    throw new IngestError("HWP 5.x 형식만 읽을 수 있습니다. 한글에서 HWPX 또는 PDF로 다시 저장해 올려 주세요.", 415);
  }
  const flags = header.readUInt32LE(36);
  if (flags & (FLAG_PASSWORD | FLAG_CERT_ENCRYPTED)) {
    throw new IngestError("암호가 걸린 HWP는 읽을 수 없습니다. 한글에서 암호를 해제하거나 PDF로 내보내 올려 주세요.", 415);
  }
  if (flags & FLAG_DISTRIBUTION) {
    throw new IngestError("배포용 HWP는 본문이 암호화되어 읽을 수 없습니다. 원본 문서를 PDF로 내보내 올려 주세요.", 415);
  }
  if (flags & (FLAG_DRM | FLAG_CERT_DRM)) {
    throw new IngestError("DRM 보안이 걸린 HWP는 읽을 수 없습니다. 보안을 해제한 문서를 PDF로 내보내 올려 주세요.", 415);
  }

  const sections = container.FullPaths.map((path, index) => ({ path, entry: container.FileIndex[index] }))
    .filter(({ path }) => /\/BodyText\/Section\d+$/i.test(path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  if (!sections.length) throw broken("본문(BodyText)을 찾지 못했습니다.");

  const tooBig = () =>
    new IngestError("HWP 본문을 풀면 너무 커집니다. 본문만 PDF로 내보내 다시 올려 주세요.", 413);
  const texts: string[] = [];
  let bytesRead = 0;
  let chars = 0;
  for (const { entry: sectionEntry } of sections) {
    if (chars > maxChars) break;
    const content = Buffer.from((sectionEntry.content as Uint8Array | undefined) ?? []);
    const remaining = MAX_HWP_BODY_BYTES - bytesRead;
    if (remaining <= 0) throw tooBig();
    let section: Buffer;
    if (flags & FLAG_COMPRESSED) {
      try {
        // remaining+1바이트까지만 풀어, 그만큼 나오면 상한 초과로 본다.
        section = inflateRawSync(content, { maxOutputLength: remaining + 1 });
      } catch (e) {
        if (e instanceof RangeError || (e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw tooBig();
        throw broken("본문 압축을 풀지 못했습니다.");
      }
    } else {
      section = content;
    }
    bytesRead += section.length;
    if (bytesRead > MAX_HWP_BODY_BYTES) throw tooBig();
    const text = readHwpSection(section, maxChars - chars);
    texts.push(text);
    chars += text.length;
  }
  return texts.join("\n\n");
}
