/**
 * 보고서 픽스처: 3년차 백엔드 개발자가 핀테크 결제 백엔드 공고에 지원하는 예시.
 * report 단위 테스트, PDF 렌더러(워크스트림 E), 통합 화면 확인에 함께 쓴다.
 * 인용은 SAMPLE_RESUME 원문 그대로이며, rival의 worstLine만 일부러 원문에 없는 문장(검증 실패 표시 확인용)이다.
 */
import type { Diagnosis, DiagnosisStage } from "@/lib/db/schema";
import { STAGE_KEYS, type StageKey, type StageOutputs } from "@/lib/domain/schemas";
import { buildReportModel } from "../model";
import type { ReportModel } from "../types";

export const SAMPLE_RESUME = `김민준
백엔드 개발자 | minjun.kim@example.com | 010-1234-5678 | github.com/minjun-dev

요약
3년차 백엔드 개발자. Java/Spring 기반 서비스 개발 경험.

경력
(주)바른커머스 — 백엔드 개발자 (2022.03 ~ 현재)
- 주문/결제 API 개발 및 유지보수
- 레거시 정산 배치를 Spring Batch로 이관하여 처리 시간 단축
- 신규 입사자 온보딩 문서 작성
- 다양한 업무 수행

(주)스마트로지 — 인턴 (2021.07 ~ 2021.12)
- 사내 어드민 페이지 개발 참여

프로젝트
쿠폰 발급 시스템 개선
- Redis 분산 락을 도입해 중복 발급 문제 해결
- 팀원들과 협업하여 성공적으로 출시

기술
Java, Spring Boot, JPA, MySQL, Redis, Docker, Git

학력
한빛대학교 컴퓨터공학과 졸업 (2022.02)`;

export const SAMPLE_JD = `[머니브릿지] 결제 플랫폼 백엔드 엔지니어 (경력 3년 이상)
주요 업무
- 결제·정산 시스템 설계 및 개발
- 대용량 트래픽 환경에서의 안정적인 API 운영
자격 요건
- Java 또는 Kotlin, Spring 기반 백엔드 개발 경력 3년 이상
- 결제/정산 등 금융 도메인 또는 대용량 트래픽 처리 경험
- RDBMS 스키마 설계 및 쿼리 튜닝 경험
- AWS 등 클라우드 환경에서의 서비스 운영 경험
우대 사항
- Kotlin 실무 경험
- Kafka 등 메시지 큐 기반 비동기 처리 경험
- MSA 환경 개발 경험`;

