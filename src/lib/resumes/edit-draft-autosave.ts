/**
 * 이력서 편집 화면의 자동 임시 저장(클라이언트 전용, React 없이 시험할 수 있게 순수 모듈로 둔다).
 *
 * - change(snapshot): 마지막 변경을 기억하고 delayMs(약 3초) 디바운스 타이머를 다시 건다. 입력이 멈추면 한 번 저장한다.
 * - flush(): 디바운스를 기다리지 않고 지금 저장('임시 저장' 버튼). 화면이 가려질 때는 keepalive로, 문서가 내려갈 때(unloading)는
 *   진행 중인 저장도 기다리지 않고 keepalive로 바로 보낸다(save가 fetch keepalive를 쓴다 — 페이지가 내려가도 요청이 끝까지 간다).
 * - 저장은 한 번에 하나씩(진행 중이면 끝난 뒤 최신 변경을 보낸다). 실패하면 그 변경을 다시 '저장 안 됨'으로 남기고 자동으로 되풀이하지
 *   않는다 — 다음 입력·버튼·화면 이탈 때 다시 보낸다.
 * - cancel(): 남은 변경을 버리고, 이미 보낸 저장의 결과도 무시한다('저장(새 버전)'·'임시 저장본 버리기' 직전). 그다음 idle()을 기다리면
 *   늦게 도착한 임시 저장이 새 버전 저장 뒤에 작업본을 되살리지 않는다.
 */

export const EDIT_DRAFT_AUTOSAVE_DELAY_MS = 3_000;

export interface AutosaveStatus {
  /** 아직 임시 저장하지 않은 변경이 있다. */
  pending: boolean;
  /** 임시 저장 요청 중. */
  saving: boolean;
  /** 마지막 임시 저장이 실패했고, 그 변경이 아직 저장되지 않았다. */
  failed: boolean;
}

export interface DraftAutosaver<S> {
  change(snapshot: S): void;
  /**
   * 지금 저장. keepalive면 요청이 페이지보다 오래 살 수 있게 보낸다(화면이 가려질 때 등). unloading(문서가 내려갈 때 — pagehide·
   * beforeunload)이면 진행 중인 저장을 기다리지 않고 바로 keepalive로 보내고, 남은 변경이 없어도 진행 중인 보통 요청(문서와 함께
   * 끊긴다)의 내용을 다시 보낸다. 그 밖에는 차례로(진행 중인 저장이 끝난 뒤) 보낸다 — 순서가 뒤바뀌어 옛 내용이 덮어쓰지 않게.
   */
  flush(opts?: { keepalive?: boolean; unloading?: boolean }): Promise<boolean>;
  cancel(): void;
  idle(): Promise<void>;
  status(): AutosaveStatus;
  /** 타이머만 정리한다(남은 변경은 그대로 — 다시 마운트되면 이어서 쓸 수 있다). */
  dispose(): void;
}

