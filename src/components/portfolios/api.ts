/** 포트폴리오 화면 공용: 오류 응답 문구. */
export async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (data?.error) return data.error;
  if (res.status === 413) return "파일이 너무 큽니다.";
  if (res.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  return fallback;
}

export const NETWORK_ERROR = "서버에 연결하지 못했습니다.";
