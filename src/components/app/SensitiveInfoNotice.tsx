import Link from "next/link";
import { cn } from "@/components/ui/cn";

/**
 * 업로드·붙여넣기 화면의 입력 주의 안내(개인정보위 처리방침 작성지침 2026.4 생성형 AI 부록): 민감정보·고유식별정보를 넣지 말 것,
 * 입력은 AI 학습에 쓰지 않음. 진단·이력서·그래프 가져오기 화면에서 쓴다(표시 전용, 서버·클라이언트 공용).
 */
export function SensitiveInfoNotice({ className }: { className?: string }) {
  return (
    <div role="note" className={cn("rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-900", className)}>
      <p className="font-semibold">올리기 전에 확인해 주세요</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        <li>
          <strong>주민등록번호</strong>, 건강·병력, 종교, 정치 성향, 노동조합 가입, 가족 관계 같은 <strong>민감한 정보는 지우고</strong> 올려 주세요.
          연락처·주소도 분석에 필요하지 않으면 빼는 것을 권장합니다.
        </li>
        <li>
          입력한 내용은 AI 분석을 위해 해외 AI 사업자(Anthropic)에 전송되지만, <strong>AI 모델 학습에는 쓰이지 않습니다.</strong>{" "}
          <Link href="/privacy#p8" className="underline underline-offset-2">
            자세히
          </Link>
        </li>
      </ul>
    </div>
  );
}
