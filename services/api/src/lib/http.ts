import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyStructuredResultV2,
} from 'aws-lambda';
import { MAX_BODY_BYTES, type Problem } from '@siddiq3/driftless-contracts';
import type { z } from 'zod';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyStructuredResultV2;

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly errors?: Problem['errors'],
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const Errors = {
  badRequest: (detail: string, errors?: Problem['errors']) =>
    new HttpError(400, 'bad_request', detail, errors),
  unauthorized: () => new HttpError(401, 'unauthorized', 'authentication required'),
  forbidden: () => new HttpError(403, 'forbidden', 'not allowed'),
  notFound: () => new HttpError(404, 'not_found', 'resource not found'),
  conflict: (code: string, detail: string) => new HttpError(409, code, detail),
  preconditionFailed: (detail: string) => new HttpError(412, 'precondition_failed', detail),
  preconditionRequired: (detail: string) => new HttpError(428, 'precondition_required', detail),
  tooLarge: () => new HttpError(413, 'payload_too_large', `body exceeds ${MAX_BODY_BYTES} bytes`),
  unsupportedMedia: () => new HttpError(415, 'unsupported_media_type', 'expected application/json'),
};

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

export function problem(err: HttpError): ApiResult {
  const body: Problem = {
    type: `https://driftless.app/problems/${err.code}`,
    title: TITLES[err.status] ?? 'Error',
    status: err.status,
    code: err.code,
    detail: err.message,
    ...(err.errors ? { errors: err.errors } : {}),
  };
  return {
    statusCode: err.status,
    headers: { 'content-type': 'application/problem+json', ...SECURITY_HEADERS, ...err.headers },
    body: JSON.stringify(body),
  };
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ApiResult {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', ...SECURITY_HEADERS, ...headers },
    body: JSON.stringify(body),
  };
}

export function header(event: ApiEvent, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** Raw body as a UTF-8 string, enforcing the size limit before any parsing. */
export function rawBody(event: ApiEvent): string {
  const raw = event.body ?? '';
  const bytes = event.isBase64Encoded ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
  if (bytes.byteLength > MAX_BODY_BYTES) throw Errors.tooLarge();
  return bytes.toString('utf8');
}

export function parseBody<S extends z.ZodType>(event: ApiEvent, schema: S): z.infer<S> {
  const ct = header(event, 'content-type') ?? '';
  if (!/^application\/json(\s*;|$)/i.test(ct)) throw Errors.unsupportedMedia();
  const text = rawBody(event);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw Errors.badRequest('malformed JSON');
  }
  return validate(schema, data);
}

export function validate<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw Errors.badRequest(
      'validation failed',
      r.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}
