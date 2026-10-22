/**
 * POST /api/diagnoses의 multipart 폼 → DiagnosisInput. 실패는 IngestError(한국어 메시지)로 던진다.
 *
 * 필드: resumeFile(File) | resumeText(string) 중 하나 필수, targetRole 필수,
 *       jdFile(File) | jdText(string) 선택, situation, notes.
 * 같은 항목에 파일과 붙여넣기가 모두 오면 붙여넣은 텍스트를 우선한다(사용자가 직접 고친 내용일 수 있으므로).
 */
import { DiagnosisInputSchema, SITUATIONS, type DiagnosisInput, type Situation } from "@/lib/domain/schemas";
import { extractText, IngestError, normalizeText } from "@/lib/ingest/extract";
import { MAX_JD_CHARS, MAX_RESUME_CHARS } from "./summary";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
}

function file(form: FormData, key: string): File | null {
  const v = form.get(key);
  return v && typeof v === "object" && "arrayBuffer" in v && v.size > 0 ? (v as File) : null;
}

async function readFile(f: File, label: string, warnings: string[]): Promise<string> {
  try {
    const r = await extractText({ name: f.name, type: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
    warnings.push(...r.warnings.map((w) => `${label}: ${w}`));
    return r.text;
  } catch (err) {
    if (err instanceof IngestError) throw new IngestError(`${label} 파일: ${err.message}`, err.status);
    throw err;
  }
}

export async function parseDiagnosisForm(form: FormData): Promise<{ input: DiagnosisInput; warnings: string[] }> {
  const warnings: string[] = [];

  const targetRole = str(form, "targetRole").trim();
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
    resumeText = await readFile(resumeFile, "이력서", warnings);
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
  else if (jdFile) jdText = await readFile(jdFile, "채용 공고", warnings);
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
  return { input: parsed.data, warnings };
}
