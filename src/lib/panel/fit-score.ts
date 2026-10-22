/**
 * JD 적합도 점수의 단일 계산식. fit 단계의 matchScore는 모델이 계산해 오지만 산수가 틀리거나 요건을 빠뜨릴 수 있어,
 * 파이프라인(pipeline.ts)이 저장 전에, 보고서 빌더(report/model.ts)가 표시 전에 이 값으로 덮어쓴다.
 * 그래서 머리 점수·매트릭스·이력 목록이 항상 같은 숫자를 보여 준다.
 *
 * 규칙(FIT_ROLE과 같다): met=1, partial=0.5, missing=0. 필수 평균 70% + 우대 평균 30%, 우대가 없으면 필수 평균만.
 * 매트릭스에 판정이 없는 요건은 미충족으로 센다.
 */
import type { FitResult, JdAnalysis } from "@/lib/domain/schemas";

export function computeMatchScore(items: { status: string; must: boolean }[]): number {
  const score = (s: string) => (s === "met" ? 1 : s === "partial" ? 0.5 : 0);
  const avg = (xs: typeof items) => (xs.length ? xs.reduce((n, x) => n + score(x.status), 0) / xs.length : null);
  const must = avg(items.filter((x) => x.must));
  const nice = avg(items.filter((x) => !x.must));
  const total = must == null ? (nice ?? 0) : nice == null ? must : must * 0.7 + nice * 0.3;
  return Math.round(total * 100);
}

/** JD 요건 목록과 fit 판정으로 점수를 다시 계산한다. 요건이 하나도 없으면 모델 값을 그대로 둔다. */
export function scoreFit(jd: Pick<JdAnalysis, "mustHave" | "niceToHave">, fit: Pick<FitResult, "items" | "matchScore">): number {
  const reqs = [
    ...jd.mustHave.map((r) => ({ id: r.id, must: true })),
    ...jd.niceToHave.map((r) => ({ id: r.id, must: false })),
  ];
  if (reqs.length === 0) return fit.matchScore;
  const status = new Map<string, string>();
  for (const item of fit.items) if (!status.has(item.requirementId)) status.set(item.requirementId, item.status);
  return computeMatchScore(reqs.map((r) => ({ must: r.must, status: status.get(r.id) ?? "missing" })));
}
