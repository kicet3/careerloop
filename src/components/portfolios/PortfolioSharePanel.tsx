"use client";
/**
 * 포트폴리오 상세의 '공개 링크' 칸(소유자만). 공개하기 전에는 무엇이 공개되는지 설명하는 확인 창에서 이름·원본·챗봇·검색 노출을 고른다.
 * 공개 중이면 주소·복사·열람/질문 수, 공개본 업데이트(지금 내용으로 다시 공개), 챗봇·검색 노출 바꾸기, 링크 다시 만들기, 공개 중지.
 * API: /api/portfolios/[id]/share (GET·POST·PATCH·DELETE), /api/portfolios/[id]/share/token (POST).
 */
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { formatDateTime } from "@/components/app/stages";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ANONYMOUS_OWNER_LABEL, type PortfolioShareOptions, type PortfolioShareStatus } from "@/lib/domain/portfolio-shares";
import type { PortfolioKind } from "@/lib/domain/portfolios";
import { NETWORK_ERROR, readError } from "./api";

type Busy = "publish" | "patch" | "token" | "revoke" | null;

const noop = () => () => {};

export function PortfolioSharePanel({
  portfolioId,
  kind,
  hasOriginal,
  openMarkers,
  ownerName,
  initial,
}: {
  portfolioId: string;
  kind: PortfolioKind;
  /** 보관한 원본 파일이 있다(kind 'file'). */
  hasOriginal: boolean;
  /** 본문에 남은 [ADD] 자리 수(그래프 포트폴리오). 공개하면 그대로 보인다. */
  openMarkers: number;
  /** 회원 이름(이름 보이기를 고르면 공개된다). */
  ownerName: string | null;
  initial: PortfolioShareStatus | null;
}) {
  const router = useRouter();
  const [share, setShare] = useState<PortfolioShareStatus | null>(initial);
  // 같은 화면에서 고친 뒤(router.refresh) 서버가 새 상태(outdated·숫자)를 보내면 따라간다 — 부모가 이 칸을 그대로 두므로
  // useState 초깃값만으로는 갱신되지 않는다(React의 'prop이 바뀌면 state 맞추기' 패턴).
  const [prevInitial, setPrevInitial] = useState(initial);
  if (initial !== prevInitial) {
    setPrevInitial(initial);
    setShare(initial);
  }
  const linkRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const base = `/api/portfolios/${encodeURIComponent(portfolioId)}/share`;
  // 서버 렌더에는 출처가 없다 — 하이드레이션 뒤 브라우저 주소로 채운다.
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "");
  const url = share ? `${origin}${share.path}` : "";
  const closeDialog = useCallback(() => {
    setDialog(false);
    setError(null);
  }, []);

  async function call(kindOf: Exclude<Busy, null>, input: RequestInfo, init: RequestInit, done: (data: { share?: PortfolioShareStatus }) => void) {
    setBusy(kindOf);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(input, init);
      if (!res.ok) {
        setError(await readError(res, "처리하지 못했습니다."));
        return false;
      }
      done(res.status === 204 ? {} : ((await res.json()) as { share?: PortfolioShareStatus }));
      router.refresh();
      return true;
    } catch {
      setError(NETWORK_ERROR);
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function publish(options: PortfolioShareOptions) {
    const ok = await call(
      "publish",
      base,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(options) },
      (d) => {
        setShare(d.share ?? null);
        setNotice(share ? "공개본을 지금 내용으로 업데이트했습니다." : "공개 링크를 만들었습니다. 링크를 가진 누구나 볼 수 있습니다.");
      },
    );
    if (ok) {
      setDialog(false);
      // 처음 공개하면 '공개 링크 만들기' 버튼이 사라진다 — 포커스를 새 링크 주소로 옮긴다(업데이트면 원래 버튼으로 돌아간다).
      if (!share) requestAnimationFrame(() => linkRef.current?.focus());
    }
  }

  async function patch(p: { allowChat?: boolean; indexable?: boolean }) {
    await call("patch", base, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(p) }, (d) => {
      setShare(d.share ?? null);
      setNotice("설정을 바꿨습니다.");
    });
  }

  async function regenerate() {
    if (!window.confirm("링크를 다시 만들까요? 지금 링크는 바로 열리지 않게 되고, 새 링크를 다시 보내야 합니다.")) return;
    await call("token", `${base}/token`, { method: "POST" }, (d) => {
      setShare(d.share ?? null);
      setNotice("새 링크를 만들었습니다. 예전 링크는 더 이상 열리지 않습니다.");
    });
  }

  async function revoke() {
    if (!window.confirm("공개를 중지할까요? 링크가 바로 열리지 않게 되고 공개본은 지워집니다(포트폴리오는 그대로 남습니다).")) return;
    await call("revoke", base, { method: "DELETE" }, () => {
      setShare(null);
      setNotice("공개를 중지했습니다. 링크는 더 이상 열리지 않습니다.");
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("복사하지 못했습니다. 주소를 직접 선택해 복사해 주세요.");
    }
  }

  return (
    <Card className="p-4 sm:p-5 print:hidden">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900">
            공개 링크 {share ? <Badge tone="positive">공개 중</Badge> : <Badge>비공개</Badge>}
          </h2>
          <p className="text-sm text-slate-600">
            {share
              ? "링크를 가진 누구나 로그인 없이 공개본을 볼 수 있습니다."
              : "원할 때만 이 포트폴리오를 링크로 공개할 수 있습니다. 공개한 뒤 고친 내용은 '공개본 업데이트'를 눌러야 반영됩니다."}
          </p>
        </div>
        {!share && (
          <Button size="sm" onClick={() => setDialog(true)} disabled={busy !== null}>
            공개 링크 만들기
          </Button>
        )}
      </div>

      {share && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={linkRef}
              readOnly
              value={url}
              aria-label="공개 링크 주소"
              onFocus={(e) => e.currentTarget.select()}
              className="h-9 min-w-0 flex-1 rounded-lg border border-slate-300 bg-slate-50 px-3 font-mono text-xs text-slate-700"
            />
            <Button size="sm" variant="secondary" onClick={copy}>
              {copied ? "복사했습니다" : "복사"}
            </Button>
            <a href={share.path} target="_blank" rel="noopener noreferrer" className="text-sm text-indigo-700 hover:underline">
              열어 보기
            </a>
          </div>
          <p className="text-xs text-slate-500">
            {formatDateTime(share.publishedAt)} 공개본 · 열람 {share.viewCount.toLocaleString("ko-KR")}회 · 챗봇 질문 {share.chatCount.toLocaleString("ko-KR")}회 ·{" "}
            {share.options.showName ? "이름 공개" : `작성자 표시 '${ANONYMOUS_OWNER_LABEL}'`}
            {kind === "file" && (share.options.includeOriginal ? " · 원본 파일 공개" : " · 원본 파일 비공개")}
          </p>
          {share.outdated && (
            <Alert tone="warning">공개한 뒤 이 포트폴리오를 고쳤습니다. 지금 링크에는 예전 공개본이 보입니다. 고친 내용을 공개하려면 &apos;공개본 업데이트&apos;를 누르세요.</Alert>
          )}
          <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm text-slate-700">
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={share.options.allowChat}
                disabled={busy !== null}
                onChange={(e) => void patch({ allowChat: e.target.checked })}
                className="size-4 rounded border-slate-300"
              />
              방문자 챗봇 켜기
            </label>
            <label className="inline-flex items-center gap-2">
              <input
                type="checkbox"
                checked={share.options.indexable}
                disabled={busy !== null}
                onChange={(e) => void patch({ indexable: e.target.checked })}
                className="size-4 rounded border-slate-300"
              />
              검색 엔진에 노출
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setDialog(true)} disabled={busy !== null}>
              공개본 업데이트
            </Button>
            <Button size="sm" variant="secondary" onClick={regenerate} loading={busy === "token"} disabled={busy !== null}>
              링크 다시 만들기
            </Button>
            <Button size="sm" variant="danger" onClick={revoke} loading={busy === "revoke"} disabled={busy !== null}>
              공개 중지
            </Button>
          </div>
        </div>
      )}

      {error && !dialog && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      {notice && !error && (
        <Alert tone="info" className="mt-3">
          {notice}
        </Alert>
      )}

      {dialog && (
        <PublishDialog
          kind={kind}
          hasOriginal={hasOriginal}
          openMarkers={openMarkers}
          ownerName={ownerName}
          updating={!!share}
          initial={share?.options ?? { showName: false, includeOriginal: hasOriginal, allowChat: true, indexable: false }}
          busy={busy === "publish"}
          error={error}
          onCancel={closeDialog}
          onConfirm={publish}
        />
      )}
    </Card>
  );
}