export const SAMPLE_OUTPUTS: StageOutputs = {
  jd: {
    source: "jd",
    roleTitle: "결제 플랫폼 백엔드 엔지니어",
    company: "머니브릿지",
    seniority: "주니어~미들(3년+)",
    summary:
      "결제·정산 시스템을 직접 설계하고 운영해 본 3년 이상 백엔드 개발자를 찾는다. 트래픽이 몰려도 돈이 틀리지 않게 만드는 사람이 핵심이다.",
    mustHave: [
      {
        id: "R1",
        text: "Java/Kotlin + Spring 백엔드 개발 3년 이상",
        category: "skill",
        jdQuote: "Java 또는 Kotlin, Spring 기반 백엔드 개발 경력 3년 이상",
      },
      {
        id: "R2",
        text: "결제·정산 도메인 또는 대용량 트래픽 처리 경험",
        category: "domain",
        jdQuote: "결제/정산 등 금융 도메인 또는 대용량 트래픽 처리 경험",
      },
      {
        id: "R3",
        text: "RDBMS 스키마 설계 및 쿼리 튜닝",
        category: "skill",
        jdQuote: "RDBMS 스키마 설계 및 쿼리 튜닝 경험",
      },
      {
        id: "R4",
        text: "AWS 등 클라우드 운영 경험",
        category: "experience",
        jdQuote: "AWS 등 클라우드 환경에서의 서비스 운영 경험",
      },
    ],
    niceToHave: [
      { id: "R5", text: "Kotlin 실무 경험", category: "skill", jdQuote: "Kotlin 실무 경험" },
      {
        id: "R6",
        text: "Kafka 등 메시지 큐 기반 비동기 처리",
        category: "skill",
        jdQuote: "Kafka 등 메시지 큐 기반 비동기 처리 경험",
      },
      { id: "R7", text: "MSA 환경 개발 경험", category: "experience", jdQuote: "MSA 환경 개발 경험" },
    ],
    keywords: ["Java", "Kotlin", "Spring", "결제", "정산", "대용량 트래픽", "RDBMS", "쿼리 튜닝", "AWS", "Kafka", "MSA"],
    responsibilities: ["결제·정산 시스템 설계 및 개발", "대용량 트래픽 환경에서의 안정적인 API 운영"],
    hiddenSignals: [
      "'결제/정산 또는 대용량 트래픽'으로 묶여 있지만 주요 업무가 결제·정산이라 실제로는 도메인 경험을 더 크게 볼 가능성이 높다.",
      "운영(on-call) 언급은 없지만 '안정적인 API 운영'이 주요 업무라 장애 대응 경험을 면접에서 물을 것이다.",
    ],
  },
  ats: {
    verdict: "REJECT",
    oneLiner: "결제 경험은 보이지만 AWS·Kafka·쿼리 튜닝 등 공고 핵심어가 빠져 필터 점수가 기준에 못 미친다.",
    reasons: [
      { quote: "Java, Spring Boot, JPA, MySQL, Redis, Docker, Git", issue: "공고 필수 키워드인 AWS와 우대 키워드 Kafka·Kotlin이 기술 목록에 없다." },
      { quote: "- 주문/결제 API 개발 및 유지보수", issue: "'결제'는 있으나 '정산 시스템 설계', '대용량 트래픽' 같은 공고 표현과 연결되지 않는다." },
      { quote: "- 다양한 업무 수행", issue: "키워드도 성과도 없는 줄이라 필터 관점에서 순수한 잡음이다." },
    ],
    keywordsPresent: ["Java", "Spring", "결제", "정산", "RDBMS(MySQL)"],
    keywordsMissing: ["Kotlin", "AWS", "Kafka", "MSA", "대용량 트래픽", "쿼리 튜닝"],
    parseIssues: ["'요약' 섹션 제목은 읽히지만 경력 항목 회사명과 직함이 한 줄에 대시로 붙어 있어 일부 ATS가 직함을 놓칠 수 있다."],
    contactOk: true,
    titlesAndDatesClear: true,
  },
  gatekeeper: {
    verdict: "INTERVIEW",
    oneLiner: "결제 API와 정산 배치를 실제로 만졌다는 점 하나로 면접 문턱은 넘는다. 다만 숫자가 없어 우선순위는 낮다.",
    firstTenSeconds: "'주문/결제 API'와 '정산 배치'라는 단어가 공고와 바로 겹쳐서 넘기지 않고 끝까지 읽었다.",
    interviewQuestions: [
      "정산 배치 처리 시간을 얼마에서 얼마로 줄였나요? 병목은 무엇이었나요?",
      "결제 API에서 중복 결제나 금액 불일치를 어떻게 막았나요?",
      "Redis 분산 락에서 락 획득 실패와 만료 문제는 어떻게 처리했나요?",
    ],
    weakestLines: [
      { quote: "- 레거시 정산 배치를 Spring Batch로 이관하여 처리 시간 단축", issue: "가장 좋은 소재인데 얼마나 단축했는지가 없다." },
      { quote: "- 다양한 업무 수행", issue: "아무 정보가 없는 줄이다. 읽는 사람은 '할 말이 없었구나'로 받아들인다." },
      { quote: "- 팀원들과 협업하여 성공적으로 출시", issue: "본인 몫과 결과가 빠진 상투구다." },
    ],
  },
  manager: {
    verdict: "MAYBE",
    oneLiner: "결제 코드를 만져 본 건 맞지만, 첫날부터 정산 시스템을 맡길 수 있다는 증거는 부족하다.",
    worstLine: { quote: "- 주문/결제 API 개발 및 유지보수", issue: "어떤 규모의 결제를, 어떤 책임 범위로 다뤘는지 알 수 없다." },
    otherProblems: ["트래픽 규모(TPS, 일 거래 건수)가 어디에도 없다.", "장애 대응이나 운영 경험이 드러나지 않는다."],
  },
  rival: {
    verdict: "PASS",
    oneLiner: "같은 3년차라면 나는 숫자로 쓴 정산 개선 사례가 있어서 이 이력서보다 앞선다.",
    worstLine: { quote: "결제 시스템 전반 담당", issue: "범위만 크고 근거가 없어 과장으로 읽힌다." },
    otherProblems: ["AWS 경험이 없어 보여 클라우드 운영 요건에서 밀린다.", "Kotlin을 써 본 흔적이 없다."],
  },
  ceo: {
    verdict: "PASS",
    oneLiner: "무엇을 바꿨는지는 보이는데 얼마나 바꿨는지가 하나도 없다.",
    worstLine: { quote: "- 레거시 정산 배치를 Spring Batch로 이관하여 처리 시간 단축", issue: "임팩트의 크기가 없으면 임팩트가 없는 것과 같다." },
    otherProblems: ["쿠폰 중복 발급 해결이 매출·비용에 준 영향이 없다.", "3년 동안의 성과가 두세 줄에 머문다."],
  },
  recruiter: {
    verdict: "MAYBE",
    oneLiner: "상단 요약이 '3년차 백엔드 개발자'뿐이라 30초 안에 결제 전문성을 못 알아본다.",
    worstLine: { quote: "3년차 백엔드 개발자. Java/Spring 기반 서비스 개발 경험.", issue: "누구에게나 해당하는 문장이라 상단 3분의 1을 낭비한다." },
    otherProblems: ["결제·정산이라는 가장 강한 키워드가 요약에 없다.", "기술 목록이 공고 순서와 무관하게 나열돼 있다."],
  },
  teammate: {
    verdict: "HIRE",
    oneLiner: "온보딩 문서를 쓰고 레거시를 정리한 사람이면 옆자리에 두고 싶다.",
    worstLine: { quote: "- 팀원들과 협업하여 성공적으로 출시", issue: "협업에서 본인이 맡은 역할이 보이지 않는다." },
    otherProblems: ["코드 리뷰나 기술 공유 경험이 있다면 드러나지 않는다."],
  },
  fit: {
    matchScore: 58,
    summary: "언어·프레임워크와 결제 도메인은 맞지만, 클라우드 운영과 규모 증거가 비어 있어 필수요건 4개 중 2개만 확실하다.",
    items: [
      { requirementId: "R1", status: "met", evidenceQuote: "(주)바른커머스 — 백엔드 개발자 (2022.03 ~ 현재)", note: "Java/Spring 3년차로 기간 요건을 충족한다." },
      { requirementId: "R2", status: "partial", evidenceQuote: "- 주문/결제 API 개발 및 유지보수", note: "결제 도메인 경험은 있으나 규모·책임 범위가 없다. 거래량을 적으면 충족으로 바뀐다." },
      { requirementId: "R3", status: "partial", evidenceQuote: "Java, Spring Boot, JPA, MySQL, Redis, Docker, Git", note: "MySQL 사용은 보이지만 설계·튜닝 사례가 없다." },
      { requirementId: "R4", status: "missing", evidenceQuote: null, note: "클라우드 운영 흔적이 없다. 실제 경험이 있다면 반드시 적어야 한다." },
      { requirementId: "R5", status: "missing", evidenceQuote: null, note: "Kotlin 언급이 없다." },
      { requirementId: "R6", status: "missing", evidenceQuote: null, note: "메시지 큐 경험이 드러나지 않는다." },
      { requirementId: "R7", status: "missing", evidenceQuote: null, note: "서비스 구조(모놀리스/MSA)에 대한 언급이 없다." },
    ],
    untappedStrengths: [
      "Redis 분산 락으로 중복 발급을 막은 경험은 결제의 '중복 결제 방지'와 같은 문제라 R2 근거로 재배치할 수 있다.",
      "정산 배치 이관은 '정산 시스템 설계' 업무와 직접 맞닿아 있다.",
    ],
  },
  synthesis: {
    headline: "결제·정산 실무라는 좋은 재료를 갖고도 숫자와 공고 키워드가 없어 서류 필터에서 먼저 떨어지는 이력서입니다.",
    strengths: [
      "결제 API와 정산 배치를 직접 다룬 경험이 공고 주요 업무와 정확히 겹친다.",
      "Redis 분산 락으로 동시성 문제를 해결한 구체적인 기술 사례가 있다.",
    ],
    mistakes: [
      {
        rank: 2,
        title: "가장 강한 성과에 숫자가 없다",
        quote: "- 레거시 정산 배치를 Spring Batch로 이관하여 처리 시간 단축",
        why: "얼마나 줄였는지 없으면 대표·팀장은 임팩트가 작았다고 가정한다.",
        fix: "이관 전후 처리 시간과 처리 건수를 적는다(예: 4시간 → 40분, 일 120만 건).",
        severity: "critical",
        flaggedBy: ["ceo", "gatekeeper", "manager"],
      },
      {
        rank: 1,
        title: "공고 핵심 키워드(AWS·Kafka·트래픽 규모)가 빠져 서류 필터에서 탈락",
        quote: "Java, Spring Boot, JPA, MySQL, Redis, Docker, Git",
        why: "사람이 읽기 전에 ATS가 걸러 내므로 다른 강점이 보일 기회 자체가 없다.",
        fix: "실제로 써 본 클라우드·메시징 도구를 기술 목록과 경력 문장 안에 공고 표현 그대로 넣는다.",
        severity: "critical",
        flaggedBy: ["ats", "rival"],
      },
      {
        rank: 3,
        title: "상단 요약이 누구에게나 해당하는 문장이다",
        quote: "3년차 백엔드 개발자. Java/Spring 기반 서비스 개발 경험.",
        why: "리크루터는 상단 3분의 1만 읽는데 거기에 결제·정산이 없다.",
        fix: "'결제·정산 시스템을 3년간 개발·운영한 백엔드 개발자'처럼 도메인을 첫 줄에 둔다.",
        severity: "major",
        flaggedBy: ["recruiter"],
      },
      {
        rank: 4,
        title: "정보가 없는 줄과 상투구",
        quote: "- 다양한 업무 수행",
        why: "공간만 차지하고 '쓸 게 없었다'는 신호를 준다.",
        fix: "삭제하거나 구체적인 업무 하나로 바꾼다.",
        severity: "major",
        flaggedBy: ["ats", "gatekeeper", "teammate"],
      },
      {
        rank: 5,
        title: "회사·직함이 한 줄에 붙어 파싱 위험",
        quote: null,
        why: "일부 ATS가 직함을 회사명의 일부로 읽어 경력 연차 계산이 틀어질 수 있다.",
        fix: "회사명과 직함·기간을 별도 줄로 나눈다.",
        severity: "minor",
        flaggedBy: ["ats"],
      },
    ],
    closestToReject: null,
  },
  rewrite: {
    resumeMarkdown: `# 김민준
백엔드 개발자 · minjun.kim@example.com · 010-1234-5678 · github.com/minjun-dev

## 요약
결제·정산 시스템을 3년간 개발·운영한 **Java/Spring 백엔드 개발자**. 레거시 정산 배치 이관과 Redis 분산 락 기반 중복 방지로 **돈이 틀리지 않는 시스템**을 만들어 왔습니다.

## 경력
### (주)바른커머스
백엔드 개발자 · 2022.03 ~ 현재
- 주문/결제 API 개발 및 운영 (일 거래 [ADD: 일 평균 결제 건수], 피크 [ADD: 피크 TPS])
- 레거시 정산 배치를 Spring Batch로 이관, 처리 시간 [ADD: 이관 전 시간] → [ADD: 이관 후 시간] 단축
- 신규 입사자 온보딩 문서 작성으로 팀 온보딩 기간 단축

### (주)스마트로지
인턴 · 2021.07 ~ 2021.12
- 사내 어드민 페이지 개발 참여

## 프로젝트
### 쿠폰 발급 시스템 개선
- Redis 분산 락을 도입해 동시 요청 시 **중복 발급 문제 해결** (중복 발급 [ADD: 개선 전 건수] → 0건)
- 락 설계와 [ADD: 본인이 맡은 범위] 담당, 출시까지 리드

## 기술
Java, Spring Boot, Spring Batch, JPA, MySQL, Redis, Docker, Git, [ADD: 실제 사용한 클라우드(AWS 등)]

## 학력
한빛대학교 컴퓨터공학과 졸업 (2022.02)`,
    changes: [
      { mistakeRank: 3, before: "3년차 백엔드 개발자. Java/Spring 기반 서비스 개발 경험.", after: "결제·정산 시스템을 3년간 개발·운영한 Java/Spring 백엔드 개발자." },
      { mistakeRank: 2, before: "- 레거시 정산 배치를 Spring Batch로 이관하여 처리 시간 단축", after: "- 레거시 정산 배치를 Spring Batch로 이관, 처리 시간 [ADD: 이관 전 시간] → [ADD: 이관 후 시간] 단축" },
      { mistakeRank: 4, before: "- 다양한 업무 수행", after: "(삭제)" },
      { mistakeRank: 5, before: "(주)바른커머스 — 백엔드 개발자 (2022.03 ~ 현재)", after: "### (주)바른커머스 / 백엔드 개발자 · 2022.03 ~ 현재" },
      { mistakeRank: 1, before: null, after: "기술 목록에 Spring Batch 추가, 클라우드 경험 자리표시" },
    ],
    addQuestions: [
      "결제 API가 처리한 일 평균 결제 건수와 피크 TPS는 얼마였나요?",
      "정산 배치 이관 전후 처리 시간은 각각 얼마였나요?",
      "쿠폰 중복 발급은 개선 전 얼마나 발생했나요?",
      "쿠폰 프로젝트에서 본인이 맡은 범위는 어디까지였나요?",
      "AWS 등 클라우드에서 서비스를 운영해 본 적이 있나요? 있다면 어떤 서비스를 썼나요?",
    ],
    assumptions: ["온보딩 문서가 '온보딩 기간 단축'에 기여했다고 추정했습니다. 사실이 아니면 원래 문장으로 되돌리세요."],
  },
  plan: {
    headline: "'백엔드 개발자'가 아니라 '결제·정산을 숫자로 증명하는 개발자'로 포지셔닝을 바꾸세요.",
    positioning:
      "지금 이력서는 범용 백엔드 개발자로 읽힙니다. 하지만 경력의 핵심은 결제 API와 정산 배치, 그리고 중복 방지라는 금융 도메인의 본질적인 문제입니다. 상단 요약과 경력 첫 줄을 모두 이 축으로 정렬하고, 각 성과에 규모와 전후 수치를 붙이면 공고가 찾는 '돈이 틀리지 않게 만드는 사람'과 정확히 겹칩니다.",
    priorities: [
      {
        title: "정산·결제 성과에 숫자 붙이기",
        why: "대표·팀장·채용 담당자 3명이 공통으로 지적한 가장 큰 감점 요인입니다.",
        actions: ["정산 배치 이관 전후 처리 시간과 건수를 확인해 적는다.", "결제 API의 일 거래 건수·피크 TPS를 모니터링 대시보드에서 찾아 적는다."],
        impact: "high",
        effort: "low",
      },
      {
        title: "공고 키워드 반영",
        why: "ATS 탈락의 직접 원인입니다. 사람이 읽기 전에 걸러집니다.",
        actions: ["실제 사용한 AWS 서비스를 기술 목록과 경력 문장에 넣는다.", "Spring Batch, 쿼리 튜닝 사례를 공고 표현 그대로 적는다."],
        impact: "high",
        effort: "low",
      },
      {
        title: "클라우드 운영 경험 만들기",
        why: "필수요건 R4가 비어 있어 같은 연차 경쟁자에게 밀립니다.",
        actions: ["개인 프로젝트를 AWS(ECS, RDS)에 배포하고 모니터링까지 구성한다.", "사내에서 배포·운영 업무에 참여할 기회를 요청한다."],
        impact: "high",
        effort: "high",
      },
    ],
    quickWins: [
      "'- 다양한 업무 수행' 줄을 삭제한다.",
      "상단 요약 첫 문장에 '결제·정산'을 넣는다.",
      "회사명과 직함·기간을 별도 줄로 나눈다.",
      "기술 목록에 Spring Batch를 추가한다.",
    ],
    sectionGuidance: [
      { section: "상단 요약", direction: "도메인(결제·정산) + 연차 + 대표 성과 1개를 2문장 안에." },
      { section: "경력", direction: "각 줄을 '무엇을 → 어떻게 → 얼마나' 순서로. 숫자가 없으면 [ADD]로 남겨 확인한다." },
      { section: "프로젝트", direction: "쿠폰 분산 락 사례를 '중복 결제 방지'와 같은 문제로 연결해 설명한다." },
      { section: "기술", direction: "공고 순서(언어 → 프레임워크 → DB → 클라우드 → 메시징)로 재배열한다." },
    ],
    skillGaps: [
      { skill: "AWS 운영", requirementId: "R4", howToClose: "개인 서비스를 ECS + RDS로 배포하고 CloudWatch 알람까지 구성해 README에 정리한다.", timeframe: "3~4주" },
      { skill: "Kafka 비동기 처리", requirementId: "R6", howToClose: "정산 이벤트를 Kafka로 발행·소비하는 토이 프로젝트를 만들고 재처리 전략을 문서화한다.", timeframe: "2주" },
      { skill: "Kotlin", requirementId: "R5", howToClose: "기존 Spring 프로젝트 일부 모듈을 Kotlin으로 옮겨 본다.", timeframe: "1~2주" },
    ],
    applicationStrategy: [
      "커버레터 첫 문단에 정산 배치 개선 수치를 넣어 공고의 '결제·정산 시스템 설계'와 바로 연결한다.",
      "GitHub에 분산 락 설계 문서(문제·대안·선택 이유)를 올리고 이력서에 링크한다.",
      "AWS 운영 경험이 생기기 전이라면 '대용량 트래픽' 쪽 근거를 최대한 숫자로 보강해 R2로 승부한다.",
    ],
    interviewPrep: [
      { question: "결제 API에서 중복 결제를 어떻게 막았나요?", angle: "멱등 키와 Redis 분산 락 경험을 연결하고, 락 만료·재시도 처리까지 설명한다." },
      { question: "정산 배치 이관에서 가장 어려웠던 점은?", angle: "청크 크기·병목 지점과 전후 처리 시간 수치로 답한다." },
      { question: "장애를 겪어 본 적이 있나요?", angle: "실제 장애 사례 하나를 탐지 → 원인 → 재발 방지 순서로 준비한다." },
    ],
  },
  rescreen: {
    verdict: "PASS",
    oneLiner: "결제·정산 키워드가 상단과 경력에 정렬되어 필터를 통과한다. AWS는 답변에 따라 보강 필요.",
    reasons: [
      { quote: "결제·정산 시스템을 3년간 개발·운영한 Java/Spring 백엔드 개발자", issue: "공고의 도메인과 연차 요건이 첫 줄에서 바로 확인된다." },
    ],
    keywordsPresent: ["Java", "Spring", "Spring Batch", "결제", "정산", "MySQL", "Redis"],
    keywordsMissing: ["Kafka", "Kotlin"],
    parseIssues: [],
    contactOk: true,
    titlesAndDatesClear: true,
  },
};

