/**
 * 서비스 이름·운영 사업자 정보의 단일 출처.
 * 화면 하단(BusinessInfo)과 PDF 메타데이터(creator/producer)가 이 값을 쓴다.
 */
export const SERVICE_NAME = "CareerLoop";

/**
 * 운영 사업자 정보. name 외의 값은 실제 값으로 채워야 한다 — 임의로 지어 넣지 않는다.
 * 빈 문자열인 항목은 화면에 표시하지 않는다.
 */
export interface BusinessInfo {
  /** 영문 표기(저작권 줄·PDF). */
  name: string;
  /** 사업자등록상 상호(약관·처리방침 등 법적 문서). */
  legalName: string;
  representative: string;
  registrationNumber: string;
  address: string;
  email: string;
  phone: string;
}

export const BUSINESS: Readonly<BusinessInfo> = {
  name: "SnowLink",
  legalName: "스노우링크(SnowLink)",
  representative: "이현대",
  registrationNumber: "335-17-02746",
  /** 사업장 주소 — 실제 값으로 채울 것(비어 있으면 표시하지 않음) */
  address: "서울특별시 관악구 조원로8길 10",
  email: "support@snowlink.team",
  phone: "010-4953-4821",
};

/** 호스팅 서비스 제공자(전자상거래법 제10조 표시 권장 항목). */
export const HOSTING_PROVIDER = "Vercel Inc.";

/** PDF creator/producer 등 서비스 표기(예: "CareerLoop (SnowLink)"). */
export const SERVICE_CREDIT = `${SERVICE_NAME} (${BUSINESS.name})`;
