import Link from "next/link";
import { Logo } from "@/components/app/Logo";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { getCurrentUser } from "@/lib/auth/session";
import { REVIEWERS, verdictLabel, type VerdictTone } from "@/lib/domain/reviewers";
import { REVIEWER_IDS, type ReviewerId } from "@/lib/domain/schemas";

const TONE_TO_BADGE: Record<VerdictTone, BadgeTone> = {
  positive: "positive",
  neutral: "warning",
  negative: "negative",
};

/** 랜딩용 가상의 예시. 실제 진단 결과가 아니다. */
const SAMPLE_ONE_LINERS: { id: ReviewerId; verdict: string; text: string }[] = [
  { id: "ats", verdict: "REJECT", text: "공고의 핵심 키워드 'Kubernetes'·'gRPC'가 이력서 어디에도 없습니다." },
  { id: "gatekeeper", verdict: "NO", text: "첫 10초에 보이는 건 직함뿐, 무엇을 해냈는지가 없습니다." },
  { id: "manager", verdict: "MAYBE", text: "API 설계 경험은 보이지만 운영 규모를 알 수 없어 첫날 맡기기 불안합니다." },
  { id: "rival", verdict: "PASS", text: "'성능 개선에 기여' — 몇 %인지 쓴 제 이력서가 이깁니다." },
  { id: "ceo", verdict: "PASS", text: "바꾼 것의 크기가 숫자로 하나도 없습니다." },
  { id: "recruiter", verdict: "MAYBE", text: "상단 3분의 1이 자기소개 문단이라 경력이 화면 밖으로 밀려났습니다." },
  { id: "teammate", verdict: "HIRE", text: "코드 리뷰 문화를 만든 경험은 같이 일하고 싶게 만듭니다." },
];

const DELIVERABLES = [
  {
    title: "JD 분석 · 적합도 매트릭스",
    body: "공고에서 필수·우대 요건과 ATS 키워드를 뽑고, 요건마다 충족 / 부분 / 미충족을 이력서 원문 인용과 함께 표로 보여줍니다. 적합도 점수(0~100)와 아직 JD와 연결하지 못한 강점도 짚습니다.",
    highlight: true,
  },
  {
    title: "심사위원 7명의 판정",
    body: "서로의 의견을 보지 않고 각자 읽은 7명의 판정과 한 줄 평, 가장 치명적인 줄을 인용합니다.",
  },
  {
    title: "심각도순 문제 목록",
    body: "겹치는 지적을 하나로 합치고, 가장 떨어뜨리는 문제부터 — 어느 줄인지, 왜 떨어지는지, 어떻게 고칠지, 누가 지적했는지.",
  },
  {
    title: "개선 방향성",
    body: "포지셔닝, 임팩트×노력 우선순위, 오늘 30분 안에 고칠 것, 섹션별 가이드, 역량 공백과 메우는 법, 지원 전략, 면접 대비 질문.",
  },
  {
    title: "다시 쓴 이력서 + 재심사",
    body: "같은 사실로 모든 문제를 고친 이력서. 모르는 사실은 [ADD: 질문]으로 남기고, 서류 필터에 다시 넣어 전·후 판정을 비교합니다.",
  },
  {
    title: "웹 보고서 · PDF",
    body: "한 화면에서 보는 구조화된 보고서와 PDF 다운로드, 원본 스킬과 같은 PANEL.md / RESUME-IMPROVED.md, 읽기 전용 공유 링크.",
  },
];

const STEPS = [
  { title: "이력서와 JD 넣기", body: "PDF·DOCX·TXT·MD 파일이나 붙여넣기. 지원 직무와 채용 공고를 함께 넣습니다." },
  { title: "JD 분석", body: "공고에서 요건 R1…Rn과 키워드를 뽑습니다. 공고가 없으면 직무명으로 추정하고 그렇게 표시합니다." },
  { title: "7명 + 적합도, 동시에", body: "심사위원 7명과 적합도 분석이 서로를 보지 않고 동시에 이력서를 읽습니다." },
  { title: "종합 → 재작성 · 방향성", body: "지적을 합쳐 순위를 매기고, 같은 사실로 다시 쓰고, 개선 방향을 세웁니다." },
  { title: "재심사와 보고서", body: "다시 쓴 이력서를 서류 필터에 넣어 전·후를 비교하고 보고서로 정리합니다. 보통 3~5분." },
];

const SAMPLE_FIT = [
  { req: "R1 · Go 또는 Java 백엔드 3년 이상", status: "met" as const, quote: "Go 기반 결제 API 개발·운영 (2021.03 – 현재)" },
  { req: "R2 · Kubernetes 운영 경험", status: "missing" as const, quote: null },
  { req: "R3 · 대용량 트래픽 처리", status: "partial" as const, quote: "트래픽 증가에 대응하여 캐시 도입" },
];

const FIT_VIEW = {
  met: { label: "충족", tone: "positive" as const },
  partial: { label: "부분", tone: "warning" as const },
  missing: { label: "미충족", tone: "negative" as const },
};

