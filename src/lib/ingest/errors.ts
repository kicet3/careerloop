/** 추출 실패. message는 사용자에게 그대로 보여 줄 한국어 문장이다. */
export class IngestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 415 = 400,
  ) {
    super(message);
    this.name = "IngestError";
  }
}
