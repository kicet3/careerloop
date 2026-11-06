/**
 * 이력서·포트폴리오로 경험 그래프 채우기(기능 A). 그래프 채팅 스레드에 문서를 올리면 LLM이 문서에 글자로 있는 사실만으로
 * 변경안을 만들고, 사용자가 확인해 적용한다(적용 흐름은 그래프 채팅과 같다 — graph-chat.ts).
 *
 * 이 파일: 업로드 폼 해석(parseImportForm), 가져오기 프롬프트(buildGraphImportPrompt), 문서 대조 검증(verifyAgainstDocument).
 * 원본 파일은 저장하지 않는다. 읽어 낸 글만 사용자 메시지 data(DocumentImportData)에 남는다.
 */
import {
  CHAT_TAGS,
  DOC_KINDS,
  type DocKind,
  type DocumentImportData,
  MAX_IMPORT_CHARS,
  MAX_IMPORT_OPS,
} from "@/lib/domain/chat";
import { type CareerGraph, describeGraphOp, type GraphOp, NODE_TITLE_KEY, nodeDisplayName } from "@/lib/domain/graph";
import { FeatureError } from "@/lib/api/errors";
import { extractText, IngestError, MIN_TEXT_LENGTH, normalizeText } from "@/lib/ingest/extract";
import type { UploadLimits } from "@/lib/ingest/upload-limits";
import { STAGE_TASK_DELIMITER } from "@/lib/panel/prompts";
import { canonicalSkill, extractKeywords, skillKey } from "@/lib/skills/dictionary";
import { assessExperienceChecklist, checklistToPromptText } from "@/lib/graph/completeness";
import { graphToText } from "@/lib/graph/text";
import { tokenize } from "@/lib/graph/retrieve";
import { kstToday } from "@/lib/time/kst";
import { modelGuide } from "./graph-guide";
import { field, INJECTION_RULE, wrapData } from "./prompt";

export { MAX_IMPORT_CHARS, MAX_IMPORT_OPS };

/** 프롬프트에 넣는 그래프 요약 상한(문서가 길어 그래프 몫을 줄인다). */
const IMPORT_GRAPH_MAX_CHARS = 8000;

export const DOC_KIND_NAMES: Record<DocKind, string> = { resume: "이력서", portfolio: "포트폴리오" };

// ---------------------------------------------------------------------------
// 폼
// ---------------------------------------------------------------------------

export interface ParsedImport {
  docKind: DocKind;
  fileName: string | null;
  text: string;
  truncated: boolean;
  warnings: string[];
}

/**
 * multipart 폼(file 또는 text, docKind) → 읽어 낸 글. 추출 실패는 IngestError(400·413·415), 입력 없음·너무 짧음은 400.
 * 글은 MAX_IMPORT_CHARS에서 자르고 경고를 남긴다.
 */
export async function parseImportForm(form: FormData, limits: Pick<UploadLimits, "perFileBytes">): Promise<ParsedImport> {
  const kindRaw = form.get("docKind");
  const docKind: DocKind = typeof kindRaw === "string" && (DOC_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as DocKind) : "resume";
  const file = form.get("file");
  const pasted = form.get("text");
  const warnings: string[] = [];
  let text: string;
  let fileName: string | null = null;
  if (file instanceof File && file.size > 0) {
    fileName = file.name.replace(/[\u0000-\u001f]/g, "").slice(0, 200) || "문서";
    const extracted = await extractText(
      { name: file.name, type: file.type, bytes: new Uint8Array(await file.arrayBuffer()) },
      { maxChars: MAX_IMPORT_CHARS + 1000, maxBytes: limits.perFileBytes },
    );
    text = extracted.text;
    warnings.push(...extracted.warnings);
  } else if (typeof pasted === "string" && pasted.trim()) {
    text = normalizeText(pasted);
    if (text.length < MIN_TEXT_LENGTH) throw new IngestError(`내용이 너무 짧습니다. ${MIN_TEXT_LENGTH}자 이상 붙여넣어 주세요.`);
  } else {
    throw new FeatureError("이력서·포트폴리오 파일을 올리거나 내용을 붙여넣어 주세요.", 400);
  }
  const truncated = text.length > MAX_IMPORT_CHARS;
  if (truncated) {
    text = text.slice(0, MAX_IMPORT_CHARS);
    warnings.push(`문서가 길어 앞 ${MAX_IMPORT_CHARS.toLocaleString()}자만 읽었습니다. 나머지는 나눠 붙여넣어 주세요.`);
  }
  return { docKind, fileName, text, truncated, warnings };
}

