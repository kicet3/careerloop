"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { EMPTY_RESUME_ITEM, RESUME_SECTION_LABELS, type ResumeDocument, type ResumeSectionKey } from "@/lib/domain/resumes";
import { labelClass, smallInputClass, smallTextareaClass } from "./styles";

/**
 * ResumeDocument 구조화 편집 폼. 섹션별 항목을 추가·삭제·순서 변경하고, 불릿·기술 목록은 줄 단위로 입력한다.
 * 길이 한도는 ResumeDocumentSchema와 같게 maxLength로 막는다(저장 전 최종 검증은 스키마).
 */

type Doc = ResumeDocument;
type Extra = Doc["extras"][number];

const EMPTY = {
  ...EMPTY_RESUME_ITEM,
  extras: (): Extra => ({ title: "", items: [] }),
};

const LIMITS = { highlights: 8, experience: 20, projects: 20, skills: 10, education: 10, certifications: 20, extras: 8, links: 6 };

function Text({
  label,
  value,
  onChange,
  max,
  placeholder,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={className}>
      <span className={labelClass}>{label}</span>
      <input value={value} maxLength={max} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} className={`mt-1 ${smallInputClass}`} />
    </label>
  );
}

function Area({
  label,
  value,
  onChange,
  max,
  rows = 3,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className={labelClass}>{label}</span>
      <textarea
        value={value}
        maxLength={max}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 ${smallTextareaClass}`}
      />
    </label>
  );
}

const splitLines = (raw: string) => raw.split("\n").map((x) => x.trim()).filter(Boolean);
const splitCommas = (raw: string) => raw.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * 문자열 배열을 줄(또는 쉼표) 단위로 편집한다. 입력 중인 원문을 따로 들고 있어서 빈 줄·쉼표를 치는 도중에 지워지지 않는다.
 * 바깥 값이 바뀌면(버전 복원 등) 원문을 다시 만든다.
 */
function ListText({
  label,
  values,
  onChange,
  mode,
  maxItems,
  maxLen,
  rows = 3,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  mode: "lines" | "commas";
  maxItems: number;
  maxLen: number;
  rows?: number;
  placeholder?: string;
}) {
  const sep = mode === "lines" ? "\n" : ", ";
  const parse = mode === "lines" ? splitLines : splitCommas;
  const [raw, setRaw] = useState(values.join(sep));
  const [lastValues, setLastValues] = useState(values);
  // 렌더 중 상태 조정: 바깥에서 값이 바뀌었고 지금 원문과 뜻이 다르면 원문을 다시 만든다.
  if (lastValues !== values) {
    setLastValues(values);
    if (parse(raw).join("\u0000") !== values.join("\u0000")) setRaw(values.join(sep));
  }
  const count = parse(raw).length;
  return (
    <label className="block">
      <span className={labelClass}>
        {label}
        <span className="font-normal text-slate-400"> · {mode === "lines" ? "한 줄에 하나" : "쉼표로 구분"}</span>
      </span>
      {mode === "lines" ? (
        <textarea
          value={raw}
          rows={rows}
          placeholder={placeholder}
          onChange={(e) => {
            setRaw(e.target.value);
            onChange(parse(e.target.value).slice(0, maxItems).map((x) => x.slice(0, maxLen)));
          }}
          className={`mt-1 ${smallTextareaClass}`}
        />
      ) : (
        <input
          value={raw}
          placeholder={placeholder}
          onChange={(e) => {
            setRaw(e.target.value);
            onChange(parse(e.target.value).slice(0, maxItems).map((x) => x.slice(0, maxLen)));
          }}
          className={`mt-1 ${smallInputClass}`}
        />
      )}
      {count > maxItems && <span className="mt-1 block text-xs text-amber-700">{maxItems}개까지만 저장됩니다.</span>}
    </label>
  );
}

/** 항목 목록 편집 틀: 각 항목 카드 + 위/아래/삭제 + 추가. */
function ItemList<T>({
  items,
  onChange,
  make,
  max,
  addLabel,
  title,
  render,
}: {
  items: T[];
  onChange: (v: T[]) => void;
  make: () => T;
  max: number;
  addLabel: string;
  title: (item: T, i: number) => string;
  render: (item: T, update: (patch: Partial<T>) => void) => ReactNode;
}) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i} className="rounded-lg border border-slate-200 bg-slate-50/50 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-sm font-medium text-slate-700">{title(item, i)}</p>
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" aria-label="위로" disabled={i === 0} onClick={() => move(i, -1)}>
                ↑
              </Button>
              <Button size="sm" variant="ghost" aria-label="아래로" disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                ↓
              </Button>
              <Button size="sm" variant="ghost" className="text-red-700" onClick={() => onChange(items.filter((_, k) => k !== i))}>
                삭제
              </Button>
            </div>
          </div>
          {render(item, (patch) => onChange(items.map((x, k) => (k === i ? { ...x, ...patch } : x))))}
        </div>
      ))}
      <Button size="sm" variant="secondary" disabled={items.length >= max} onClick={() => onChange([...items, make()])}>
        + {addLabel}
      </Button>
    </div>
  );
}

function Fieldset({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return (
    <details open id={id} className="group rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-900 select-none">
        {title}
        <span aria-hidden className="text-slate-400 transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <div className="space-y-3 border-t border-slate-100 px-4 py-4">{children}</div>
    </details>
  );
}

const grid2 = "grid gap-3 sm:grid-cols-2";

export function ResumeDocumentForm({
  value: doc,
  onChange,
  sectionOrder,
}: {
  value: ResumeDocument;
  onChange: (doc: ResumeDocument) => void;
  /** 양식의 섹션 순서대로 폼을 보인다. */
  sectionOrder: readonly ResumeSectionKey[];
}) {
  const set = <K extends keyof Doc>(k: K, v: Doc[K]) => onChange({ ...doc, [k]: v });
  const basics = (patch: Partial<Doc["basics"]>) => set("basics", { ...doc.basics, ...patch });

  const sections: Record<ResumeSectionKey, ReactNode> = {
    summary: (
      <Area
        label="요약"
        value={doc.summary}
        onChange={(v) => set("summary", v)}
        max={1500}
        rows={5}
        placeholder="지원 직무와 이어지는 경력·강점·대표 성과를 3~4문장으로."
      />
    ),
    highlights: (
      <ItemList
        items={doc.highlights}
        onChange={(v) => set("highlights", v)}
        make={EMPTY.highlight}
        max={LIMITS.highlights}
        addLabel="성과 추가"
        title={(x, i) => x.title || `성과 ${i + 1}`}
        render={(x, up) => (
          <div className="space-y-3">
            <Text
              label="성과"
              value={x.title}
              max={200}
              placeholder="[직무 KPI] [기준값] → [개선값] · [개선 폭과 단위]"
              onChange={(v) => up({ title: v })}
            />
            <Text
              label="근거"
              value={x.context}
              max={300}
              placeholder="[측정 기간·대상] / [본인이 수행한 핵심 행동]"
              onChange={(v) => up({ context: v })}
            />
          </div>
        )}
      />
    ),
    experience: (
      <ItemList
        items={doc.experience}
        onChange={(v) => set("experience", v)}
        make={EMPTY.experience}
        max={LIMITS.experience}
        addLabel="경력 추가"
        title={(x, i) => x.company || `경력 ${i + 1}`}
        render={(x, up) => (
          <div className="space-y-3">
            <div className={grid2}>
              <Text label="회사" value={x.company} max={120} onChange={(v) => up({ company: v })} />
              <Text label="부서·조직" value={x.department} max={120} onChange={(v) => up({ department: v })} />
              <Text label="직무·직급" value={x.title} max={120} onChange={(v) => up({ title: v })} />
              <Text label="시작" value={x.startDate} max={20} placeholder="2021.03" onChange={(v) => up({ startDate: v })} />
              <Text label="종료" value={x.endDate} max={20} placeholder="현재" onChange={(v) => up({ endDate: v })} />
            </div>
            <Text label="근무지" value={x.location} max={80} onChange={(v) => up({ location: v })} />
            <Area
              label="담당 범위"
              value={x.scope}
              max={600}
              rows={2}
              placeholder="[서비스·제품·업무]의 [담당 범위]를 맡아 [주요 책임]을 수행."
              onChange={(v) => up({ scope: v })}
            />
            <ListText
              label="주요 업무·성과"
              mode="lines"
              values={x.bullets}
              maxItems={15}
              maxLen={500}
              rows={4}
              placeholder="무엇을 → 어떻게 → 결과(수치)"
              onChange={(v) => up({ bullets: v })}
            />
          </div>
        )}
      />
    ),
    projects: (
      <ItemList
        items={doc.projects}
        onChange={(v) => set("projects", v)}
        make={EMPTY.project}
        max={LIMITS.projects}
        addLabel="프로젝트 추가"
        title={(x, i) => x.name || `프로젝트 ${i + 1}`}
        render={(x, up) => (
          <div className="space-y-3">
            <div className={grid2}>
              <Text label="프로젝트명" value={x.name} max={120} onChange={(v) => up({ name: v })} />
              <Text label="내 역할" value={x.role} max={120} placeholder="결정·실행 범위" onChange={(v) => up({ role: v })} />
              <Text label="회사·활동명" value={x.company} max={120} onChange={(v) => up({ company: v })} />
              <Text label="팀 구성" value={x.team} max={120} placeholder="백엔드 3·디자인 1" onChange={(v) => up({ team: v })} />
              <Text label="시작" value={x.startDate} max={20} onChange={(v) => up({ startDate: v })} />
              <Text label="종료" value={x.endDate} max={20} onChange={(v) => up({ endDate: v })} />
            </div>
            <Area label="한 줄 설명" value={x.summary} max={600} rows={2} onChange={(v) => up({ summary: v })} />
            <Area label="문제" value={x.problem} max={500} rows={2} placeholder="[어떤 자료]로 [개선이 필요한 원인·상황]을 확인." onChange={(v) => up({ problem: v })} />
            <Area label="행동" value={x.action} max={500} rows={2} placeholder="[선택 기준]에 따라 [본인의 판단·실행·협업]을 수행." onChange={(v) => up({ action: v })} />
            <Area label="결과" value={x.result} max={500} rows={2} placeholder="[기간·대상]에서 [지표 전후 변화 또는 검증 결과] 확인." onChange={(v) => up({ result: v })} />
            <Text label="근거" value={x.evidence} max={300} placeholder="측정 자료명 또는 공개 가능한 링크" onChange={(v) => up({ evidence: v })} />
            <ListText label="한 일·결과" mode="lines" values={x.bullets} maxItems={15} maxLen={500} rows={3} onChange={(v) => up({ bullets: v })} />
            <ListText label="기술" mode="commas" values={x.techs} maxItems={20} maxLen={60} placeholder="Kotlin, Spring, MySQL" onChange={(v) => up({ techs: v })} />
          </div>
        )}
      />
    ),
    skills: (
      <ItemList
        items={doc.skills}
        onChange={(v) => set("skills", v)}
        make={EMPTY.skill}
        max={LIMITS.skills}
        addLabel="기술 묶음 추가"
        title={(x, i) => x.category || `기술 ${i + 1}`}
        render={(x, up) => (
          <div className="space-y-3">
            <Text label="분류·역량" value={x.category} max={60} placeholder="예: 백엔드, 데이터 분석" onChange={(v) => up({ category: v })} />
            <Text label="설명" value={x.detail} max={300} placeholder="실제로 할 수 있는 일과 적용 경험" onChange={(v) => up({ detail: v })} />
            <ListText label="기술" mode="commas" values={x.items} maxItems={30} maxLen={60} onChange={(v) => up({ items: v })} />
          </div>
        )}
      />
    ),
    education: (
      <ItemList
        items={doc.education}
        onChange={(v) => set("education", v)}
        make={EMPTY.education}
        max={LIMITS.education}
        addLabel="학력 추가"
        title={(x, i) => x.school || `학력 ${i + 1}`}
        render={(x, up) => (
          <div className={grid2}>
            <Text label="학교" value={x.school} max={120} onChange={(v) => up({ school: v })} />
            <Text label="학위" value={x.degree} max={60} placeholder="학사" onChange={(v) => up({ degree: v })} />
            <Text label="전공" value={x.major} max={120} onChange={(v) => up({ major: v })} />
            <div className="grid grid-cols-2 gap-3">
              <Text label="시작" value={x.startDate} max={20} onChange={(v) => up({ startDate: v })} />
              <Text label="종료" value={x.endDate} max={20} onChange={(v) => up({ endDate: v })} />
            </div>
            <Text label="비고" className="sm:col-span-2" value={x.note} max={300} onChange={(v) => up({ note: v })} />
          </div>
        )}
      />
    ),
    certifications: (
      <ItemList
        items={doc.certifications}
        onChange={(v) => set("certifications", v)}
        make={EMPTY.certification}
        max={LIMITS.certifications}
        addLabel="자격·어학 추가"
        title={(x, i) => x.name || `자격 ${i + 1}`}
        render={(x, up) => (
          <div className="grid gap-3 sm:grid-cols-3">
            <Text label="이름" value={x.name} max={120} onChange={(v) => up({ name: v })} />
            <Text label="발급처" value={x.issuer} max={120} onChange={(v) => up({ issuer: v })} />
            <Text label="취득일" value={x.date} max={20} onChange={(v) => up({ date: v })} />
          </div>
        )}
      />
    ),
    extras: (
      <ItemList
        items={doc.extras}
        onChange={(v) => set("extras", v)}
        make={EMPTY.extras}
        max={LIMITS.extras}
        addLabel="기타 묶음 추가"
        title={(x, i) => x.title || `기타 ${i + 1}`}
        render={(x, up) => (
          <div className="space-y-3">
            <Text label="제목" value={x.title} max={80} placeholder="예: 수상, 발표, 오픈소스, 어학, 병역" onChange={(v) => up({ title: v })} />
            <ListText label="항목" mode="lines" values={x.items} maxItems={15} maxLen={300} onChange={(v) => up({ items: v })} />
          </div>
        )}
      />
    ),
    // 지원 동기는 편집기의 별도 칸(MotivationEditor — 지원처별 이력서만, AI 추천 포함)에서 쓴다.
    motivation: null,
  };

  return (
    <div className="space-y-3">
      <Fieldset title="기본 정보">
        <div className={grid2}>
          <Text label="이름" value={doc.basics.name} max={80} onChange={(v) => basics({ name: v })} />
          <Text label="지원 직무" value={doc.basics.headline} max={160} placeholder="백엔드 개발자" onChange={(v) => basics({ headline: v })} />
          <Text label="총 경력" value={doc.basics.totalExperience} max={40} placeholder="5년 3개월" onChange={(v) => basics({ totalExperience: v })} />
          <Text
            label="한 줄 소개"
            className="sm:col-span-2"
            value={doc.basics.tagline}
            max={200}
            placeholder="결제 지연을 줄여 온 5년 차 백엔드 개발자"
            onChange={(v) => basics({ tagline: v })}
          />
          <Text label="이메일" value={doc.basics.email} max={160} onChange={(v) => basics({ email: v })} />
          <Text label="전화" value={doc.basics.phone} max={40} onChange={(v) => basics({ phone: v })} />
          <Text label="지역" value={doc.basics.location} max={80} onChange={(v) => basics({ location: v })} />
          <Text label="포트폴리오 URL" value={doc.basics.portfolioUrl} max={500} placeholder="https://" onChange={(v) => basics({ portfolioUrl: v })} />
        </div>
        <ItemList
          items={doc.basics.links}
          onChange={(v) => basics({ links: v })}
          make={() => ({ label: "", url: "" })}
          max={LIMITS.links}
          addLabel="링크 추가"
          title={(x, i) => x.label || `링크 ${i + 1}`}
          render={(x, up) => (
            <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
              <Text label="이름" value={x.label} max={40} placeholder="GitHub" onChange={(v) => up({ label: v })} />
              <Text label="주소" value={x.url} max={500} placeholder="https://" onChange={(v) => up({ url: v })} />
            </div>
          )}
        />
      </Fieldset>
      {sectionOrder
        .filter((k) => k !== "motivation")
        .map((k) => (
        <Fieldset key={k} title={RESUME_SECTION_LABELS[k]}>
          {sections[k]}
        </Fieldset>
      ))}
    </div>
  );
}
