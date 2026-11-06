/**
 * 저장소 정보(RepoFacts) → AI에 넣는 한국어 요약(brief, 순수). 프롬프트에서는 wrapData(CHAT_TAGS.githubRepo, brief)로 감싼다.
 * verifyAgainstDocument(문서 대조)도 이 글을 근거로 쓴다 — brief에 글자로 없는 기술·수치는 변경안에서 빠진다.
 * 규칙을 바꾸면 BRIEF_BUILDER_VERSION을 올린다(저장해 둔 data로 brief를 다시 만든다).
 */
import type { RepoFacts } from "./types";

export const BRIEF_BUILDER_VERSION = 1;
export const MAX_BRIEF_CHARS = 12_000;
export const MAX_README_CHARS = 6000;
export const BRIEF_PREVIEW_CHARS = 1500;

/**
 * README 원문 정리: HTML 주석·이미지·배지·태그를 지우고, 링크는 글자만 남기고, 제어 문자를 빼고, 빈 줄을 줄인 뒤 MAX_README_CHARS에서 자른다.
 * 원문의 지시문은 그대로 남을 수 있다 — 프롬프트에서 데이터로만 다룬다(INJECTION_RULE).
 */
export function sanitizeReadme(raw: string): string {
  let s = raw.replace(/\r\n?/g, "\n");
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  // 배지: [![alt](img)](link), 이미지: ![alt](img), 참조형 이미지: ![alt][ref]
  s = s.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, "");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  s = s.replace(/!\[[^\]]*\]\[[^\]]*\]/g, "");
  // 참조 정의 줄: [ref]: https://…
  s = s.replace(/^\s*\[[^\]]+\]:\s*\S+.*$/gm, "");
  // 링크는 글자만
  s = s.replace(/\[([^\]]*)\]\((?:[^)]*)\)/g, "$1");
  // HTML 태그(img·a·details …)
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, "");
  s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "");
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > MAX_README_CHARS ? `${s.slice(0, MAX_README_CHARS)}…(이하 생략)` : s;
}

const day = (iso: string | null | undefined) => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

export function buildRepoBrief(f: RepoFacts): string {
  const flags = [f.private ? "비공개 — 이용자가 허용한 비공개 저장소" : null, f.fork ? "포크" : null, f.archived ? "보관됨" : null].filter(Boolean);
  const lines: string[] = [];
  lines.push(`저장소: ${f.fullName}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  lines.push(`주소: ${f.htmlUrl}`);
  if (f.description) lines.push(`설명: ${f.description}`);
  if (f.topics.length) lines.push(`주제: ${f.topics.join(", ")}`);
  if (f.homepage) lines.push(`홈페이지: ${f.homepage}`);
  if (f.license && f.license !== "NOASSERTION") lines.push(`라이선스: ${f.license}`);
  if (f.languages.length) lines.push(`언어 비율: ${f.languages.map((l) => `${l.name} ${l.percent}%`).join(", ")}`);
  else if (f.primaryLanguage) lines.push(`주 언어: ${f.primaryLanguage}`);
  const created = day(f.createdAt);
  const pushed = day(f.pushedAt);
  if (created || pushed) lines.push([created ? `생성: ${created}` : null, pushed ? `최근 반영: ${pushed}` : null].filter(Boolean).join(" · "));
  const scale = [
    `별 ${f.stars}`,
    `포크 ${f.forks}`,
    f.commitsTotal !== null ? `전체 커밋 약 ${f.commitsTotal}회` : null,
    f.contributors !== null ? `기여자 ${f.contributors}명` : null,
  ].filter(Boolean);
  lines.push(`규모: ${scale.join(" · ")}`);

  const my = f.my;
  const mine = [
    my.commitCount !== null ? `커밋 ${my.commitCount}회` : "커밋 수 모름",
    day(my.firstCommitAt) ? `첫 커밋 ${day(my.firstCommitAt)}` : null,
    day(my.lastCommitAt) ? `최근 커밋 ${day(my.lastCommitAt)}` : null,
    my.prTotal !== null ? `작성한 PR ${my.prTotal}개` : null,
  ].filter(Boolean);
  lines.push(`회원님(@${my.login})의 기여: ${mine.join(", ")}`);
  if (my.commits.length) {
    lines.push("최근 커밋 메시지(회원님 작성, 최근 순 — 무엇을 했는지만 보여 주고 왜 했는지는 알 수 없다):");
    for (const c of my.commits.slice(0, 50)) lines.push(`- ${day(c.date) ?? "날짜 모름"} ${c.message}`);
  }
  if (my.prs.length) {
    lines.push("작성한 PR 제목:");
    const state = { open: "열림", closed: "닫힘", merged: "병합됨" } as const;
    for (const p of my.prs.slice(0, 20)) lines.push(`- [${state[p.state]}] ${p.title}`);
  }
  if (f.dependencies.length) {
    lines.push("의존성(루트 파일에서 읽은 이름):");
    for (const d of f.dependencies) lines.push(`- ${d.file}: ${d.names.slice(0, 40).join(", ")}`);
  }
  if (f.topLevel.length) lines.push(`최상위 파일·폴더: ${f.topLevel.slice(0, 40).join(", ")}`);

  const head = lines.join("\n");
  const readme = f.readme?.trim();
  if (!readme) return head.slice(0, MAX_BRIEF_CHARS);
  const label = "\n\nREADME(앞부분, 원문 일부 — 저장소 작성자가 쓴 글):\n";
  // 상한을 넘으면 README를 먼저 줄인다.
  const room = MAX_BRIEF_CHARS - head.length - label.length;
  if (room < 200) return head.slice(0, MAX_BRIEF_CHARS);
  const body = readme.length > room ? `${readme.slice(0, room - 12)}…(이하 생략)` : readme;
  return `${head}${label}${body}`.slice(0, MAX_BRIEF_CHARS);
}

/** 화면 미리보기(평문 앞부분). */
export function briefPreview(brief: string): string {
  return brief.length > BRIEF_PREVIEW_CHARS ? `${brief.slice(0, BRIEF_PREVIEW_CHARS)}…` : brief;
}
