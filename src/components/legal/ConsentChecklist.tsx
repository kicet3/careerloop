"use client";

/**
 * 가입·재동의 화면의 동의 목록: '전체 동의' + 항목별 체크박스(기본 해제, 개별 해제 가능) + 항목별 펼침 안내.
 * 체크박스 name은 terms·privacy·age14·marketing, value "1" — 그대로 폼(POST /api/auth/google)으로 보낼 수 있다.
 * 상태는 부모가 가진다(버튼 활성화 판단: requiredConsentsChecked).
 */
import { useId, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import { CONSENT_DOCS, CONSENT_TYPES, type ConsentChecks, type ConsentType } from "@/lib/legal/consents";
import { MarketingNotice, SignupPrivacyNotice } from "./PrivacySummary";

const DETAILS: Partial<Record<ConsentType, ReactNode>> = {
  terms: (
    <p className="text-xs leading-relaxed text-slate-600">
      서비스 이용 조건, 회원 가입·승인, 이용자 의무, AI 결과물의 성격과 책임 제한, 회원 탈퇴 등을 정합니다.{" "}
      <a href="/terms" target="_blank" rel="noopener" className="font-medium text-indigo-700 underline underline-offset-2">
        이용약관 전문 보기
      </a>
    </p>
  ),
  privacy: <SignupPrivacyNotice />,
  age14: (
    <p className="text-xs leading-relaxed text-slate-600">
      만 14세 미만 아동은 가입할 수 없습니다. 만 14세 미만임이 확인되면 계정과 정보를 지체 없이 삭제합니다.
    </p>
  ),
  marketing: <MarketingNotice />,
};

function prefix(type: ConsentType): string {
  const doc = CONSENT_DOCS[type];
  if (!doc.required) return "(선택)";
  return doc.kind === "notice" ? "(필수 확인)" : "(필수)";
}

export function ConsentChecklist({
  checks,
  onChange,
  disabled = false,
  types = CONSENT_TYPES,
}: {
  checks: ConsentChecks;
  onChange: (next: ConsentChecks) => void;
  disabled?: boolean;
  /** 보여 줄 항목(재동의 화면에서 이미 동의한 선택 항목을 뺄 때). 기본은 전부. */
  types?: readonly ConsentType[];
}) {
  const baseId = useId();
  const all = types.every((t) => checks[t]);

  function setAll(value: boolean) {
    const next = { ...checks };
    for (const t of types) next[t] = value;
    onChange(next);
  }

  return (
    <fieldset className="space-y-2" disabled={disabled}>
      <legend className="sr-only">약관·개인정보 안내 동의</legend>
      <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2.5 text-sm font-semibold text-slate-900">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          className="size-4 rounded border-slate-300 accent-indigo-600"
        />
        {types.some((t) => !CONSENT_DOCS[t].required) ? "전체 동의(선택 항목 포함)" : "전체 동의"}
      </label>
      <p className="px-1 text-xs text-slate-500">전체 동의 후에도 항목마다 해제할 수 있습니다. 선택 항목은 동의하지 않아도 가입할 수 있습니다.</p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
        {types.map((type) => {
          const doc = CONSENT_DOCS[type];
          const id = `${baseId}-${type}`;
          return (
            <li key={type} className="px-3 py-2">
              <div className="flex items-start gap-2.5">
                <input
                  id={id}
                  type="checkbox"
                  name={type}
                  value="1"
                  checked={checks[type]}
                  onChange={(e) => onChange({ ...checks, [type]: e.target.checked })}
                  className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-indigo-600"
                />
                <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm text-slate-800">
                  <span className={cn("mr-1 font-semibold", doc.required ? "text-indigo-700" : "text-slate-500")}>{prefix(type)}</span>
                  {doc.label}
                </label>
              </div>
              {DETAILS[type] && (
                <details className="group mt-1 ml-6.5">
                  <summary className="cursor-pointer text-xs font-medium text-slate-500 select-none hover:text-slate-800">
                    <span className="group-open:hidden">내용 보기</span>
                    <span className="hidden group-open:inline">내용 접기</span>
                  </summary>
                  <div className="mt-2 max-h-80 overflow-y-auto pr-1">{DETAILS[type]}</div>
                </details>
              )}
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
