export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly isOperational: boolean;
  public readonly metadata?: Record<string, unknown>;

  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    metadata?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = true;
    this.metadata = metadata;

    Object.setPrototypeOf(this, AppError.prototype);
  }

  static validation(message: string, metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'VALIDATION_ERROR', 400, metadata);
  }

  static notFound(message: string, metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'NOT_FOUND', 404, metadata);
  }

  static unauthorized(message: string = 'Unauthorized', metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'UNAUTHORIZED', 401, metadata);
  }

  static forbidden(message: string = 'Forbidden', metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'FORBIDDEN', 403, metadata);
  }

  static internal(message: string = 'Internal server error', metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'INTERNAL_ERROR', 500, metadata);
  }

  static database(message: string, metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'DATABASE_ERROR', 500, metadata);
  }

  static external(message: string, metadata?: Record<string, unknown>): AppError {
    return new AppError(message, 'EXTERNAL_ERROR', 502, metadata);
  }

  toSafeObject(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.metadata && { metadata: this.metadata }),
    };
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}