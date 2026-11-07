/**
 * 근거 항목의 텍스트 형식(순수, 클라이언트·서버 공용). 프롬프트 한 줄과 사실 검증용 원문.
 */
import { SHORT_LABEL } from "@/lib/graph/paths";
import type { EvidenceItem } from "./schemas";

/** 프롬프트의 근거 한 줄: "E1 [프로젝트] 주문 시스템 개편 (나 → …) 2022.03 ~ 2023.01 | action: … | 기술: Kafka". */
export function evidenceLine(item: EvidenceItem): string {
  const head = `${item.ref} [${SHORT_LABEL[item.label]}] ${item.name} (${item.path})${item.period ? ` ${item.period}` : ""}`;
  const parts = [head, item.text, item.skills.length && item.label !== "Skill" ? `기술: ${item.skills.join(", ")}` : ""].filter(Boolean);
  return parts.join(" | ");
}

/** 사실 검증에 쓰는 근거 원문(이름 + 기간 + 속성 텍스트 + 기술 + 소속 회사). */
export function evidenceSourceText(items: readonly EvidenceItem[]): string {
  return items.map((i) => [i.name, i.period, i.text, i.skills.join(" "), i.facts?.company ?? ""].join(" ")).join("\n");
}
