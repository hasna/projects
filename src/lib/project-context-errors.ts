export const PROJECT_CONTEXT_ERROR_CODES = [
  "PROJECT_ALREADY_REGISTERED",
  "PROJECT_IDENTITY_CONFLICT",
  "PROJECT_ARCHIVED",
  "PROJECT_DELETED",
  "PROJECT_MARKER_ORPHANED",
  "PROJECT_MARKER_INVALID",
  "PROJECT_AUTHORITY_UNAVAILABLE",
  "PROJECT_NOT_FOUND",
  "PROJECT_PATH_INVALID",
  "PROJECT_IDEMPOTENCY_KEY_REUSED",
  "PROJECT_CONTEXT_BUNDLE_TOO_LARGE",
  "PROJECT_CONTEXT_BUNDLE_INVALID",
] as const;

export type ProjectContextErrorCode = typeof PROJECT_CONTEXT_ERROR_CODES[number];

export const PROJECT_CONTEXT_ERROR_STATUS: Readonly<Record<ProjectContextErrorCode, number>> = {
  PROJECT_ALREADY_REGISTERED: 409,
  PROJECT_IDENTITY_CONFLICT: 409,
  PROJECT_ARCHIVED: 409,
  PROJECT_DELETED: 409,
  PROJECT_MARKER_ORPHANED: 409,
  PROJECT_MARKER_INVALID: 400,
  PROJECT_AUTHORITY_UNAVAILABLE: 503,
  PROJECT_NOT_FOUND: 404,
  PROJECT_PATH_INVALID: 400,
  PROJECT_IDEMPOTENCY_KEY_REUSED: 409,
  PROJECT_CONTEXT_BUNDLE_TOO_LARGE: 500,
  PROJECT_CONTEXT_BUNDLE_INVALID: 400,
};

export function projectContextErrorStatus(code: ProjectContextErrorCode): number {
  return PROJECT_CONTEXT_ERROR_STATUS[code];
}

export interface CanonicalProjectSummary {
  id: string;
  slug: string;
  status: string;
}

export function canonicalProjectSummary(
  project: { id: string; slug: string; status: string },
): CanonicalProjectSummary {
  return { id: project.id, slug: project.slug, status: project.status };
}

export class ProjectContextError extends Error {
  readonly code: ProjectContextErrorCode;
  readonly status: number;
  readonly project?: CanonicalProjectSummary;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ProjectContextErrorCode,
    message: string,
    options: {
      status?: number;
      project?: { id: string; slug: string; status: string } | CanonicalProjectSummary;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(`${code}: ${message}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProjectContextError";
    this.code = code;
    this.status = options.status ?? projectContextErrorStatus(code);
    this.project = options.project ? canonicalProjectSummary(options.project) : undefined;
    this.details = options.details;
  }
}

export function isProjectContextError(error: unknown): error is ProjectContextError {
  return error instanceof ProjectContextError
    || Boolean(
      error
      && typeof error === "object"
      && "code" in error
      && PROJECT_CONTEXT_ERROR_CODES.includes(String((error as { code: unknown }).code) as ProjectContextErrorCode),
    );
}
