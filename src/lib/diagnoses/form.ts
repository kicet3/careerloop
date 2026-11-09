/**
 * POST /api/diagnoses의 multipart 폼 → DiagnosisInput. 실패는 IngestError(한국어 메시지)로 던진다.
 *
 * 필드: resumeFile(File) | resumeText(string) 중 하나 필수, targetRole 필수,
 *       jdFile(File) | jdText(string) 선택, situation, notes, provider(엔진 id, 선택 — 검증은 라우트가 한다),
 *       portfolioFile(File) · portfolioText(string, 링크·설명) 선택 — 둘 다 오면 합친다.
 *       postingId(보관 공고 id, 선택 — 소유권 확인은 라우트가 한다). JD·직무가 비면 그 공고의 JD 원문·직무를 쓴다.
 * 이력서·JD는 같은 항목에 파일과 붙여넣기가 모두 오면 붙여넣은 텍스트를 우선한다(사용자가 직접 고친 내용일 수 있으므로).
 */
import { DiagnosisInputSchema, SITUATIONS, type DiagnosisInput, type Situation } from "@/lib/domain/schemas";
import { extractText, IngestError, normalizeText } from "@/lib/ingest/extract";
import { hasPdfSignature, PDF_SIGNATURE_SCAN_BYTES, PORTFOLIO_NOT_PDF_CONTENT_MESSAGE, PORTFOLIO_PDF_ONLY_MESSAGE } from "@/lib/domain/portfolios";
import { MAX_JD_CHARS, MAX_RESUME_CHARS } from "./summary";

/** 포트폴리오(파일 추출 텍스트 + 붙여넣은 링크·설명) 합계 상한. 넘친 파일 텍스트는 잘라 쓴다. */
export const MAX_PORTFOLIO_CHARS = 20_000;
/** 붙여넣은 포트폴리오 링크·설명 상한. 넘으면 거절한다(사용자가 직접 줄일 수 있으므로). */
export const MAX_PORTFOLIO_NOTE_CHARS = 5_000;
/** 파일 텍스트와 붙여넣은 설명을 합칠 때 사이에 넣는 표시. */
export const PORTFOLIO_NOTE_SEPARATOR = "\n\n--- 지원자가 덧붙인 링크·설명 ---\n";

/** 포트폴리오 입력. 이력서와 별개 자료라 DiagnosisInput(고정 계약)과 따로 둔다. 없으면 둘 다 null. */
export type DiagnosisPortfolio = { portfolioText: string | null; portfolioFileName: string | null };
export type DiagnosisFormInput = DiagnosisInput & DiagnosisPortfolio;

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function file(form: FormData, key: string): File | null {
  const v = form.get(key);
  return v && typeof v === "object" && "arrayBuffer" in v && v.size > 0 ? (v as File) : null;
}

async function readFile(f: File, label: string, warnings: string[], maxChars: number): Promise<string> {
  try {
    // maxChars를 조금 넘게 읽으면 멈춘다(넘친 결과는 아래 길이 검사가 거절한다).
    const r = await extractText(
      { name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) },
      { maxChars: maxChars + 1000 },
    );
    warnings.push(...r.warnings.map((w) => `${label}: ${w}`));
    return r.text;
  } catch (err) {
    if (err instanceof IngestError) throw new IngestError(`${label} 파일: ${err.message}`, err.status);
    throw err;
  }
}

/** 이 진단에 쓸 보관 공고 id(비어 있으면 null). 소유권 확인과 공고 조회는 라우트가 한다. */
export function requestedPostingId(form: FormData): string | null {
  const id = str(form, "postingId").trim();
  return id && id.length <= 64 ? id : null;
}

/** 보관 공고에서 가져올 기본값(JD·직무를 비워 보냈을 때). */
export interface DiagnosisPostingDefaults {
  jdText: string;
  roleTitle: string;
}

/** 요청한 엔진 id(비어 있으면 null). 값 검증은 providers/options.ts resolveRequestedProvider. */
export function requestedProvider(form: FormData): string | null {
  return str(form, "provider").trim() || null;
}

/**
 * 포트폴리오(선택). 파일은 이력서와 같은 추출기로 읽고, 길면 앞부분만 쓰며 경고를 남긴다.
 * 붙여넣은 링크·설명은 MAX_PORTFOLIO_NOTE_CHARS를 넘으면 거절한다.
 */
