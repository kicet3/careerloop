import "server-only";
/**
 * 새 알림 SSE 스트림(GET /api/notifications/stream). **기본 꺼짐** — 라우트는 NOTIFICATIONS_SSE=1일 때만 열고(아니면 404),
 * 클라이언트는 열지 않는다(알림은 새로고침·알림 패널 열기 때 목록 API로 받는다). 알림은 DB(notifications)가 기준이고, 이 스트림은 몇 초마다 DB를 보고
 * 커서 뒤에 생긴 내 알림과 읽지 않은 수만 보낸다(서버리스라 인스턴스 사이 공유 메모리·pub/sub 없이 DB를 본다).
 *
 * - 커서: 보낸 알림 중 가장 최근 createdAt(ms). 이벤트 id로 실어, EventSource가 다시 연결할 때 Last-Event-ID로 돌려준다.
 *   연결 직후 "unread" 이벤트도 커서를 싣는다 — 알림이 하나도 오지 않은 연결도 다시 연결할 때 커서를 잃지 않는다.
 * - 늦게 커밋된 행(다른 인스턴스 시계·트랜잭션 지연)을 놓치지 않게 커서 OVERLAP_MS 앞부터 보고, 이 연결에서 이미 보낸 id는 거른다.
 *   다시 연결하면 겹친 구간이 한 번 더 올 수 있다 — 클라이언트가 id로 거른다.
 * - 15초마다 주석 한 줄(heartbeat)로 프록시가 연결을 끊지 않게 한다.
 * - 함수 시간 상한 전에 스스로 닫는다(EventSource가 retry 뒤 Last-Event-ID로 다시 연결한다).
 * - 끊긴 백그라운드 작업 정리(sweepStaleJobs)는 시작할 때와 가끔만 한다.
 * - DB 오류면 더 긴 retry를 알리고 닫는다(다시 연결하며 회복).
 */
import { NOTIFICATION_STREAM_EVENTS, type NotificationItem, type NotificationStreamItem } from "@/lib/domain/notifications";
import { countUnreadNotifications, listNotificationsAfter } from "./service";
import { sweepStaleJobs } from "./sweep";

export const STREAM_DEFAULTS = {
  /** DB 확인 간격. */
  pollMs: 4_000,
  /** 아무것도 보내지 않은 채 이만큼 지나면 heartbeat 주석. */
  heartbeatMs: 15_000,
  /** 연결 하나의 수명(route maxDuration보다 짧게). */
  lifetimeMs: 280_000,
  /** 끊긴 작업 정리 간격. */
  sweepEveryMs: 60_000,
  /** EventSource 재연결 대기(retry:). */
  retryMs: 3_000,
  /** DB 오류로 닫을 때의 재연결 대기. */
  errorRetryMs: 15_000,
};
/** 커서 앞으로 겹쳐 보는 구간(늦게 커밋된 알림). */
export const OVERLAP_MS = 2_000;
/** 커서 없이 연결하면 이만큼 앞부터 본다(클라이언트가 목록을 받은 직후 연결하는 사이에 생긴 알림). */
export const START_LOOKBACK_MS = 30_000;
const BATCH = 50;

export interface NotificationStreamOptions {
  /** Last-Event-ID 또는 ?since=(ms). 없으면 지금 - START_LOOKBACK_MS. */
  cursor: number | null;
  signal?: AbortSignal;
  pollMs?: number;
  heartbeatMs?: number;
  lifetimeMs?: number;
  sweepEveryMs?: number;
  retryMs?: number;
  errorRetryMs?: number;
  now?: () => number;
  sweep?: (userId: string, now: number) => Promise<void>;
}

const encoder = new TextEncoder();

/** SSE 이벤트 한 덩어리(data는 한 줄 JSON이라 줄바꿈 없음). */
export function sseEvent(event: string, data: unknown, id?: string | number): string {
  return `event: ${event}\n${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function toStreamItem(n: NotificationItem): NotificationStreamItem {
  return { id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, createdAt: n.createdAt, readAt: n.readAt };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createNotificationStream(userId: string, opts: NotificationStreamOptions): ReadableStream<Uint8Array> {
  const o = { ...STREAM_DEFAULTS, ...opts };
  const now = opts.now ?? Date.now;
  const sweep = opts.sweep ?? sweepStaleJobs;
  // 요청이 끊기거나(req.signal) 클라이언트가 스트림을 취소하면(cancel) 멈춘다.
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (opts.signal?.aborted) stop.abort();
  else opts.signal?.addEventListener("abort", onAbort, { once: true });

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let lastWriteAt = now();
      const write = (chunk: string): boolean => {
        if (stop.signal.aborted) return false;
        try {
          controller.enqueue(encoder.encode(chunk));
          lastWriteAt = now();
          return true;
        } catch {
          stop.abort();
          return false;
        }
      };
      const close = () => {
        opts.signal?.removeEventListener("abort", onAbort);
        stop.abort();
        try {
          controller.close();
        } catch {}
      };

      void (async () => {
        const startedAt = now();
        let cursor = Math.min(opts.cursor ?? startedAt - START_LOOKBACK_MS, startedAt);
        /** 이 연결에서 보낸 알림 id → createdAt(겹친 구간에서 다시 보내지 않게). */
        const sent = new Map<string, number>();
        let lastUnread = -1;
        let lastSweepAt = -Infinity;
        write(`retry: ${o.retryMs}\n\n`);
        try {
          while (!stop.signal.aborted) {
            const t = now();
            if (t - startedAt >= o.lifetimeMs) break;
            if (t - lastSweepAt >= o.sweepEveryMs) {
              lastSweepAt = t;
              await sweep(userId, t);
            }
            const fresh = await listNotificationsAfter(userId, cursor - OVERLAP_MS, BATCH);
            for (const n of fresh) {
              if (sent.has(n.id)) continue;
              sent.set(n.id, n.createdAt);
              cursor = Math.max(cursor, n.createdAt);
              if (!write(sseEvent(NOTIFICATION_STREAM_EVENTS.notification, toStreamItem(n), cursor))) break;
            }
            for (const [id, at] of sent) if (at < cursor - OVERLAP_MS) sent.delete(id);
            const unread = await countUnreadNotifications(userId);
            if (unread !== lastUnread) {
              lastUnread = unread;
              write(sseEvent(NOTIFICATION_STREAM_EVENTS.unread, { unreadCount: unread }, cursor));
            }
            if (now() - lastWriteAt >= o.heartbeatMs) write(`: ping\n\n`);
            const left = o.lifetimeMs - (now() - startedAt);
            if (left <= 0) break;
            await sleep(Math.min(o.pollMs, left), stop.signal);
          }
        } catch (err) {
          if (!stop.signal.aborted) {
            console.error("[notifications/stream] 알림 확인 실패", (err as Error)?.message?.slice(0, 200));
            write(`retry: ${o.errorRetryMs}\n\n`);
          }
        }
        close();
      })();
    },
    cancel() {
      opts.signal?.removeEventListener("abort", onAbort);
      stop.abort();
    },
  });
}
