import type { ResumeDocument } from "@/lib/domain/resumes";

/** 테스트용 이력서 문서(모든 섹션 채움). */
export function makeSampleResume(): ResumeDocument {
  return {
    basics: {
      name: "홍길동",
      headline: "백엔드 개발자",
      tagline: "결제·정산 지연을 줄여 온 5년 차 백엔드 개발자",
      totalExperience: "5년 2개월",
      email: "hong@example.com",
      phone: "010-0000-0000",
      location: "서울",
      portfolioUrl: "https://hong.dev",
      links: [{ label: "GitHub", url: "https://github.com/hong" }],
    },
    summary: "결제·정산 도메인에서 5년간 백엔드를 맡았습니다. [ADD: 대표 성과 한 줄]",
    headings: { highlights: "", experience: "", projects: "", skills: "", education: "" },
    highlights: [{ title: "정산 배치 처리 시간 4시간 → 40분 · 83% 단축", context: "2023년 월말 정산 / 배치 구조 재설계와 병렬화" }],
    experience: [
      {
        company: "페이랩",
        department: "결제플랫폼팀",
        title: "백엔드 개발자",
        startDate: "2021.03",
        endDate: "현재",
        location: "서울",
        scope: "결제 API와 정산 배치의 설계·운영을 맡았습니다.",
        bullets: ["결제 API 응답 시간을 40% 줄였습니다.", "정산 배치를 Kotlin으로 재작성해 처리 시간을 4시간에서 40분으로 줄였습니다."],
      },
    ],
    projects: [
      {
        name: "정산 자동화",
        company: "페이랩",
        team: "백엔드 3·기획 1",
        role: "리드",
        startDate: "2023.01",
        endDate: "2023.06",
        summary: "수기 정산을 자동화",
        problem: "대사 오류 로그로 수기 정산 누락을 확인.",
        action: "배치 단계를 나누고 재처리 기준을 정해 구현.",
        result: "6개월간 대사 오류 0건.",
        evidence: "사내 정산 대시보드",
        bullets: ["대사 오류 0건"],
        techs: ["Kotlin", "Spring Batch"],
      },
    ],
    skills: [
      { category: "백엔드", detail: "", items: ["Kotlin", "Spring", "MySQL"] },
      { category: "인프라", detail: "", items: ["AWS", "Kubernetes"] },
    ],
    education: [{ school: "한국대학교", degree: "학사", major: "컴퓨터공학", startDate: "2012.03", endDate: "2016.02", note: "" }],
    certifications: [{ name: "정보처리기사", issuer: "한국산업인력공단", date: "2016.05" }],
    extras: [{ title: "발표", items: ["사내 기술 세미나: 정산 배치 이야기"] }],
    motivation: "정산 지연을 줄여 온 경험을 결제 플랫폼에서 이어 가고 싶어 지원했습니다.\n\n입사 후에는 결제 API 안정화에 기여하겠습니다.",
  };
}
