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
  name: string;
  representative: string;
  registrationNumber: string;
  address: string;
  email: string;
  phone: string;
}

export const BUSINESS: Readonly<BusinessInfo> = {
  name: "snowlink",
  /** 대표자 성명 — 실제 값으로 채울 것 */
  representative: "",
  /** 사업자등록번호 — 실제 값으로 채울 것 */
  registrationNumber: "",
  /** 사업장 주소 — 실제 값으로 채울 것 */
  address: "",
  /** 연락 이메일 — 실제 값으로 채울 것 */
  email: "",
  /** 연락 전화 — 실제 값으로 채울 것 */
  phone: "",
};

/** PDF creator/producer 등 서비스 표기(예: "CareerLoop (snowlink)"). */
export const SERVICE_CREDIT = `${SERVICE_NAME} (${BUSINESS.name})`;
