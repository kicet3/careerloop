import "server-only";
/**
 * 계정 표시 이름 바꾸기(설정 > 계정 > 로그인 정보). 이름은 Google 가입 때 한 번 채우고 로그인할 때마다 덮어쓰지 않으므로
 * 여기서 바꾼 값이 유지된다. 세션은 매 요청 DB에서 사용자를 읽으므로 바로 반영된다.
 */
import { z } from "zod";
import { prisma } from "@/lib/db/client";

export const MAX_USER_NAME_CHARS = 40;

/** 앞뒤 공백·제어 문자를 지우고 연속 공백을 하나로. 빈 이름은 허용하지 않는다. */
export const UserNameInputSchema = z.object({
  name: z
    .string()
    .transform((v) => v.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "이름을 입력해 주세요.").max(MAX_USER_NAME_CHARS, `이름은 ${MAX_USER_NAME_CHARS}자까지 쓸 수 있습니다.`)),
});

export async function updateUserName(userId: string, name: string): Promise<string> {
  const row = await prisma.user.update({ where: { id: userId }, data: { name }, select: { name: true } });
  return row.name ?? name;
}
