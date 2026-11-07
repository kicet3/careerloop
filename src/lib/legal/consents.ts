/**
 * 가입 동의·확인 항목과 문서 버전(클라이언트·서버 공용, 순수). 기록은 user_consents(append-only, src/lib/legal/service.ts).
 *
 * 법적 정리(docs/LEGAL-NOTES.md): 서비스 제공에 필요한 개인정보는 계약 이행 근거(개인정보 보호법 제15조①4호)로 처리하고
 * 처리방침으로 알린다 — 그래서 'privacy'는 동의가 아니라 '안내 확인'(kind 'notice')이다. 해외 위탁·국외이전도 제28조의8①3호
 * (계약 이행에 필요한 처리위탁·보관 + 처리방침 공개)로 보고 privacy 안내에 함께 싣는다(별도 동의 항목 없음).
 * 선택 동의는 광고성 정보 수신(marketing) 하나 — 기본 해제, 거부해도 서비스 이용에 제한이 없다.
 *
 * 문서를 고치면 해당 version을 올린다. 필수 항목의 버전이 바뀌면 로그인한 사용자는 동의 화면(/consent)을 다시 거친다.
 */
import { z } from "zod";

export const CONSENT_TYPES = ["terms", "privacy", "age14", "marketing"] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];

/** consent: 동의 · notice: 안내를 읽고 확인 · attest: 사실 확인(진술). */
export type ConsentKind = "consent" | "notice" | "attest";

export interface ConsentDoc {
  type: ConsentType;
  /** 문서 버전(시행일 'YYYY-MM-DD'). 바뀌면 다시 받는다. */
  version: string;
  required: boolean;
  kind: ConsentKind;
  /** 체크박스 문구('(필수)'·'(선택)' 접두는 화면이 붙인다). */
  label: string;
  /** 전문 링크(없으면 화면 안 요약만). */
  href?: string;
}

/** 이용약관 시행일 겸 버전. /terms 화면 머리말과 변경 이력이 이 값을 쓴다. */
export const TERMS_VERSION = "2026-11-06";
/** 개인정보 처리방침 시행일 겸 버전. /privacy 화면과 가입 화면의 수집·이용·국외이전 안내가 이 값을 쓴다. */
export const PRIVACY_VERSION = "2026-11-09";
/** 광고성 정보 수신 동의 문구 버전. */
export const MARKETING_VERSION = "2026-11-06";
/** 만 14세 이상 확인 문구 버전. */
export const AGE14_VERSION = "2026-11-06";

export const CONSENT_DOCS: Record<ConsentType, ConsentDoc> = {
  terms: { type: "terms", version: TERMS_VERSION, required: true, kind: "consent", label: "이용약관에 동의합니다", href: "/terms" },
  privacy: {
    type: "privacy",
    version: PRIVACY_VERSION,
    required: true,
    kind: "notice",
    label: "개인정보 수집·이용 및 국외 이전(해외 위탁) 안내를 확인했습니다",
    href: "/privacy",
  },
  age14: { type: "age14", version: AGE14_VERSION, required: true, kind: "attest", label: "만 14세 이상입니다" },
  marketing: {
    type: "marketing",
    version: MARKETING_VERSION,
    required: false,
    kind: "consent",
    label: "광고성 정보(새 기능·이벤트 안내) 이메일 수신에 동의합니다",
  },
};

export const REQUIRED_CONSENT_TYPES = CONSENT_TYPES.filter((t) => CONSENT_DOCS[t].required);
export const OPTIONAL_CONSENT_TYPES = CONSENT_TYPES.filter((t) => !CONSENT_DOCS[t].required);

/** 동의를 받은 경로. signup: 가입 화면(Google 이동 전), gate: 로그인 뒤 재동의 화면, account: 설정 > 계정. */
export const CONSENT_SOURCES = ["signup", "gate", "account"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/** 가입·재동의 화면이 보내는 선택값. 필수 항목은 true여야 한다(아니면 400). */
export const ConsentChoicesSchema = z.object({
  terms: z.literal(true, { error: "이용약관에 동의해 주세요." }),
  privacy: z.literal(true, { error: "개인정보 수집·이용 안내를 확인해 주세요." }),
  age14: z.literal(true, { error: "만 14세 이상만 가입할 수 있습니다." }),
  marketing: z.boolean().optional().default(false),
});
export type ConsentChoices = z.infer<typeof ConsentChoicesSchema>;

/** 화면 체크 상태(검증 전). '전체 동의'는 모든 값을 같이 바꾼다. */
export type ConsentChecks = Record<ConsentType, boolean>;
export const EMPTY_CONSENT_CHECKS: ConsentChecks = { terms: false, privacy: false, age14: false, marketing: false };

/** 필수 항목이 모두 체크됐는가(가입 버튼 활성화 조건). */
export function requiredConsentsChecked(checks: Partial<ConsentChecks>): boolean {
  return REQUIRED_CONSENT_TYPES.every((t) => checks[t] === true);
}

/** '전체 동의' 체크 상태: 모든 항목(선택 포함)이 체크됐을 때만 true. */
export function allConsentsChecked(checks: Partial<ConsentChecks>): boolean {
  return CONSENT_TYPES.every((t) => checks[t] === true);
}

/** (user, type)별 최신 기록. */
export type LatestConsents = Partial<Record<ConsentType, { version: string; agreed: boolean; at: number }>>;

/** 현재 버전으로 다시 받아야 하는 필수 항목(없으면 빈 배열 — 앱을 쓸 수 있다). */
export function missingRequiredConsents(latest: LatestConsents): ConsentType[] {
  return REQUIRED_CONSENT_TYPES.filter((t) => {
    const row = latest[t];
    return !row || !row.agreed || row.version !== CONSENT_DOCS[t].version;
  });
}

/** 현재 광고성 정보 수신 동의 여부(철회했거나 기록이 없으면 false). 버전이 달라도 동의는 유지된다(문구만 바뀐 경우). */
export function marketingAgreed(latest: LatestConsents): boolean {
  return latest.marketing?.agreed === true;
}