export function createDraftAutosaver<S>(opts: {
  delayMs?: number;
  /** 저장 성공이면 true. 던지면 실패로 본다. */
  save: (snapshot: S, o: { keepalive: boolean }) => Promise<boolean>;
  onStatus?: (status: AutosaveStatus) => void;
}): DraftAutosaver<S> {
  const delayMs = opts.delayMs ?? EDIT_DRAFT_AUTOSAVE_DELAY_MS;
  let latest: { snapshot: S } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 진행 중인 저장(보통은 하나, 화면을 떠날 때 keepalive가 겹칠 수 있다). idle()은 모두 끝날 때까지 기다린다.
  const inflight = new Map<Promise<boolean>, { seq: number; keepalive: boolean; snapshot: S }>();
  let seq = 0;
  // 성공한 저장 중 가장 늦게 보낸 것의 순번: 그보다 먼저 보낸 저장이 뒤늦게 끝나면 서버의 작업본을 옛 내용으로 덮었을 수 있다.
  let newestOkSeq = 0;
  let newestOkSnapshot: { snapshot: S } | null = null;
  let generation = 0;
  let status: AutosaveStatus = { pending: false, saving: false, failed: false };

  function emit(patch: Partial<AutosaveStatus>) {
    const next = { ...status, ...patch };
    if (next.pending === status.pending && next.saving === status.saving && next.failed === status.failed) return;
    status = next;
    opts.onStatus?.(status);
  }

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void run(false, false);
    }, delayMs);
  }

  async function run(keepalive: boolean, unloading: boolean): Promise<boolean> {
    if (!latest && unloading && inflight.size > 0 && ![...inflight.values()].some((r) => r.keepalive)) {
      // 문서가 내려가면 보통 요청은 끊긴다: 가장 늦게 보낸 내용을 keepalive로 다시 보낸다.
      const newest = [...inflight.values()].reduce((a, b) => (b.seq > a.seq ? b : a));
      latest = { snapshot: newest.snapshot };
    }
    if (!latest) return !status.failed;
    if (inflight.size > 0 && !unloading) {
      // 차례로 보낸다: 진행 중인 저장이 끝난 뒤 그때의 최신 변경을.
      await Promise.all([...inflight.keys()]);
      return run(keepalive, false);
    }
    clearTimer();
    const taken = latest;
    latest = null;
    const gen = generation;
    const mySeq = ++seq;
    emit({ pending: false, saving: true });
    const p = opts.save(taken.snapshot, { keepalive }).catch(() => false);
    inflight.set(p, { seq: mySeq, keepalive, snapshot: taken.snapshot });
    const ok = await p;
    inflight.delete(p);
    if (gen !== generation) return ok; // 그사이 cancel(): 결과를 화면 상태에 반영하지 않는다
    if (ok) {
      if (mySeq > newestOkSeq) {
        newestOkSeq = mySeq;
        newestOkSnapshot = taken;
      } else if (newestOkSnapshot && !latest) {
        // 더 늦게 보낸 저장이 먼저 끝났다: 이 (옛) 내용이 서버에서 그것을 덮었을 수 있으니 최신 내용을 다시 보낸다.
        latest = newestOkSnapshot;
        schedule();
      }
      emit({ saving: inflight.size > 0, failed: false, pending: latest !== null });
    } else if (mySeq < newestOkSeq) {
      // 더 늦게 보낸(더 새) 저장이 이미 성공했다: 이 옛 내용은 다시 보내지 않는다.
      emit({ saving: inflight.size > 0, pending: latest !== null });
    } else {
      latest ??= taken; // 더 새 변경이 없으면 이 변경을 다시 '저장 안 됨'으로
      emit({ saving: inflight.size > 0, failed: true, pending: true });
    }
    return ok;
  }

  return {
    change(snapshot) {
      latest = { snapshot };
      emit({ pending: true });
      schedule();
    },
    flush(o = {}) {
      return run(o.keepalive === true || o.unloading === true, o.unloading === true);
    },
    cancel() {
      generation += 1;
      latest = null;
      newestOkSnapshot = null;
      clearTimer();
      emit({ pending: false, saving: false, failed: false });
    },
    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight.keys()]);
    },
    status: () => status,
    dispose: clearTimer,
  };
}

/** 'HH:MM'(한국 시간, 24시간제) — '임시 저장됨 · 14:05'. */
export function formatDraftClock(ms: number): string {
  const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(ms);
  const hh = parts.find((p) => p.type === "hour")?.value ?? "00";
  const mm = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hh.padStart(2, "0")}:${mm.padStart(2, "0")}`;
}

/** 편집 화면 상태 문구: '임시 저장 실패' > '임시 저장 중…' > '저장 안 된 변경' > '임시 저장됨 · HH:MM' > 없음. */
export function draftStatusText(status: AutosaveStatus, draftSavedAt: number | null): { text: string; tone: "warning" | "neutral" | "info" } | null {
  if (status.failed) return { text: "임시 저장 실패", tone: "warning" };
  if (status.saving) return { text: "임시 저장 중…", tone: "neutral" };
  if (status.pending) return { text: "저장 안 된 변경", tone: "warning" };
  if (draftSavedAt !== null) return { text: `임시 저장됨 · ${formatDraftClock(draftSavedAt)}`, tone: "info" };
  return null;
}

/**
 * 화면을 떠날 때 경고할지: 임시 저장도 안 된 변경이 있고, 마지막 임시 저장이 실패했을 때만(그 밖에는 떠나며 keepalive로 저장한다).
 * 문서를 내리는 이탈(탭 닫기·새로고침)에서 보낼 내용이 keepalive 한도(EDIT_DRAFT_KEEPALIVE_MAX_BYTES)를 넘으면(fitsKeepalive=false)
 * 요청이 끊기므로 저장 중·저장 전 변경이 있을 때도 경고한다.
 */
export function shouldWarnBeforeLeave(status: AutosaveStatus, o: { fitsKeepalive?: boolean } = {}): boolean {
  const unsaved = status.pending || status.saving;
  return unsaved && (status.failed || o.fitsKeepalive === false);
}

/**
 * 브라우저는 keepalive 요청 본문을 (진행 중인 keepalive 요청을 모두 합쳐) 64KiB까지만 보내고, 넘으면 요청 자체를 거부한다.
 * 한도는 UTF-8 바이트 기준이다(한글 한 글자 = 3바이트) — 글자 수(string.length)로 재면 한글 문서가 한도를 넘는다.
 */
export const EDIT_DRAFT_KEEPALIVE_MAX_BYTES = 60_000;

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
