export async function register() {
  // libsql·fs를 쓰므로 Node 런타임에서만 실행한다.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureDatabase } = await import("./lib/db/migrate");
  try {
    await ensureDatabase();
  } catch (err) {
    // 기동은 막지 않는다. 라우트 핸들러가 ensureDatabase()를 다시 호출해 재시도한다.
    console.error("[db] 마이그레이션 실패", err);
  }
}
