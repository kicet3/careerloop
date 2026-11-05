import type { Metadata } from "next";
import { Noto_Sans_KR } from "next/font/google";
import "./globals.css";

// 한글 글리프는 unicode-range 조각으로 필요할 때만 받으므로 preload는 끈다.
const notoSansKr = Noto_Sans_KR({
  variable: "--font-noto-kr",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: {
    default: "커리어루프",
    template: "%s · 커리어루프",
  },
  description:
    "AI 심사위원 7명이 이력서를 떨어뜨리려고 읽고, JD 적합도 분석과 개선 방향, 같은 사실로 다시 쓴 이력서를 웹 보고서와 PDF로 드립니다.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={`${notoSansKr.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col bg-background text-foreground">{children}</body>
    </html>
  );
}