export default async function Home() {
  const user = await getCurrentUser();
  const primaryHref = user ? "/app/new" : "/signup";
  const primaryLabel = user ? "새 진단 시작" : "무료로 시작하기";

  return (
    <>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Logo />
          <nav aria-label="계정" className="flex items-center gap-2">
            {user ? (
              <Link href="/app" className={buttonClass("secondary", "sm")}>
                내 진단
              </Link>
            ) : (
              <>
                <Link href="/login" className={buttonClass("ghost", "sm")}>
                  로그인
                </Link>
                <Link href="/signup" className={buttonClass("primary", "sm")}>
                  회원가입
                </Link>
              </>
            )}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        {/* 히어로 */}
        <section className="border-b border-slate-200 bg-white">
          <div className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
            <Badge tone="accent">AI 심사위원 7명 · JD 적합도 분석</Badge>
            <h1 className="mt-5 max-w-3xl text-3xl leading-tight font-bold tracking-tight text-slate-900 sm:text-5xl sm:leading-tight">
              내 이력서를 떨어뜨리려는
              <br />
              심사위원 7명에게 먼저 보여 주세요
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-lg">
              서류 필터부터 팀장, 경쟁 지원자, 대표까지 — 7명이 각자 떨어뜨릴 이유를 찾습니다. 지원할 공고(JD)와
              요건별로 맞춰 보고, 무엇을 어떤 순서로 고칠지 정리한 뒤, 같은 사실로 다시 쓴 이력서까지 드립니다.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href={primaryHref} className={buttonClass("primary", "lg")}>
                {primaryLabel}
              </Link>
              <a href="#how" className={buttonClass("secondary", "lg")}>
                어떻게 동작하나요
              </a>
            </div>
          </div>
        </section>

        {/* 심사위원 7명 */}
        <Section
          id="panel"
          eyebrow="심사위원단"
          title="서로 다른 7개의 시선, 서로의 의견은 보지 않습니다"
          lead="각 심사위원은 이력서와 JD 분석만 받고 독립적으로 판정합니다. 칭찬하려고 읽지 않습니다."
        >
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {REVIEWER_IDS.map((id, i) => {
              const r = REVIEWERS[id];
              return (
                <li key={id}>
                  <Card className="h-full p-4">
                    <div className="flex items-center gap-2">
                      <span className="grid size-6 place-items-center rounded-full bg-indigo-50 text-xs font-bold text-indigo-700">
                        {i + 1}
                      </span>
                      <h3 className="font-semibold text-slate-900">{r.name}</h3>
                    </div>
                    <p className="mt-2 text-sm leading-relaxed text-slate-600">{r.role}</p>
                    <p className="mt-3 flex flex-wrap gap-1">
                      {Object.values(r.verdicts).map((v) => (
                        <Badge key={v.label} tone={TONE_TO_BADGE[v.tone]}>
                          {v.label}
                        </Badge>
                      ))}
                    </p>
                  </Card>
                </li>
              );
            })}
          </ul>
        </Section>

        {/* JD 분석 강조 */}
        <Section
          id="jd"
          eyebrow="JD 분석"
          title="공고와 함께 넣으면, 요건 하나하나를 맞춰 봅니다"
          lead="JD를 넣으면 서류 필터가 공고 키워드로 심사하고, 요건별 적합도 매트릭스와 공고에 맞춘 개선 방향이 나옵니다. JD가 없으면 직무명으로 요건을 추정하고 보고서에 '추정'으로 표시합니다."
          muted
        >
          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <p className="text-sm font-semibold text-slate-900">적합도 매트릭스 예시</p>
              <p className="text-sm text-slate-500">
                적합도 <span className="font-semibold text-slate-900">58</span>/100 · 충족 1 · 부분 1 · 미충족 1
              </p>
            </div>
            <ul className="divide-y divide-slate-100">
              {SAMPLE_FIT.map((row) => (
                <li key={row.req} className="grid gap-2 px-4 py-3 sm:grid-cols-[1fr_auto_1.2fr] sm:items-center sm:gap-4">
                  <span className="text-sm font-medium text-slate-800">{row.req}</span>
                  <span>
                    <Badge tone={FIT_VIEW[row.status].tone}>{FIT_VIEW[row.status].label}</Badge>
                  </span>
                  <span className="text-sm text-slate-600">
                    {row.quote ? (
                      <q className="border-l-2 border-slate-300 pl-2 not-italic">{row.quote}</q>
                    ) : (
                      <span className="text-slate-400">이력서에서 근거를 찾지 못함 → 개선 방향에서 메우는 법 제시</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </Section>

        {/* 받는 것 */}
        <Section id="deliverables" eyebrow="보고서" title="한 번의 진단으로 받는 것">
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {DELIVERABLES.map((d) => (
              <li key={d.title}>
                <Card className={d.highlight ? "h-full border-indigo-200 bg-indigo-50/40 p-5" : "h-full p-5"}>
                  <h3 className="font-semibold text-slate-900">{d.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-600">{d.body}</p>
                </Card>
              </li>
            ))}
          </ul>
        </Section>

        {/* 진행 방식 */}
        <Section id="how" eyebrow="진행 방식" title="이렇게 진행됩니다" muted>
          <ol className="grid gap-3 md:grid-cols-5">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <Card className="h-full p-4">
                  <span className="text-xs font-bold text-indigo-600">STEP {i + 1}</span>
                  <h3 className="mt-1 font-semibold text-slate-900">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{s.body}</p>
                </Card>
              </li>
            ))}
          </ol>
        </Section>

        {/* 한 줄 평 예시 */}
        <Section
          id="sample"
          eyebrow="미리보기"
          title="이런 한 줄 평을 받습니다"
          lead="가상의 백엔드 개발자 이력서에 대한 예시입니다. 실제 진단은 여러분의 이력서 문장을 그대로 인용합니다."
        >
          <Card className="divide-y divide-slate-100">
            {SAMPLE_ONE_LINERS.map((s) => {
              const v = verdictLabel(s.id, s.verdict);
              return (
                <div key={s.id} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="flex shrink-0 items-center gap-2 sm:w-44">
                    <Badge tone={TONE_TO_BADGE[v.tone]}>{v.label}</Badge>
                    <span className="text-sm font-medium text-slate-800">{REVIEWERS[s.id].name}</span>
                  </div>
                  <p className="text-sm text-slate-600">{s.text}</p>
                </div>
              );
            })}
            <div className="bg-slate-50 px-4 py-3 text-sm font-medium text-slate-900">
              7명 중 1명 통과 · 서류 필터 탈락 → 재작성 후 통과
            </div>
          </Card>
        </Section>

        {/* 고지 */}
        <Section id="notes" eyebrow="미리 알아 두세요" title="정직하게 말씀드립니다" muted>
          <ul className="grid gap-3 sm:grid-cols-2">
            {[
              ["두 번째 의견일 뿐입니다", "언어 모델(Claude)이 만든 구조화된 의견입니다. 실제 채용 담당자의 판단을 대신하지 않고, 면접이나 합격을 보장하지 않습니다."],
              ["사실을 지어내지 않습니다", "회사·직함·날짜·숫자·기술을 만들어 넣지 않습니다. 모르는 내용은 [ADD: 질문]으로 남기고, 추측은 '추정'으로 표시합니다."],
              ["아첨하지 않습니다", "강한 이력서는 강하다고 말하되, 가장 거절에 가까웠던 심사위원과 그래도 버틴 이유를 함께 알려 드립니다."],
              ["이력서는 Claude API로 전송됩니다", "분석을 위해 이력서와 JD가 Anthropic의 Claude API로 보내집니다. 보내고 싶지 않은 개인정보는 미리 지워 주세요."],
            ].map(([title, body]) => (
              <li key={title}>
                <Card className="h-full p-5">
                  <h3 className="font-semibold text-slate-900">{title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{body}</p>
                </Card>
              </li>
            ))}
          </ul>
        </Section>

        {/* CTA */}
        <section className="bg-indigo-600">
          <div className="mx-auto flex max-w-5xl flex-col items-start gap-5 px-4 py-14 sm:flex-row sm:items-center sm:justify-between sm:px-6">
            <div>
              <h2 className="text-2xl font-bold text-white">지원하기 전에, 먼저 떨어져 보세요</h2>
              <p className="mt-1 text-indigo-100">이력서와 공고만 있으면 몇 분이면 됩니다.</p>
            </div>
            <Link
              href={primaryHref}
              className="inline-flex h-12 items-center justify-center rounded-lg bg-white px-6 font-semibold whitespace-nowrap text-indigo-700 shadow-sm hover:bg-indigo-50"
            >
              {primaryLabel}
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-8 text-sm text-slate-500 sm:px-6">
          <p>
            심사 방식은 Alex Chen(@nocodealex)의{" "}
            <a
              href="https://github.com/alexyc9381/hiring-panel-skill"
              className="text-indigo-700 underline underline-offset-2"
              target="_blank"
              rel="noopener noreferrer"
            >
              hiring-panel-skill
            </a>
            (MIT 라이선스)을 바탕으로, JD 분석·적합도 매트릭스·개선 방향성·웹 보고서를 더해 만들었습니다.
          </p>
          <p className="mt-2">이 서비스는 커리어·법률 자문이 아닙니다.</p>
        </div>
      </footer>
    </>
  );
}

function Section({
  id,
  eyebrow,
  title,
  lead,
  muted,
  children,
}: {
  id: string;
  eyebrow: string;
  title: string;
  lead?: string;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className={muted ? "scroll-mt-4 border-y border-slate-200 bg-slate-100/60" : "scroll-mt-4"}
    >
      <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-16">
        <p className="text-sm font-semibold text-indigo-600">{eyebrow}</p>
        <h2 id={`${id}-title`} className="mt-1 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
          {title}
        </h2>
        {lead && <p className="mt-3 max-w-3xl leading-relaxed text-slate-600">{lead}</p>}
        <div className="mt-8">{children}</div>
      </div>
    </section>
  );
}
