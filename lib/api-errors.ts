export class PublicApiError extends Error {
  status: number;
  details?: Record<string, unknown>;

  constructor(message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.details = details;
  }
}