/** 사용자 메시지(본문·data). 원본 파일은 없고 읽어 낸 글만 data.text에 둔다. */
export function importMessage(p: ParsedImport): { content: string; data: DocumentImportData } {
  const name = p.fileName ? `: ${p.fileName}` : "(붙여넣은 글)";
  return {
    content: `${DOC_KIND_NAMES[p.docKind]}를 올렸습니다${name} (${p.text.length.toLocaleString()}자${p.truncated ? ", 앞부분만" : ""})`,
    data: {
      kind: "document-import",
      docKind: p.docKind,
      fileName: p.fileName,
      text: p.text,
      chars: p.text.length,
      truncated: p.truncated,
      warnings: p.warnings.slice(0, 5),
    },
  };
}

// ---------------------------------------------------------------------------
// 프롬프트
// ---------------------------------------------------------------------------

export const GRAPH_IMPORT_SYSTEM = `너는 한국어 경력 정리 도우미다. 사용자가 올린 이력서·포트폴리오 문서를 읽고 '경험 그래프'에 넣을 변경안을 만든다.
변경안은 사용자가 확인한 뒤에만 적용된다. reply에는 무엇을 정리했는지 짧게 설명한다.

${modelGuide()}

규칙:
1. 문서(<${CHAT_TAGS.resume}> 또는 <${CHAT_TAGS.portfolio}>)에 글자로 있는 사실만 넣는다. 회사명·기간·숫자·직함·학교를 추측하거나 바꿔 쓰지 않는다. 수치는 문서 표기 그대로 옮긴다.
2. 회사 → 직무(기간) → 프로젝트(STAR) → 성과(수치) → 기술 순서로 연결한다: me -WORKED_AT-> Company, me -HAD_ROLE-> Role, Role -AT_COMPANY-> Company, Role -WORKED_ON-> Project, Project -ACHIEVED-> Achievement, Project -USED_SKILL-> Skill. 회사 밖 활동은 Experience(me -HAS_EXPERIENCE->)로 둔다.
3. 학력(me -STUDIED_AT-> Education)과 자격증·어학 점수(me -EARNED-> Certification)도 문서에 있으면 넣는다. 쓴 곳을 알 수 없는 기술은 me -HAS_SKILL->.
4. 중복을 만들지 않는다. <${CHAT_TAGS.careerGraph}>에 같은(또는 표기만 다른) 항목이 이미 있으면 addNode 대신 그 [id]로 updateNode(비어 있던 속성만 보강)나 addEdge를 쓴다.
5. 기존 노드·관계를 지우지 않는다(deleteNode·deleteEdge 금지).
6. 새 노드는 addNode로 만들고 ref를 "new:<영문·숫자>"(변경안 안에서 유일)로 준다. 같은 변경안의 뒤 연산에서 그 ref로 연결한다.
7. 날짜는 YYYY, YYYY-MM, YYYY-MM-DD 형식만 쓴다. 문서에 "현재", "재직 중"이 있으면 Role.current="true"이고 endDate는 비운다.
8. 프로젝트·경험은 situation(상황·목표), action(내 행동), result(결과), learned(배운 점), myRole(내 역할)로 문서 문장을 나눠 넣는다. 문서 내용이 뒷받침할 때만 categories(위 id, 쉼표로 구분, 최대 3개)를 단다.
9. 성과 수치는 Achievement(summary에 한 줄, value에 수치, metric에 지표 이름)로 만들고 그 프로젝트·직무·경험에서 -ACHIEVED->로 잇는다.
10. 문서에 없어 비워 둔 중요한 정보(기간, 성과 수치, 역할)는 followUpQuestions(최대 3개)로 묻는다.
11. 연산은 ${MAX_IMPORT_OPS}개를 넘지 않는다. 넘칠 것 같으면 최근 경력·대표 프로젝트부터 넣는다.
12. 각 연산에서 해당 없는 필드는 "" 또는 []로 둔다. updateNode에는 채울 속성만 넣는다("" 값은 기존 값을 지우므로 넣지 않는다).

${INJECTION_RULE}`;

