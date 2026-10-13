export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
    this.name = 'AppError';

    if (
      !Number.isInteger(statusCode) ||
      (!(statusCode >= 400 && statusCode <= 499) && statusCode !== 503)
    ) {
      throw new RangeError('AppError statusCode must be an HTTP 4xx status or 503.');
    }
  }
}
