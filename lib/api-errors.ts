export class PublicApiError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
  }
}
