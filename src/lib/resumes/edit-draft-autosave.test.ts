import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDraftAutosaver,
  draftStatusText,
  EDIT_DRAFT_AUTOSAVE_DELAY_MS,
  EDIT_DRAFT_KEEPALIVE_MAX_BYTES,
  formatDraftClock,
  shouldWarnBeforeLeave,
  utf8ByteLength,
  type AutosaveStatus,
} from "./edit-draft-autosave";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createDraftAutosaver", () => {
  it("입력이 멈추고 3초 뒤 한 번만 저장한다(디바운스)", async () => {
    const save = vi.fn(async () => true);
    const a = createDraftAutosaver<string>({ save });
    a.change("a");
    await vi.advanceTimersByTimeAsync(2_000);
    a.change("ab");
    await vi.advanceTimersByTimeAsync(2_000);
    a.change("abc");
    expect(save).not.toHaveBeenCalled();
    expect(a.status().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(EDIT_DRAFT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("abc", { keepalive: false });
    expect(a.status()).toEqual({ pending: false, saving: false, failed: false });
  });

  it("flush는 기다리지 않고 바로 저장하고, 남은 변경이 없으면 아무것도 보내지 않는다", async () => {
    const save = vi.fn(async () => true);
    const a = createDraftAutosaver<string>({ save });
    expect(await a.flush()).toBe(true);
    expect(save).not.toHaveBeenCalled();
    a.change("x");
    expect(await a.flush()).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1); // 타이머도 정리됐다
  });

  it("문서가 내려갈 때(unloading)는 진행 중인 저장을 기다리지 않고 keepalive로 보내고, idle은 둘 다 끝날 때까지 기다린다", async () => {
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    let calls = 0;
    const save = vi.fn<(s: string, o: { keepalive: boolean }) => Promise<boolean>>(() => (++calls === 1 ? first.promise : second.promise));
    const a = createDraftAutosaver<string>({ save });
    a.change("a");
    void a.flush();
    a.change("ab");
    void a.flush({ unloading: true });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]).toEqual(["ab", { keepalive: true }]);
    let idle = false;
    const done = a.idle().then(() => (idle = true));
    second.resolve(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(idle).toBe(false); // 먼저 보낸 저장이 아직 진행 중
    first.resolve(true);
    await done;
    expect(a.status().saving).toBe(false);
  });

  it("문서가 내려갈 때 남은 변경이 없어도 진행 중인 보통 요청(함께 끊긴다)의 내용을 keepalive로 다시 보낸다", async () => {
    const first = deferred<boolean>();
    let calls = 0;
    const save = vi.fn<(s: string, o: { keepalive: boolean }) => Promise<boolean>>(() => (++calls === 1 ? first.promise : Promise.resolve(true)));
    const a = createDraftAutosaver<string>({ save });
    a.change("a");
    void a.flush();
    const k = a.flush({ unloading: true }); // beforeunload
    expect(save.mock.calls[1]).toEqual(["a", { keepalive: true }]);
    void a.flush({ unloading: true }); // 곧이어 pagehide: keepalive가 이미 진행 중이면 다시 보내지 않는다
    await k;
    expect(save).toHaveBeenCalledTimes(2);
    first.resolve(true);
    await a.idle();
  });

  it("화면이 가려질 때(keepalive, unloading 아님)는 진행 중인 저장이 끝난 뒤 차례로 보낸다", async () => {
    const first = deferred<boolean>();
    let calls = 0;
    const save = vi.fn<(s: string, o: { keepalive: boolean }) => Promise<boolean>>(() => (++calls === 1 ? first.promise : Promise.resolve(true)));
    const a = createDraftAutosaver<string>({ save });
    a.change("a");
    void a.flush();
    a.change("ab");
    const p = a.flush({ keepalive: true });
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(true);
    await p;
    expect(save.mock.calls[1]).toEqual(["ab", { keepalive: true }]);
  });

  it("늦게 보낸 저장이 먼저 끝나고 옛 저장이 뒤늦게 성공하면 최신 내용을 다시 보낸다", async () => {
    const first = deferred<boolean>();
    let calls = 0;
    const save = vi.fn<(s: string, o: { keepalive: boolean }) => Promise<boolean>>(() => (++calls === 1 ? first.promise : Promise.resolve(true)));
    const a = createDraftAutosaver<string>({ save });
    a.change("old");
    void a.flush();
    a.change("new");
    await a.flush({ unloading: true });
    first.resolve(true);
    await a.idle();
    expect(a.status().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(EDIT_DRAFT_AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save.mock.calls[2][0]).toBe("new");
  });

  it("저장은 한 번에 하나씩: 진행 중에 바뀐 내용은 끝난 뒤 최신 것만 보낸다", async () => {
    const gate = deferred<boolean>();
    const seen: string[] = [];
    const save = vi.fn(async (s: string) => {
      seen.push(s);
      return seen.length === 1 ? gate.promise : true;
    });
    const a = createDraftAutosaver<string>({ save });
    a.change("1");
    const p1 = a.flush();
    a.change("2");
    a.change("3");
    const p2 = a.flush();
    expect(seen).toEqual(["1"]);
    expect(a.status()).toMatchObject({ pending: true, saving: true });
    gate.resolve(true);
    await p1;
    await p2;
    expect(seen).toEqual(["1", "3"]);
    expect(a.status()).toEqual({ pending: false, saving: false, failed: false });
  });

  it("실패하면 그 변경을 '저장 안 됨'으로 남기고 되풀이하지 않는다 — 다음 flush가 다시 보낸다", async () => {
    let ok = false;
    const save = vi.fn(async () => ok);
    const statuses: AutosaveStatus[] = [];
    const a = createDraftAutosaver<string>({ save, onStatus: (s) => statuses.push(s) });
    a.change("x");
    await vi.advanceTimersByTimeAsync(EDIT_DRAFT_AUTOSAVE_DELAY_MS);
    expect(a.status()).toEqual({ pending: true, saving: false, failed: true });
    expect(shouldWarnBeforeLeave(a.status())).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(save).toHaveBeenCalledTimes(1);
    ok = true;
    expect(await a.flush()).toBe(true);
    expect(save).toHaveBeenLastCalledWith("x", { keepalive: false });
    expect(a.status().failed).toBe(false);
    expect(shouldWarnBeforeLeave(a.status())).toBe(false);
    expect(statuses.at(-1)).toEqual({ pending: false, saving: false, failed: false });
  });

  it("던져도 실패로 본다", async () => {
    const a = createDraftAutosaver<string>({ save: async () => Promise.reject(new Error("offline")) });
    a.change("x");
    expect(await a.flush()).toBe(false);
    expect(a.status().failed).toBe(true);
  });

  it("cancel은 기다리던 저장을 버리고 진행 중인 저장의 결과도 무시한다(idle로 끝을 기다린다)", async () => {
    const gate = deferred<boolean>();
    const save = vi.fn(() => gate.promise);
    const a = createDraftAutosaver<string>({ save });
    a.change("a");
    void a.flush();
    a.change("b");
    a.cancel();
    expect(a.status()).toEqual({ pending: false, saving: false, failed: false });
    let idle = false;
    const done = a.idle().then(() => (idle = true));
    await Promise.resolve();
    expect(idle).toBe(false);
    gate.resolve(false); // 실패했어도 cancel 뒤라 '실패'로 바꾸지 않는다
    await done;
    expect(a.status()).toEqual({ pending: false, saving: false, failed: false });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).toHaveBeenCalledTimes(1); // 'b'는 보내지 않았다
  });

  it("dispose는 타이머만 정리한다", async () => {
    const save = vi.fn(async () => true);
    const a = createDraftAutosaver<string>({ save });
    a.change("a");
    a.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(save).not.toHaveBeenCalled();
    expect(a.status().pending).toBe(true);
    await a.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("상태 문구", () => {
  const idle: AutosaveStatus = { pending: false, saving: false, failed: false };
  it("HH:MM(한국 시간 24시간제)", () => {
    expect(formatDraftClock(Date.UTC(2026, 10, 7, 5, 3))).toBe("14:03");
    expect(formatDraftClock(Date.UTC(2026, 10, 7, 15, 0))).toBe("00:00");
  });
  it("우선순위: 실패 > 저장 중 > 저장 안 된 변경 > 임시 저장됨", () => {
    const at = Date.UTC(2026, 10, 7, 5, 3);
    expect(draftStatusText({ ...idle, failed: true, pending: true }, at)?.text).toBe("임시 저장 실패");
    expect(draftStatusText({ ...idle, saving: true }, at)?.text).toBe("임시 저장 중…");
    expect(draftStatusText({ ...idle, pending: true }, at)?.text).toBe("저장 안 된 변경");
    expect(draftStatusText(idle, at)?.text).toBe("임시 저장됨 · 14:03");
    expect(draftStatusText(idle, null)).toBeNull();
  });
  it("떠나기 경고는 임시 저장이 실패한 변경이 있을 때만", () => {
    expect(shouldWarnBeforeLeave({ ...idle, pending: true })).toBe(false);
    expect(shouldWarnBeforeLeave({ ...idle, failed: true, pending: true })).toBe(true);
  });
  it("keepalive 한도를 넘는 문서는 저장 전·저장 중 변경이 있으면 문서를 내릴 때 경고한다", () => {
    expect(shouldWarnBeforeLeave({ ...idle, pending: true }, { fitsKeepalive: false })).toBe(true);
    expect(shouldWarnBeforeLeave({ ...idle, saving: true }, { fitsKeepalive: false })).toBe(true);
    expect(shouldWarnBeforeLeave(idle, { fitsKeepalive: false })).toBe(false);
    expect(shouldWarnBeforeLeave({ ...idle, pending: true }, { fitsKeepalive: true })).toBe(false);
  });
  it("keepalive 한도는 UTF-8 바이트로 잰다(한글 한 글자 3바이트)", () => {
    const korean = "가".repeat(25_000);
    expect(korean.length).toBeLessThan(EDIT_DRAFT_KEEPALIVE_MAX_BYTES);
    expect(utf8ByteLength(korean)).toBe(75_000);
    expect(utf8ByteLength(korean)).toBeGreaterThan(EDIT_DRAFT_KEEPALIVE_MAX_BYTES);
  });
});
