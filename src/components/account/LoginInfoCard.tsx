"use client";
/**
 * 설정 > 계정 > 로그인 정보 카드. 오른쪽 위 [수정]을 누르면 이름만 바꿀 수 있다(이메일·Google 연결은 Google 계정이 정하므로 읽기 전용).
 * 저장하면 서버 화면을 다시 그려 사이드바·계정 메뉴 이름도 바뀐다.
 * 프로필 사진(선택): 올리기·바꾸기·지우기. 서버가 3:4 JPEG로 다시 만들고(EXIF 삭제) 이력서 머리글에 넣는다(이력서마다 '사진 넣기'로 끌 수 있다).
 */
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui";

const MAX = 40;
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_ACCEPT = "image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp";

/** 프로필 사진: 미리보기(3:4) + 올리기·바꾸기·지우기. */
function ProfilePhoto({ initialUrl }: { initialUrl: string | null }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState(initialUrl);
  const [busy, setBusy] = useState<"upload" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function upload(file: File) {
    setError(null);
    setNotice(null);
    if (!/\.(jpe?g|png|webp)$/i.test(file.name) && !/^image\/(jpeg|png|webp)$/.test(file.type)) {
      setError("JPG·PNG·WEBP 사진만 올릴 수 있습니다.");
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      setError("사진은 5MB 이하만 올릴 수 있습니다.");
      return;
    }
    setBusy("upload");
    try {
      const fd = new FormData();
      fd.set("photo", file);
      const res = await fetch("/api/account/photo", { method: "PUT", body: fd });
      const data = (await res.json().catch(() => ({}))) as { photoUrl?: string | null; error?: string };
      if (!res.ok) {
        setError(data.error ?? "사진을 올리지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setUrl(data.photoUrl ?? null);
      setNotice("사진을 저장했습니다. 이력서 머리글에 들어갑니다(이력서마다 '사진 넣기'로 끌 수 있습니다).");
      router.refresh();
    } catch {
      setError("사진을 올리지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function remove() {
    if (!window.confirm("프로필 사진을 지울까요? 이력서 머리글에서도 빠집니다.")) return;
    setError(null);
    setNotice(null);
    setBusy("delete");
    try {
      const res = await fetch("/api/account/photo", { method: "DELETE" });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? "사진을 지우지 못했습니다.");
        return;
      }
      setUrl(null);
      setNotice("사진을 지웠습니다.");
      router.refresh();
    } catch {
      setError("사진을 지우지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-start gap-4">
      <div className="flex h-32 w-24 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
        {url ? (
          // 소유자만 읽는 같은 출처 라우트(공개 캐시를 거치는 next/image 최적화를 쓰지 않는다).
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="프로필 사진" className="h-full w-full object-cover" />
        ) : (
          <span className="px-2 text-center text-xs text-slate-400">사진 없음</span>
        )}
      </div>
      <div className="min-w-0 space-y-2 text-sm">
        <p className="font-medium text-slate-800">
          프로필 사진 <span className="font-normal text-slate-400">(선택)</span>
        </p>
        <p className="text-xs text-slate-500">
          JPG·PNG·WEBP, 5MB 이하. 3:4 비율로 가운데를 잘라 저장하고 위치 정보 등 사진 정보(EXIF)는 지웁니다. 이력서 머리글(미리보기·PDF)에만
          쓰이고 AI에는 보내지 않습니다.
        </p>
        <input
          ref={inputRef}
          type="file"
          accept={PHOTO_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()} loading={busy === "upload"} disabled={busy !== null}>
            {url ? "사진 바꾸기" : "사진 올리기"}
          </Button>
          {url && (
            <Button size="sm" variant="ghost" onClick={remove} loading={busy === "delete"} disabled={busy !== null}>
              지우기
            </Button>
          )}
        </div>
        {error && (
          <p className="text-xs text-red-700" role="alert">
            {error}
          </p>
        )}
        {notice && !error && (
          <p className="text-xs text-emerald-700" role="status">
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

export function LoginInfoCard({
  email,
  name: initialName,
  googleLinked,
  photoUrl = null,
}: {
  email: string;
  name: string | null;
  googleLinked: boolean;
  /** 내 프로필 사진 주소(없으면 null). */
  photoUrl?: string | null;
}) {
  const router = useRouter();
  const [name, setName] = useState(initialName ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function startEdit() {
    setDraft(name);
    setError(null);
    setSaved(false);
    setEditing(true);
  }

  async function save() {
    const value = draft.replace(/\s+/g, " ").trim();
    if (!value) {
      setError("이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      });
      const data = (await res.json().catch(() => ({}))) as { name?: string; error?: string };
      if (!res.ok) {
        setError(data.error ?? "이름을 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      setName(data.name ?? value);
      setEditing(false);
      setSaved(true);
      router.refresh();
    } catch {
      setError("이름을 바꾸지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="로그인 정보"
        action={
          editing ? null : (
            <Button size="sm" variant="secondary" onClick={startEdit}>
              수정
            </Button>
          )
        }
      />
      <CardBody className="space-y-5">
        <ProfilePhoto initialUrl={photoUrl} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <dl className="grid max-w-lg grid-cols-[7rem_1fr] items-center gap-y-2 text-sm">
            <dt className="text-slate-500">이메일</dt>
            <dd className="break-all text-slate-900">{email}</dd>
            <dt className="text-slate-500">
              {editing ? (
                <label htmlFor="account-name">이름</label>
              ) : (
                "이름"
              )}
            </dt>
            <dd>
              {editing ? (
                <input
                  id="account-name"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  maxLength={MAX}
                  autoFocus
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? "account-name-error" : undefined}
                  className="w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:ring-indigo-500"
                />
              ) : (
                <span className="text-slate-900">{name || <span className="text-slate-400">이름 없음</span>}</span>
              )}
            </dd>
            <dt className="text-slate-500">Google</dt>
            <dd className="text-slate-900">{googleLinked ? "연결됨" : "연결 안 됨"}</dd>
          </dl>
          {error && (
            <p id="account-name-error" className="mt-2 text-xs text-red-700">
              {error}
            </p>
          )}
          {editing ? (
            <div className="mt-4 flex gap-2">
              <Button size="sm" type="submit" loading={busy} disabled={busy}>
                저장
              </Button>
              <Button size="sm" variant="ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>
                취소
              </Button>
              <span className="self-center text-xs text-slate-500">이메일과 Google 연결은 Google 계정에서 정해져 바꿀 수 없습니다.</span>
            </div>
          ) : (
            saved && (
              <p className="mt-2 text-xs text-emerald-700" role="status">
                이름을 바꿨습니다.
              </p>
            )
          )}
        </form>
      </CardBody>
    </Card>
  );
}
