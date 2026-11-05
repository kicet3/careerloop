"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/Button";

/** 로그아웃 → 첫 화면. 동의·승인 대기 화면처럼 사이드바가 없는 곳에서 쓴다. */
export function LogoutButton({ variant = "ghost" }: { variant?: "ghost" | "secondary" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  return (
    <Button
      variant={variant}
      size="sm"
      loading={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/auth/logout", { method: "POST" });
        } finally {
          router.push("/");
          router.refresh();
        }
      }}
    >
      로그아웃
    </Button>
  );
}
