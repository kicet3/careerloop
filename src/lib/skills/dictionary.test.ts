/** 키워드 사전. CareerLoop(src/lib/keywords.test.ts)에서 가져온 사례 + 가져오며 고친 오탐·정규화 사례. */
import { describe, expect, it } from "vitest";
import {
  aliasPattern,
  canonicalSkill,
  extractKeywordHits,
  extractKeywords,
  KEYWORD_DICTIONARY,
  matchKeywords,
  skillKey,
} from "./dictionary";

describe("키워드 추출", () => {
  it("공고 메모에서 기술 키워드를 뽑아낸다", () => {
    const keywords = extractKeywords("경력 1-5년 | Python · FastAPI · LangGraph · RAG · PostgreSQL");
    expect(keywords).toEqual(expect.arrayContaining(["Python", "FastAPI", "LangGraph", "RAG", "PostgreSQL"]));
  });

  it("한글 별칭도 인식한다", () => {
    expect(extractKeywords("파이썬과 쿠버네티스 운영 경험")).toEqual(expect.arrayContaining(["Python", "Kubernetes"]));
  });

  it("영문 키워드가 다른 단어에 포함되면 오탐하지 않는다", () => {
    // "Going"에 들어 있는 Go, "Javascripting"에 들어 있는 Java를 잡지 않아야 한다
    const keywords = extractKeywords("Going forward, Javascripting is fun");
    expect(keywords).not.toContain("Go");
    expect(keywords).not.toContain("Java");
  });

  it("중복 없이 한 번씩만, 처음 나온 순서로 돌려준다", () => {
    expect(extractKeywords("Docker 그리고 Python python 파이썬")).toEqual(["Docker", "Python"]);
  });

  it("빈 입력에는 빈 배열을 준다", () => {
    expect(extractKeywords("", "  ")).toEqual([]);
  });

  it("짧은 영어 이름은 대소문자를 구분해 흔한 단어를 잡지 않는다", () => {
    const keywords = extractKeywords("Let's go to the next step. Each graph node has a rest period.");
    expect(keywords).not.toContain("Go");
    expect(keywords).not.toContain("Next.js");
    expect(keywords).not.toContain("Node.js");
    expect(keywords).not.toContain("REST API");
    expect(extractKeywords("Go, Next, Node 경험")).toEqual(["Go", "Next.js", "Node.js"]);
  });

  it("Google은 Go가 아니다", () => {
    expect(extractKeywords("Google Analytics로 지표 분석")).toEqual(["Google Analytics"]);
    expect(extractKeywords("Google 출신")).not.toContain("Go");
  });

  it("겹치는 표기는 긴 쪽만 센다", () => {
    expect(extractKeywords("자바스크립트")).toEqual(["JavaScript"]);
    expect(extractKeywords("React Native 앱")).toEqual(["React Native"]);
    expect(extractKeywords("Next.js 14")).toEqual(["Next.js"]);
    expect(extractKeywords("GitHub Actions 파이프라인")).toEqual(["CI/CD"]);
  });

  it("버전 숫자가 붙은 표기는 잡는다", () => {
    expect(extractKeywords("Python3, Vue3")).toEqual(["Python", "Vue"]);
  });

  it("복리후생·일반 문구의 한국어 오탐을 막는다", () => {
    const keywords = extractKeywords("4대 보험, 교육비 지원, 영업일 기준 3일 이내 회신, 인터뷰 후 리뷰, 일러스트 작업");
    expect(keywords).toEqual([]);
    expect(extractKeywords("B2B 영업 경험자")).toEqual(["영업"]);
  });

  it("개발 밖 직군 키워드도 잡는다", () => {
    expect(extractKeywords("엑셀, SQL로 데이터 분석, 피그마 협업, 퍼포먼스 마케팅 운영")).toEqual([
      "Excel",
      "SQL",
      "데이터 분석",
      "Figma",
      "퍼포먼스 마케팅",
    ]);
  });

  it("MySQL·NoSQL 안의 SQL은 따로 세지 않는다", () => {
    expect(extractKeywords("MySQL, NoSQL")).toEqual(["MySQL"]);
  });

  it("처음 나온 위치를 함께 돌려준다", () => {
    const hits = extractKeywordHits("요건: Kotlin, 우대: Kotlin 코루틴");
    expect(hits).toEqual([{ label: "Kotlin", index: 4, text: "Kotlin" }]);
  });

  it("모든 별칭이 올바른 정규식이 된다", () => {
    for (const e of KEYWORD_DICTIONARY) for (const a of [...e.aliases, ...e.exact]) expect(() => new RegExp(aliasPattern(a))).not.toThrow();
    const labels = KEYWORD_DICTIONARY.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("canonicalSkill", () => {
  it("표기가 달라도 정식 명칭으로 맞춘다", () => {
    expect(canonicalSkill("리액트")).toBe("React");
    expect(canonicalSkill("react")).toBe("React");
    expect(canonicalSkill("Next")).toBe("Next.js");
    expect(canonicalSkill("nextjs")).toBe("Next.js");
    expect(canonicalSkill("Next JS")).toBe("Next.js");
    expect(canonicalSkill("node.js")).toBe("Node.js");
    expect(canonicalSkill("k8s")).toBe("Kubernetes");
    expect(canonicalSkill(" 엑셀 ")).toBe("Excel");
  });

  it("Go는 잡고 Google은 잡지 않는다", () => {
    expect(canonicalSkill("Go")).toBe("Go");
    expect(canonicalSkill("go")).toBe("Go");
    expect(canonicalSkill("Golang")).toBe("Go");
    expect(canonicalSkill("Google")).toBeNull();
  });

  it("끝의 버전·괄호를 떼고 본다", () => {
    expect(canonicalSkill("React 18")).toBe("React");
    expect(canonicalSkill("Python3")).toBe("Python");
    expect(canonicalSkill("Vue 3.x")).toBe("Vue");
    expect(canonicalSkill("Java (Spring)")).toBe("Java");
    expect(canonicalSkill("C++17")).toBe("C++");
  });

  it("사전에 없거나 둘 이상이면 null", () => {
    expect(canonicalSkill("사내 결재 시스템")).toBeNull();
    expect(canonicalSkill("Python·Django")).toBeNull();
    expect(canonicalSkill("")).toBeNull();
  });

  it("skillKey는 사전에 없으면 압축 키", () => {
    expect(skillKey("리액트")).toBe("React");
    expect(skillKey("Supa Base")).toBe("supabase");
  });
});

describe("역량 매칭", () => {
  it("보유·미보유 키워드를 나누고 점수를 낸다", () => {
    const result = matchKeywords(["Python", "FastAPI", "Kubernetes", "CUDA"], ["python", "FastAPI", "React"]);
    expect(result.matched).toEqual(["Python", "FastAPI"]);
    expect(result.missing).toEqual(["Kubernetes", "CUDA"]);
    expect(result.score).toBe(50);
  });

  it("표기가 다른 같은 기술은 보유로 본다", () => {
    expect(matchKeywords(["React", "Next.js"], ["리액트", "nextjs"]).score).toBe(100);
  });

  it("요구 키워드가 없으면 점수는 null이다", () => {
    expect(matchKeywords([], ["Python"]).score).toBeNull();
  });
});
