"use client";
/**
 * 공고 찾기 상세의 동작: 내 보관함에 담기(AI 없음) / 보관함에서 열기, 다시 가져오기(페이지를 다시 읽어 공용 공고와
 * 내 보관함 공고를 최신 내용으로 — 하루 가져오기 횟수 1회. 아직 담지 않았으면 내 보관함에도 담긴다), 관리자: 공고 찾기에서 숨기기·다시 공개.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { isPostingImportActive, POSTING_IMPORT_STATUS_LABELS } from "@/lib/domain/postings";
import { saveSharedPosting } from "./ExploreView";
import { usePostingImports } from "./import-jobs";
import { readApiError } from "./shared";

export function SharedPostingActions({
  sharedId,
  url,
  myPostingId: initialMine,
  isAdmin,
  hidden = false,
}: {
  sharedId: string;
  /** 공고 주소. 직접 입력으로 만든 공용 공고는 null(다시 가져오기 없음). */
  url: string | null;
  myPostingId: string | null;
  isAdmin: boolean;
  /** 관리자가 숨긴 공고(관리자만 이 화면을 본다). */
  hidden?: boolean;
}) {
  const router = useRouter();
  const [mine, setMine] = useState(initialMine);
  const [busy, setBusy] = useState<"save" | "hide" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imports = usePostingImports({
    onCompleted: (job) => {
      if (job.postingId) setMine(job.postingId);
      router.refresh();
    },
  });
  const job = imports.jobs[0];
  const refreshing = !!job && isPostingImportActive(job.status);

  async function save() {
    setBusy("save");
    setError(null);
    const result = await saveSharedPosting(sharedId);
    setBusy(null);
    if (result.ok) setMine(result.postingId);
    else setError(result.error);
  }

  async function refresh() {
    if (!url) return;
    const message = mine
      ? "공고 페이지를 다시 읽어 최신 내용으로 갱신할까요? 하루 가져오기 횟수 1회를 쓰고, 내 보관함에 담긴 이 공고의 구역 내용도 새 내용으로 바뀝니다(상태·메모는 그대로)."
      : "공고 페이지를 다시 읽어 최신 내용으로 가져올까요? 하루 가져오기 횟수 1회를 쓰고, 이 공고가 내 보관함에도 담깁니다.";
    if (!window.confirm(message)) return;
    setError(null);
    const result = await imports.start(url, { refresh: true });
    if (!result.ok) setError(result.error.error);
  }

  async function setHidden(next: boolean) {
    const message = next
      ? "이 공고를 공고 찾기에서 숨길까요? 이미 담은 사용자의 보관함 공고는 그대로 남습니다. 숨긴 공고는 공고 찾기의 '숨긴 공고만 보기'에서 다시 공개할 수 있습니다."
      : "이 공고를 공고 찾기에 다시 공개할까요? 모든 사용자가 다시 보고 담을 수 있게 됩니다.";
    if (!window.confirm(message)) return;
    setBusy("hide");
    setError(null);
    try {
      const res = await fetch(`/api/shared-postings/${encodeURIComponent(sharedId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hidden: next }),
      });
      if (!res.ok) setError((await readApiError(res, next ? "숨기지 못했습니다." : "다시 공개하지 못했습니다.")).error);
      // 관리자는 숨긴 공고도 이 화면에서 본다 — 그대로 새로 읽어 상태(안내·버튼)를 바꾼다.
      else router.refresh();
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-2 sm:w-auto sm:items-end">
      <div className="flex flex-wrap gap-2">
        {mine ? (
          <Link href={`/app/postings/${mine}`} className={buttonClass("primary", "md")}>
            보관함에서 열기
          </Link>
        ) : hidden ? null : (
          <Button loading={busy === "save"} disabled={busy !== null || refreshing} onClick={() => void save()}>
            내 보관함에 담기
          </Button>
        )}
        {!hidden && url && (
          <Button variant="secondary" loading={refreshing} disabled={busy !== null || refreshing} onClick={() => void refresh()}>
            다시 가져오기
          </Button>
        )}
        {isAdmin &&
          (hidden ? (
            <Button variant="primary" loading={busy === "hide"} disabled={busy !== null} onClick={() => void setHidden(false)}>
              공고 찾기에 다시 공개
            </Button>
          ) : (
            <Button variant="danger" loading={busy === "hide"} disabled={busy !== null} onClick={() => void setHidden(true)}>
              공고 찾기에서 숨기기
            </Button>
          ))}
      </div>
      {job && (
        <p className="flex items-center gap-2 text-sm text-slate-600" role="status">
          {refreshing && <Spinner size="sm" />}
          {POSTING_IMPORT_STATUS_LABELS[job.status]}
          {job.status === "completed" && " — 최신 내용으로 갱신했습니다."}
          {job.error && ` — ${job.error}`}
        </p>
      )}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}
