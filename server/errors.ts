import type { ContentfulStatusCode } from "hono/utils/http-status";

export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: ContentfulStatusCode = 409,
  ) {
    super(message);
  }
}
