/**
 * 개인정보 처리방침·가입 화면이 함께 쓰는 표 데이터(클라이언트·서버 공용, 순수).
 * 바꾸면 src/lib/legal/consents.ts의 PRIVACY_VERSION을 올리고 /privacy의 변경 이력에 한 줄 추가한다.
 *
 * 근거 정리(docs/LEGAL-NOTES.md): 서비스 제공에 필요한 정보는 계약 이행(개인정보 보호법 제15조①4호)으로 처리하고,
 * 해외 사업자에게 맡기는 처리는 위탁(제26조) + 국외이전(제28조의8①3호, 처리방침 공개)으로 본다.
 */
import { BUSINESS } from "@/lib/brand";

/** 사업자가 확인해 채워야 하는 값. 화면에 이 문구가 보이면 아직 확정되지 않은 것이다. */
export const NEEDS_CONFIRMATION = "[확인 필요]";

/** 빈 값이면 '[확인 필요] 설명'으로 표시한다. */
export function orPlaceholder(value: string, what: string): string {
  return value.trim() ? value : `${NEEDS_CONFIRMATION} ${what}`;
}

export const BUSINESS_ADDRESS_TEXT = orPlaceholder(BUSINESS.address, "사업장 주소(사업자등록증 기재 주소)");

export interface ProcessingRow {
  /** 처리 목적 */
  purpose: string;
  /** 처리 항목 */
  items: string;
  /** 보유·이용 기간 */
  retention: string;
  /** 처리 근거 */
  basis: string;
}

/** 동의 없이 처리하는 항목(계약 이행 — 서비스 제공에 꼭 필요). */
export const CONTRACT_PROCESSING: ProcessingRow[] = [
  {
    purpose: "회원 가입·식별, 로그인, 가입 승인·이용 제한 관리",
    items: "이메일 주소, 이름(Google 계정 프로필), Google 계정 고유 식별자, (설정한 경우) 비밀번호의 단방향 암호화 값",
    retention: "회원 탈퇴 시까지",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "이력서 진단·작성, 채용공고 분석·적합도 비교, 지원 현황 관리",
    items:
      "이용자가 올리거나 입력한 이력서·자기소개서 파일과 텍스트, 채용공고 URL·내용, 메모, 지원 기록, AI가 만든 분석·작성 결과물",
    retention: "회원 탈퇴 또는 이용자가 해당 자료를 삭제할 때까지",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "경험 그래프 구성, 경력 정리 대화",
    items: "이용자가 입력한 경력·프로젝트·역량 정보, 대화 내용과 AI 응답",
    retention: "회원 탈퇴 또는 이용자가 해당 자료를 삭제할 때까지",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "공용 공고 목록(공고 찾기) 제공",
    items: "이용자가 URL로 가져온 채용공고 페이지의 내용 또는 직접 입력한 채용공고 내용(회사·직무·공고 본문·마감·근무 조건. 메모·지원 상태 제외). 가져오거나 입력한 사람은 다른 이용자에게 표시하지 않음",
    retention: "공고 내용은 탈퇴 후에도 공용 목록에 남을 수 있음(가져오거나 입력한 사람과의 연결은 탈퇴 시 삭제)",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "AI 기능 운영 비용 관리, 부정 이용 방지",
    items: "AI 기능 이용 기록(이용한 기능, AI 모델, 토큰 수, 추정 비용, 성공 여부, 이용 일시). 입력 내용과 AI 응답 본문은 포함하지 않음",
    retention: "회원 탈퇴 시까지",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "외부 AI 앱 연결(MCP) — 이용자가 연결한 앱에서 본인 경험 그래프 읽기",
    items: "이용자가 붙인 토큰 이름, 토큰의 단방향 해시값과 앞부분(식별용), 만료·폐기·마지막 사용 일시",
    retention: "회원 탈퇴 시까지(이용자가 폐기한 토큰은 폐기 후에도 탈퇴 시까지 기록이 남음)",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "GitHub 연동 — 이용자가 고른 저장소 정보로 경험 그래프 정리",
    items:
      "GitHub 계정 고유 식별자·아이디·프로필 사진 주소, GitHub 접근·갱신 토큰(암호화 저장), 이용자가 고른 저장소의 정보(이름·설명·주제·언어 비율·별/포크 수·생성·최근 반영 일시·README 앞부분·의존성 이름·최상위 파일 이름·이용자가 작성한 커밋 메시지·PR 제목 일부·기여 횟수). 비공개 저장소는 이용자가 GitHub에서 허용하고 서비스에서 켠 경우에만",
    retention: "GitHub 연결 해제 또는 회원 탈퇴 시까지(경험 그래프에 적용한 내용은 이용자가 삭제하거나 탈퇴할 때까지)",
    basis: "계약 이행(법 제15조①4호)",
  },
  {
    purpose: "보안·부정 이용 방지, 서비스 안정성 확보",
    items: "접속 일시, 로그인 세션 정보(쿠키), 접속 IP의 해시값, 브라우저 정보(User-Agent), 요청 횟수 기록",
    retention: "세션은 최대 30일(로그아웃 시 즉시 삭제), 요청 횟수 기록은 이용 제한 판단 기간(최대 24시간)이 지난 뒤 순차 삭제, 동의 기록은 회원 탈퇴 시까지",
    basis: "계약 이행(법 제15조①4호)",
  },
];

