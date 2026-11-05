"use client";
/**
 * 구역 편집기: 구역마다 textarea 하나(한 줄 = 한 항목), 짧은 값은 input. 저장하면 PATCH { structured }(출처 '직접 편집').
 * 개수·길이 상한은 저장 전에 잘라 서버 검증(PostingStructureEditSchema)에 걸리지 않게 한다.
 */
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  STRUCTURE_LIMITS,
  STRUCTURE_SECTION_LABELS as L,
  type PostingStructureEdit,
} from "@/lib/domain/posting-structure";
import type { JobPosting } from "@/lib/domain/postings";
import { inputClass, labelClass, readApiError, textareaClass } from "./shared";

type ListField =
  | "duties"
  | "requirements"
  | "preferred"
  | "techStack"
  | "benefits"
  | "process"
  | "notes"
  | "companyIntro"
  | "conditionsOther"
  | "documents"
  | "method";

const LIST_FIELDS: { key: ListField; label: string; max: number; itemMax: number; rows: number }[] = [
  { key: "duties", label: L.duties, max: STRUCTURE_LIMITS.list, itemMax: STRUCTURE_LIMITS.item, rows: 5 },
  { key: "requirements", label: L.requirements, max: STRUCTURE_LIMITS.list, itemMax: STRUCTURE_LIMITS.item, rows: 5 },
  { key: "preferred", label: L.preferred, max: STRUCTURE_LIMITS.list, itemMax: STRUCTURE_LIMITS.item, rows: 4 },
  { key: "techStack", label: L.techStack, max: STRUCTURE_LIMITS.tech, itemMax: STRUCTURE_LIMITS.techItem, rows: 3 },
  { key: "conditionsOther", label: "근무 조건(기타)", max: STRUCTURE_LIMITS.small, itemMax: STRUCTURE_LIMITS.item, rows: 3 },
  { key: "benefits", label: L.benefits, max: STRUCTURE_LIMITS.list, itemMax: STRUCTURE_LIMITS.item, rows: 4 },
  { key: "process", label: `${L.process}(단계 순서)`, max: STRUCTURE_LIMITS.small, itemMax: STRUCTURE_LIMITS.item, rows: 3 },
  { key: "documents", label: "제출 서류", max: STRUCTURE_LIMITS.small, itemMax: STRUCTURE_LIMITS.item, rows: 3 },
  { key: "method", label: "지원 방법", max: STRUCTURE_LIMITS.applyMethod, itemMax: STRUCTURE_LIMITS.item, rows: 2 },
  { key: "companyIntro", label: L.company, max: STRUCTURE_LIMITS.companyIntro, itemMax: STRUCTURE_LIMITS.item, rows: 3 },
  { key: "notes", label: L.notes, max: STRUCTURE_LIMITS.notes, itemMax: STRUCTURE_LIMITS.item, rows: 3 },
];

function listOf(s: PostingStructureEdit, key: ListField): string[] {
  switch (key) {
    case "companyIntro":
      return s.company.intro;
    case "conditionsOther":
      return s.conditions.other;
    case "documents":
      return s.application.documents;
    case "method":
      return s.application.method;
    default:
      return s[key];
  }
}

const toLines = (text: string, max: number, itemMax: number) =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim().slice(0, itemMax).trim())
    .filter(Boolean)
    .slice(0, max);

export function PostingSectionsEditor({
  postingId,
  structure,
  onSaved,
  onCancel,
}: {
  postingId: string;
  structure: PostingStructureEdit;
  onSaved: (posting: JobPosting) => void;
  onCancel: () => void;
}) {
  const [lists, setLists] = useState<Record<ListField, string>>(
    () => Object.fromEntries(LIST_FIELDS.map((f) => [f.key, listOf(structure, f.key).join("\n")])) as Record<ListField, string>,
  );
  const [short, setShort] = useState({
    summary: structure.summary,
    industry: structure.company.industry,
    size: structure.company.size,
    salary: structure.conditions.salary,
    workHours: structure.conditions.workHours,
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const get = (key: ListField) => {
      const f = LIST_FIELDS.find((x) => x.key === key)!;
      return toLines(lists[key], f.max, f.itemMax);
    };
    const clip = (v: string, n: number) => v.trim().slice(0, n);
    const structured: PostingStructureEdit = {
      summary: clip(short.summary, STRUCTURE_LIMITS.summary),
      company: { industry: clip(short.industry, STRUCTURE_LIMITS.short), size: clip(short.size, STRUCTURE_LIMITS.short), intro: get("companyIntro") },
      duties: get("duties"),
      requirements: get("requirements"),
      preferred: get("preferred"),
      techStack: [...new Set(get("techStack"))],
      conditions: { salary: clip(short.salary, STRUCTURE_LIMITS.short), workHours: clip(short.workHours, STRUCTURE_LIMITS.short), other: get("conditionsOther") },
      benefits: get("benefits"),
      process: get("process"),
      application: { documents: get("documents"), method: get("method") },
      notes: get("notes"),
    };
    setSaving(true);
    try {
      const res = await fetch(`/api/postings/${postingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structured }),
      });
      if (!res.ok) {
        setError((await readApiError(res, "구역을 저장하지 못했습니다.")).error);
        setSaving(false);
        return;
      }
      onSaved(((await res.json()) as { posting: JobPosting }).posting);
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
      setSaving(false);
    }
  }

  const shortInput = (key: keyof typeof short, label: string, max: number) => (
    <div>
      <label htmlFor={`pse-${key}`} className={labelClass}>
        {label}
      </label>
      <input
        id={`pse-${key}`}
        className={inputClass}
        value={short[key]}
        maxLength={max}
        onChange={(e) => setShort((s) => ({ ...s, [key]: e.target.value }))}
      />
    </div>
  );

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      {error && <Alert tone="error">{error}</Alert>}
      <p className="text-sm text-slate-500">한 줄에 한 항목씩 적습니다. 빈 칸으로 두면 그 구역은 화면에 나오지 않습니다.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="pse-summary" className={labelClass}>
            {L.summary}
          </label>
          <textarea
            id="pse-summary"
            rows={2}
            className={textareaClass}
            value={short.summary}
            maxLength={STRUCTURE_LIMITS.summary}
            onChange={(e) => setShort((s) => ({ ...s, summary: e.target.value }))}
          />
        </div>
        {shortInput("salary", "연봉", STRUCTURE_LIMITS.short)}
        {shortInput("workHours", "근무시간", STRUCTURE_LIMITS.short)}
        {shortInput("industry", "업종", STRUCTURE_LIMITS.short)}
        {shortInput("size", "규모", STRUCTURE_LIMITS.short)}
        {LIST_FIELDS.map((f) => (
          <div key={f.key} className="sm:col-span-2">
            <label htmlFor={`pse-${f.key}`} className={labelClass}>
              {f.label} <span className="font-normal text-slate-500">(최대 {f.max}줄)</span>
            </label>
            <textarea
              id={`pse-${f.key}`}
              rows={f.rows}
              className={textareaClass}
              value={lists[f.key]}
              onChange={(e) => setLists((l) => ({ ...l, [f.key]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          취소
        </Button>
        <Button type="submit" loading={saving}>
          구역 저장
        </Button>
      </div>
    </form>
  );
}