async function parsePortfolio(form: FormData, warnings: string[]): Promise<DiagnosisPortfolio> {
  const note = normalizeText(str(form, "portfolioText"));
  if (note.length > MAX_PORTFOLIO_NOTE_CHARS) {
    throw new IngestError(
      `포트폴리오 링크·설명은 ${MAX_PORTFOLIO_NOTE_CHARS.toLocaleString("ko-KR")}자 이내로 입력해 주세요. 긴 내용은 파일로 올려 주세요.`,
    );
  }
  const f = file(form, "portfolioFile");
  // 보관함·이력서 첨부에서 가져온 포트폴리오는 이미 뽑아 둔 글이라 파일이 아니라 글로 받는다(새로 올리는 파일만 PDF로 제한).
  const stored = normalizeText(str(form, "portfolioStoredText"));
  let fileText = "";
  let portfolioFileName: string | null = null;
  if (f) {
    // 새로 올리는 포트폴리오 파일은 PDF만(확장자 + 파일 앞부분의 %PDF- 표식). 보관함 업로드와 같은 규칙.
    if (!f.name.toLowerCase().endsWith(".pdf")) throw new IngestError(PORTFOLIO_PDF_ONLY_MESSAGE, 415);
    const head = new Uint8Array(await f.slice(0, PDF_SIGNATURE_SCAN_BYTES).arrayBuffer());
    if (!hasPdfSignature(head)) throw new IngestError(PORTFOLIO_NOT_PDF_CONTENT_MESSAGE, 415);
    fileText = await readFile(f, "포트폴리오", warnings, MAX_PORTFOLIO_CHARS);
    portfolioFileName = f.name.slice(0, 255) || null;
  } else if (stored) {
    fileText = stored.length > MAX_PORTFOLIO_CHARS + 1000 ? stored.slice(0, MAX_PORTFOLIO_CHARS + 1000) : stored;
    portfolioFileName = str(form, "portfolioStoredName").trim().slice(0, 255) || null;
  }
  if (fileText) {
    const room = MAX_PORTFOLIO_CHARS - (note ? note.length + PORTFOLIO_NOTE_SEPARATOR.length : 0);
    if (fileText.length > room) {
      fileText = fileText.slice(0, room).trimEnd();
      warnings.push(
        `포트폴리오가 길어 앞부분 ${room.toLocaleString("ko-KR")}자만 심사에 반영합니다. 지원 직무와 관련 있는 부분을 앞에 두면 좋습니다.`,
      );
    }
  }
  if (!fileText && !note) return { portfolioText: null, portfolioFileName: null };

  if (!fileText) {
    // 링크만 있으면 심사위원(모델)은 링크 내용을 열어 보지 못한다.
    const withoutUrls = note.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, "");
    if (withoutUrls.length < 30) {
      warnings.push(
        "포트폴리오 링크는 심사위원이 직접 열어 보지 못합니다. 프로젝트 내용·역할·결과를 몇 줄 설명으로 함께 적거나 파일로 올려 주세요.",
      );
    }
  }
  const portfolioText = fileText && note ? `${fileText}${PORTFOLIO_NOTE_SEPARATOR}${note}` : fileText || note;
  return { portfolioText, portfolioFileName };
}

export async function parseDiagnosisForm(
  form: FormData,
  opts: { posting?: DiagnosisPostingDefaults | null } = {},
): Promise<{ input: DiagnosisFormInput; warnings: string[] }> {
  const warnings: string[] = [];

  const targetRole = str(form, "targetRole").trim() || (opts.posting?.roleTitle.trim().slice(0, 200) ?? "");
  if (!targetRole) throw new IngestError("지원 직무를 입력해 주세요.");
  if (targetRole.length > 200) throw new IngestError("지원 직무는 200자 이내로 입력해 주세요.");

  // 이력서
  const resumePasted = normalizeText(str(form, "resumeText"));
  const resumeFile = file(form, "resumeFile");
  let resumeText: string;
  let resumeFileName: string | null = null;
  if (resumePasted) {
    resumeText = resumePasted;
  } else if (resumeFile) {
    resumeText = await readFile(resumeFile, "이력서", warnings, MAX_RESUME_CHARS);
    resumeFileName = resumeFile.name.slice(0, 255) || null;
  } else {
    throw new IngestError("이력서 파일을 올리거나 이력서 내용을 붙여넣어 주세요.");
  }
  if (resumeText.length < 50) {
    throw new IngestError("이력서 내용이 너무 짧습니다. 이력서 전체를 붙여넣어 주세요.");
  }
  if (resumeText.length > MAX_RESUME_CHARS) {
    throw new IngestError(
      `이력서가 너무 깁니다(${resumeText.length.toLocaleString("ko-KR")}자). ${MAX_RESUME_CHARS.toLocaleString("ko-KR")}자 이내로 줄여 주세요.`,
    );
  }

  // JD(선택)
  const jdPasted = normalizeText(str(form, "jdText"));
  const jdFile = file(form, "jdFile");
  let jdText: string | null = null;
  if (jdPasted) jdText = jdPasted;
  else if (jdFile) jdText = await readFile(jdFile, "채용 공고", warnings, MAX_JD_CHARS);
  else if (opts.posting?.jdText.trim()) jdText = normalizeText(opts.posting.jdText);
  if (jdText && jdText.length > MAX_JD_CHARS) {
    throw new IngestError(
      `채용 공고가 너무 깁니다(${jdText.length.toLocaleString("ko-KR")}자). 직무 설명·자격 요건 부분만 ${MAX_JD_CHARS.toLocaleString("ko-KR")}자 이내로 붙여넣어 주세요.`,
    );
  }
  if (jdText && jdText.length < 30) {
    warnings.push("채용 공고가 매우 짧습니다. 자격 요건·우대 사항까지 붙여넣으면 분석이 정확해집니다.");
  }

  const situationRaw = str(form, "situation").trim();
  const situation: Situation = (SITUATIONS as readonly string[]).includes(situationRaw)
    ? (situationRaw as Situation)
    : "general";

  const notes = normalizeText(str(form, "notes"));
  if (notes.length > 2000) throw new IngestError("메모는 2,000자 이내로 입력해 주세요.");

  const parsed = DiagnosisInputSchema.safeParse({
    resumeText,
    resumeFileName,
    targetRole,
    jdText,
    situation,
    notes: notes || null,
  });
  if (!parsed.success) throw new IngestError("입력값을 확인해 주세요.");

  const portfolio = await parsePortfolio(form, warnings);
  return { input: { ...parsed.data, ...portfolio }, warnings };
}
