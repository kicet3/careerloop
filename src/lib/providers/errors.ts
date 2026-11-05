/** 엔진 연결·선택 오류. 사용자에게 그대로 보여줄 한국어 메시지 + HTTP 상태. */
export class ProviderServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderServiceError";
  }
}