/** 동의를 받아 처리하는 항목(선택). */
export const CONSENT_PROCESSING: ProcessingRow[] = [
  {
    purpose: "새 기능·이벤트 등 광고성 정보 이메일 발송",
    items: "이메일 주소, 이름",
    retention: "동의 철회 또는 회원 탈퇴 시까지",
    basis: "동의(법 제15조①1호, 정보통신망법 제50조①) — 선택",
  },
];

export interface TransferRow {
  /** 이전받는 자(수탁자) */
  recipient: string;
  /** 연락처(개인정보 문의 창구) */
  contact: string;
  /** 이전되는 국가 */
  country: string;
  /** 이전 일시·방법 */
  when: string;
  /** 이전 항목 */
  items: string;
  /** 이용 목적(위탁 업무) */
  purpose: string;
  /** 보유·이용 기간 */
  retention: string;
}

const TRANSFER_TIMING = "서비스 이용 시점에 암호화된 네트워크(TLS)로 전송";

/**
 * 처리위탁 겸 국외이전(법 제28조의8①3호). Neo4j 그래프 서버는 사업자가 국내에서 직접 운영하므로 이 표에 없다.
 * 수탁자 연락처·보관 국가는 각 사 공개 문서 기준 — 계약(DPA)·콘솔 설정으로 확인할 것(docs/LEGAL-NOTES.md).
 */
export const OVERSEAS_TRANSFERS: TransferRow[] = [
  {
    recipient: "Anthropic, PBC",
    contact: "privacy@anthropic.com",
    country: "미국",
    when: `AI 분석·작성 요청 시 ${TRANSFER_TIMING}`,
    items: "이력서·채용공고·경력 정보 등 AI 기능에 입력한 텍스트와 그 결과물, GitHub에서 가져온 저장소 정보",
    purpose: "AI 분석·작성 기능 처리(입력 정보는 AI 모델 학습에 쓰이지 않음)",
    retention: "처리 후 Anthropic 정책에 따라 최대 30일 보관 후 삭제(법령·정책 위반 대응 시 예외)",
  },
  {
    recipient: "Vercel Inc.",
    contact: "privacy@vercel.com",
    country: "미국(서비스 실행 지역: 대한민국 서울 리전)",
    when: `서비스 접속 시 ${TRANSFER_TIMING}`,
    items: "서비스 이용 과정의 모든 요청 정보(접속 IP, 브라우저 정보, 입력 내용)",
    purpose: "웹 서비스 호스팅·실행",
    retention: "위탁 계약 종료 시까지(접속 로그는 Vercel 정책에 따른 단기 보관)",
  },
  {
    recipient: "Supabase, Inc.",
    contact: "privacy@supabase.io",
    country: "미국 법인(데이터 저장 위치: 대한민국 서울 리전)",
    when: `회원 가입·서비스 이용 시 ${TRANSFER_TIMING}`,
    items: "회원 정보와 서비스 이용 중 저장되는 모든 정보(이력서 텍스트, 공고, 진단·작성 결과, 동의 기록 등)",
    purpose: "데이터베이스 보관·운영",
    retention: "회원 탈퇴 또는 위탁 계약 종료 시까지",
  },
  {
    recipient: "Cloudflare, Inc.",
    contact: "privacy@cloudflare.com",
    country: "미국 등 Cloudflare 데이터센터 소재국",
    when: `파일 업로드 시 ${TRANSFER_TIMING}`,
    items: "이용자가 올린 이력서·공고 파일, 생성한 PDF",
    purpose: "파일 저장(Cloudflare R2)",
    retention: "회원 탈퇴 또는 이용자가 해당 자료를 삭제할 때까지",
  },
  {
    recipient: "Google LLC",
    contact: "https://support.google.com/policies (개인정보 문의)",
    country: "미국",
    when: "Google 계정으로 가입·로그인할 때 인증 요청으로 전송",
    items: "로그인 요청 정보(서비스 식별자, 인증 상태 값). Google로부터 이메일·이름·계정 식별자를 받음",
    purpose: "Google 계정 로그인(본인 인증)",
    retention: "Google 개인정보처리방침에 따름",
  },
];

/** 국외이전을 거부하는 방법과 그 효과(시행령 제31조①2호). */
export const TRANSFER_REFUSAL =
  "국외 이전을 원하지 않으면 가입하지 않거나 회원 탈퇴로 거부할 수 있습니다. 위 이전은 서비스 제공(호스팅·저장·AI 처리)에 꼭 필요하므로, 거부하면 서비스를 이용할 수 없습니다. AI 분석이 필요 없는 정보는 입력하지 않는 방식으로 이전 범위를 줄일 수 있습니다.";