export const SAMPLE_CREATED_AT = new Date("2026-10-20T05:30:00.000Z");

export function makeSampleDiagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return {
    id: "dg_sample01",
    userId: "u_sample01",
    title: "머니브릿지 결제 백엔드 지원",
    targetRole: "결제 플랫폼 백엔드 엔지니어",
    situation: "general",
    notes: null,
    jdText: SAMPLE_JD,
    resumeText: SAMPLE_RESUME,
    resumeFileName: "김민준_이력서.pdf",
    status: "done",
    error: null,
    shareToken: null,
    model: "claude-opus-5-5",
    usage: null,
    createdAt: SAMPLE_CREATED_AT,
    updatedAt: new Date("2026-10-20T05:34:10.000Z"),
    completedAt: new Date("2026-10-20T05:34:10.000Z"),
    ...overrides,
  };
}

/** 13개 단계 행. omit에 넣은 단계는 pending(출력 없음)으로 만든다. */
export function makeSampleStages(opts: { omit?: StageKey[]; outputs?: Partial<StageOutputs> } = {}): DiagnosisStage[] {
  const omit = new Set(opts.omit ?? []);
  const outputs = { ...SAMPLE_OUTPUTS, ...opts.outputs };
  return STAGE_KEYS.map((stage, i) => {
    const done = !omit.has(stage);
    return {
      id: i + 1,
      diagnosisId: "dg_sample01",
      stage,
      status: done ? "done" : "pending",
      output: done ? outputs[stage] : null,
      error: null,
      startedAt: done ? SAMPLE_CREATED_AT : null,
      finishedAt: done ? SAMPLE_CREATED_AT : null,
    };
  });
}

/** 모든 단계가 완료된 예시 보고서. */
export function makeSampleReport(): ReportModel {
  return buildReportModel(makeSampleDiagnosis(), makeSampleStages());
}
