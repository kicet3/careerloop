/** 사용자에게 그대로 보여줄 한국어 메시지 + HTTP 상태. */
export class DiagnosisServiceError extends Error {
  constructor(
    message: string,
    readonly status: 404 | 409 | 429,
  ) {
    super(message);
    this.name = "DiagnosisServiceError";
  }
}