export function buildGraphImportPrompt(input: {
  graph: CareerGraph;
  doc: Pick<DocumentImportData, "docKind" | "fileName" | "text">;
  today?: Date;
}): { system: string; user: string } {
  const tag = input.doc.docKind === "portfolio" ? CHAT_TAGS.portfolio : CHAT_TAGS.resume;
  const user = [
    field("본인 이름", input.graph.person.name ?? "(모름)"),
    "",
    "현재 경험 그래프([id]로 기존 노드를 가리킨다):",
    wrapData(CHAT_TAGS.careerGraph, graphToText(input.graph, { maxChars: IMPORT_GRAPH_MAX_CHARS })),
    "",
    "경험 체크리스트(빠진 필수 항목부터):",
    wrapData(CHAT_TAGS.experienceChecklist, checklistToPromptText(assessExperienceChecklist(input.graph))),
    STAGE_TASK_DELIMITER,
    field("오늘 날짜", kstToday(input.today ?? Date.now())),
    field("문서 종류", DOC_KIND_NAMES[input.doc.docKind]),
    ...(input.doc.fileName ? [field("파일 이름", input.doc.fileName)] : []),
    "",
    `${DOC_KIND_NAMES[input.doc.docKind]} 원문(여기에 있는 사실만 그래프에 넣는다):`,
    wrapData(tag, input.doc.text),
  ].join("\n");
  return { system: GRAPH_IMPORT_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// 문서 대조 (순수)
// ---------------------------------------------------------------------------

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/'"`]+/g, "");

/** 회사 이름 비교 키: "(주)", "주식회사", "㈜", "(유)", "유한회사"를 떼고 정규화. "㈜페이랩" = "페이랩 주식회사" = "페이랩". */
export function companyKey(name: string): string {
  return norm(name.normalize("NFKC").replace(/\(\s*[주유]\s*\)|주식회사|유한회사|株式会社/g, ""));
}

/** 숫자 토큰(쉼표 제거): "1,200명" → "1200", "0.5%" → "0.5". */
function numbersIn(text: string): string[] {
  return (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((x) => x.replace(/,/g, "")).map((x) => x.replace(/^0+(?=\d)/, ""));
}

/** 이름의 낱말이 문서에 얼마나 있는가(한글 접두 일치 허용). */
function tokenCoverage(name: string, docTokens: readonly string[], docNorm: string): number {
  const tokens = tokenize(name).filter((t) => t.length >= 2);
  if (tokens.length === 0) return docNorm.includes(norm(name)) ? 1 : 0;
  const hit = tokens.filter((t) => docNorm.includes(norm(t)) || docTokens.some((d) => d.startsWith(t))).length;
  return hit / tokens.length;
}

/** 날짜 속성(형식만 맞추고 문서와 대조하지 않는다). */
const DATE_PROP_KEYS = new Set(["startDate", "endDate", "date"]);

/**
 * 문서에 없는 사실을 거른다(LLM이 지어낸 회사·학교·수치). 노드를 빼면 그 ref를 가리키는 뒤 연산은 validateAgainstGraph가
 * 연쇄로 걸러 낸다. 날짜는 형식만 맞추고(toGraphOps) 대조하지 않는다.
 * - 회사·학교·자격증: 대표 이름(회사는 접미사를 뗀 키)이 문서에 부분 문자열로 있어야 한다.
 * - 기술: 사전 정식 명칭이 문서의 기술 키워드에 있거나, 이름이 문서에 그대로 있어야 한다.
 * - 직무·프로젝트·경험: 이름이 문서에 있거나 이름 낱말의 60% 이상이 문서에 있어야 한다(요약한 제목 허용).
 * - 성과: summary·value·metric의 숫자가 모두 문서 숫자에 있어야 한다(숫자가 없으면 낱말 50%).
 * - 숫자(모든 라벨의 addNode·updateNode, 날짜 제외): 속성 값의 숫자가 모두 문서에 있어야 한다. 대표 이름이나 성과 수치가
 *   어긋나면 연산을 빼고, 그 밖의 속성(result·summary·action·teamSize …)은 그 속성만 뺀다. 남은 속성이 없는 updateNode는 뺀다.
 */
export function verifyAgainstDocument(ops: readonly GraphOp[], text: string): { ops: GraphOp[]; dropped: string[] } {
  const docNorm = norm(text);
  const docCompany = companyKey(text);
  const docTokens = tokenize(text);
  const docNumbers = new Set(numbersIn(text));
  const docSkills = new Set(extractKeywords(text).map(skillKey));
  const kept: GraphOp[] = [];
  const dropped: string[] = [];
  const valueNumbersOk = (v: unknown) =>
    (typeof v !== "string" && typeof v !== "number") || numbersIn(String(v)).every((n) => docNumbers.has(n));
  const numbersOk = (props: Record<string, unknown>, keys: readonly string[]) => keys.every((k) => valueNumbersOk(props[k]));

  for (const op of ops) {
    if (op.op !== "addNode" && op.op !== "updateNode") {
      kept.push(op);
      continue;
    }
    const props = op.props as Record<string, unknown>;
    const titleKey = NODE_TITLE_KEY[op.label];
    const title = typeof props[titleKey] === "string" ? (props[titleKey] as string) : "";
    let ok: boolean;
    if (op.op === "updateNode" && op.label !== "Achievement") ok = true;
    else {
      switch (op.label) {
        case "Company":
          ok = (companyKey(title).length > 0 && docCompany.includes(companyKey(title)));
          break;
        case "Education":
        case "Certification":
          ok = (norm(title).length > 0 && docNorm.includes(norm(title)));
          break;
        case "Skill": {
          const canon = canonicalSkill(title);
          ok = (canon !== null && docSkills.has(skillKey(canon))) || (norm(title).length > 0 && docNorm.includes(norm(title)));
          break;
        }
        case "Achievement": {
          const keys = ["summary", "value", "metric"];
          const nums = keys.flatMap((k) => (typeof props[k] === "string" ? numbersIn(props[k] as string) : []));
          ok = numbersOk(props, keys) && (nums.length > 0 || op.op === "updateNode" || tokenCoverage(title, docTokens, docNorm) >= 0.5);
          break;
        }
        default:
          ok = docNorm.includes(norm(title)) || tokenCoverage(title, docTokens, docNorm) >= 0.6;
      }
    }
    // 대표 이름에 문서에 없는 숫자가 있으면 연산째 뺀다.
    if (ok && !valueNumbersOk(props[titleKey])) ok = false;
    if (!ok) {
      dropped.push(`${describeGraphOp(op)} — 문서에서 찾지 못한 항목이라 뺐습니다`);
      continue;
    }
    // 그 밖의 속성: 문서에 없는 숫자가 든 속성만 뺀다(날짜 제외).
    const badKeys = Object.keys(props).filter((k) => k !== titleKey && !DATE_PROP_KEYS.has(k) && !valueNumbersOk(props[k]));
    if (badKeys.length === 0) {
      kept.push(op);
      continue;
    }
    const nextProps = Object.fromEntries(Object.entries(props).filter(([k]) => !badKeys.includes(k)));
    const next = { ...op, props: nextProps } as GraphOp;
    if (op.op === "updateNode" && Object.keys(nextProps).length === 0) {
      dropped.push(`${describeGraphOp(op)} — 문서에 없는 숫자가 있어 뺐습니다`);
      continue;
    }
    dropped.push(`${describeGraphOp(next)}의 ${badKeys.join(", ")} — 문서에 없는 숫자가 있어 그 속성은 뺐습니다`);
    kept.push(next);
  }
  return { ops: kept, dropped };
}

/**
 * 가져오기 변경안의 updateNode가 기존 값을 지우거나 덮어쓰지 않게 한다(비어 있던 속성만 보강).
 * - null(속성 지우기)은 뺀다.
 * - 기존 노드에 값이 있는 속성은 뺀다. 소재 분류(categories)만 예외로, 기존 태그 + 새 태그로 바꿔 보낸다(태그를 빼지 않는다).
 * - 남은 속성이 없으면 연산을 빼고 알린다. 그래프에 없는 id는 그대로 둔다(validateAgainstGraph가 거른다).
 */
export function guardImportUpdates(ops: readonly GraphOp[], graph: CareerGraph): { ops: GraphOp[]; dropped: string[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const kept: GraphOp[] = [];
  const dropped: string[] = [];
  for (const op of ops) {
    if (op.op !== "updateNode") {
      kept.push(op);
      continue;
    }
    const node = byId.get(op.id);
    const cur = (node?.props ?? {}) as Record<string, unknown>;
    const props = op.props as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    const removed: string[] = [];
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined) {
        removed.push(k);
        continue;
      }
      if (k === "categories" && Array.isArray(v)) {
        const stored = Array.isArray(cur.categories) ? cur.categories : [];
        next[k] = [...stored, ...v.filter((t) => !stored.includes(t))];
        continue;
      }
      const has = cur[k];
      if (has !== undefined && has !== null && has !== "" && !(Array.isArray(has) && has.length === 0)) {
        removed.push(k);
        continue;
      }
      next[k] = v;
    }
    if (removed.length === 0) {
      kept.push(op);
      continue;
    }
    const where = node ? `'${nodeDisplayName(node)}'` : op.id;
    if (Object.keys(next).length === 0) {
      dropped.push(`${where} 수정 — 문서 가져오기는 기존 값을 지우거나 덮어쓰지 않아 뺐습니다`);
      continue;
    }
    dropped.push(`${where}의 ${removed.join(", ")} — 문서 가져오기는 기존 값을 지우거나 덮어쓰지 않아 뺐습니다`);
    kept.push({ ...op, props: next } as GraphOp);
  }
  return { ops: kept, dropped };
}

/** 가져오기 변경안에서 삭제 연산을 뺀다(기존 노드·관계를 지우지 않는다). */
export function dropDeletes(ops: readonly GraphOp[], graph: CareerGraph | null): { ops: GraphOp[]; dropped: string[] } {
  const kept: GraphOp[] = [];
  const dropped: string[] = [];
  for (const op of ops) {
    if (op.op === "deleteNode" || op.op === "deleteEdge") dropped.push(`${describeGraphOp(op, graph)} — 문서 가져오기에서는 지우지 않습니다`);
    else kept.push(op);
  }
  return { ops: kept, dropped };
}
