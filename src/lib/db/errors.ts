/**
 * Prisma·Postgres 오류 판별. instanceof 대신 code를 본다(테스트·번들에서 Prisma 런타임이 여러 벌 로드돼도 동작하게).
 * - P2002: 유일 제약 위반(쿼리 API). $queryRaw/$executeRaw에서는 P2010 + meta.driverAdapterError.cause.originalCode '23505'로 온다.
 * - P2003: FK 위반(쿼리 API). raw는 P2010 + '23503'.
 * - P2025: update/delete 대상 행이 없음.
 */
type ErrLike = {
  code?: unknown;
  meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } } } | null;
  cause?: unknown;
};

/** raw 쿼리 오류(P2010)의 Postgres SQLSTATE. */
function rawPgCode(e: ErrLike): unknown {
  return e.meta?.driverAdapterError?.cause?.originalCode ?? e.meta?.code;
}

function chain(err: unknown): ErrLike[] {
  const out: ErrLike[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    out.push(cur as ErrLike);
    cur = (cur as ErrLike).cause;
  }
  return out;
}

function hasCode(err: unknown, prismaCode: string, pgCode: string): boolean {
  return chain(err).some((e) => e.code === prismaCode || e.code === pgCode || (e.code === "P2010" && rawPgCode(e) === pgCode));
}

export function isUniqueViolation(err: unknown): boolean {
  return hasCode(err, "P2002", "23505");
}

export function isForeignKeyViolation(err: unknown): boolean {
  return hasCode(err, "P2003", "23503");
}

export function isRecordNotFound(err: unknown): boolean {
  return chain(err).some((e) => e.code === "P2025");
}

/** Postgres text·jsonb는 NUL(\u0000)을 받지 않는다. 쓰기 경계에서 문자열의 NUL을 지운다. */
export function stripNul(value: string): string;
export function stripNul(value: string | null): string | null;
export function stripNul(value: string | null | undefined): string | null | undefined;
export function stripNul(value: string | null | undefined): string | null | undefined {
  return typeof value === "string" && value.includes("\u0000") ? value.replaceAll("\u0000", "") : value;
}

/** JSON 값(jsonb에 넣을 객체·배열·문자열) 안의 모든 문자열·키에서 NUL을 지운다. */
export function stripNulDeep<T>(value: T): T {
  if (typeof value === "string") return stripNul(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripNulDeep(v)) as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [stripNul(k), stripNulDeep(v)])) as T;
  }
  return value;
}
