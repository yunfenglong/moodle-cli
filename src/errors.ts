export type ErrorCode =
  | "unexpected_error"
  | "auth_failed"
  | "config_error"
  | "usage_error"
  | "not_found"
  | "api_error";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, code: ErrorCode = "unexpected_error", exitCode = 1, hint?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

export class AuthError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, "auth_failed", 2, hint);
  }
}

export class ConfigError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, "config_error", 2, hint);
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, "usage_error", 3, hint);
  }
}

export class NotFoundError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, "not_found", 4, hint);
  }
}

export class MoodleAPIError extends CliError {
  readonly moodleErrorCode?: string;

  constructor(message: string, moodleErrorCode?: string) {
    super(message, "api_error", 1);
    this.moodleErrorCode = moodleErrorCode;
  }
}

export function isLoginRequiredError(error: unknown): boolean {
  if (!(error instanceof MoodleAPIError)) {
    return false;
  }
  return ["servicerequireslogin", "sitepolicynotagreed"].includes(error.moodleErrorCode ?? "");
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  if (error instanceof Error) {
    return new CliError(error.message);
  }
  return new CliError(String(error));
}