function PublishDialog({
  kind,
  hasOriginal,
  openMarkers,
  ownerName,
  updating,
  initial,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  kind: PortfolioKind;
  hasOriginal: boolean;
  openMarkers: number;
  ownerName: string | null;
  updating: boolean;
  initial: PortfolioShareOptions;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: (o: PortfolioShareOptions) => void;
}) {
  const [opts, setOpts] = useState<PortfolioShareOptions>(initial);
  const [ack, setAck] = useState(false);
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const set = (k: keyof PortfolioShareOptions) => (e: React.ChangeEvent<HTMLInputElement>) => setOpts((o) => ({ ...o, [k]: e.target.checked }));

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.isComposing) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      const panel = ref.current;
      if (e.key !== "Tab" || !panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), a[href]')];
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      // 처음 공개에 성공하면 열던 버튼이 이미 사라졌다 — 그때는 부모가 새 링크 주소로 옮긴다.
      if (prev?.isConnected) prev.focus();
    };
  }, [onCancel]);

  const body = kind === "graph" ? "포트폴리오 본문 전체" : kind === "file" ? "파일에서 뽑은 글" : "포트폴리오 링크 주소";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div className="absolute inset-0 bg-slate-900/40" aria-hidden onClick={onCancel} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl bg-white p-5 shadow-xl focus:outline-none sm:max-w-lg sm:rounded-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold text-slate-900">
          {updating ? "공개본 업데이트" : "공개 링크 만들기"}
        </h2>
        <div className="mt-3 space-y-3 text-sm text-slate-700">
          <p>링크를 가진 사람은 누구나 로그인 없이 아래 내용을 볼 수 있습니다. 링크가 다른 곳에 전달될 수 있다는 점을 생각해 주세요.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>포트폴리오 이름과 설명</li>
            <li>{body}</li>
            {kind === "file" && hasOriginal && opts.includeOriginal && <li>올린 원본 파일(보기·내려받기)</li>}
            <li>작성자 표시: {opts.showName ? (ownerName?.trim() ? `내 이름(${ownerName.trim()})` : `이름이 없어 '${ANONYMOUS_OWNER_LABEL}'`) : `'${ANONYMOUS_OWNER_LABEL}'`}</li>
            {opts.allowChat && <li>방문자가 질문하면 AI가 위 공개본만 읽고 답합니다(질문은 저장하지 않습니다).</li>}
          </ul>
          <p className="text-xs text-slate-500">
            지금 내용을 그대로 복사해 공개합니다. 이메일·경험 그래프·이력서 등 다른 정보는 공개되지 않습니다. 공개한 뒤 고친 내용은 &apos;공개본 업데이트&apos;를 눌러야 반영됩니다.
          </p>
          <Alert tone="warning">
            공개 전에 전화번호·이메일·주소 같은 연락처와 회사 기밀·비공개 수치·다른 사람의 개인정보가 본문{kind === "file" ? "·원본 파일" : ""}에 없는지 확인해 주세요.
            {openMarkers > 0 && ` 채워야 할 자리([ADD]) ${openMarkers}개도 그대로 보입니다.`}
          </Alert>
          <fieldset className="space-y-2">
            <legend className="sr-only">공개 설정</legend>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={opts.showName} onChange={set("showName")} className="mt-0.5 size-4 rounded border-slate-300" />
              <span>
                내 이름 보이기 <span className="text-xs text-slate-500">(끄면 &apos;{ANONYMOUS_OWNER_LABEL}&apos;로 보입니다)</span>
              </span>
            </label>
            {kind === "file" && hasOriginal && (
              <label className="flex items-start gap-2">
                <input type="checkbox" checked={opts.includeOriginal} onChange={set("includeOriginal")} className="mt-0.5 size-4 rounded border-slate-300" />
                <span>원본 파일 보기·내려받기 허용</span>
              </label>
            )}
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={opts.allowChat} onChange={set("allowChat")} className="mt-0.5 size-4 rounded border-slate-300" />
              <span>방문자 챗봇 켜기 <span className="text-xs text-slate-500">(AI가 이 공개본만으로 답합니다)</span></span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={opts.indexable} onChange={set("indexable")} className="mt-0.5 size-4 rounded border-slate-300" />
              <span>검색 엔진에 노출 <span className="text-xs text-slate-500">(끄면 검색 결과에 나오지 않게 요청합니다)</span></span>
            </label>
            <label className="flex items-start gap-2 border-t border-slate-100 pt-2">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 size-4 rounded border-slate-300" />
              <span className="font-medium">공개될 내용을 확인했고, 연락처·기밀 정보를 지웠습니다.</span>
            </label>
          </fieldset>
          {error && <Alert tone="error">{error}</Alert>}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button size="sm" onClick={() => onConfirm(opts)} loading={busy} disabled={busy || !ack}>
            {updating ? "공개본 업데이트" : "공개하기"}
          </Button>
        </div>
      </div>
    </div>
  );
}
