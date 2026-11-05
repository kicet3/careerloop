/**
 * 배포 모드 배지. DEV일 때만 작은 노란 'DEV' 표시를 보이고 PRODUCTION이면 아무것도 그리지 않는다.
 * env는 서버에서 appEnv()로 구해 내려 준다(이 컴포넌트는 서버·클라이언트 어디서나 쓸 수 있다).
 */
export function EnvBadge({ env }: { env: "DEV" | "PRODUCTION" }) {
  if (env !== "DEV") return null;
  return (
    <span
      title="개발 모드(APP_ENV=DEV)"
      className="inline-flex shrink-0 items-center rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold leading-none tracking-wide text-amber-800"
    >
      DEV
    </span>
  );
}
