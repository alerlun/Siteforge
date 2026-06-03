import { corsHeaders } from './cors.ts';

export class HttpError extends Error {
  constructor(public status: number, public code: string, public detail?: unknown) {
    super(code);
  }
}

export function errorResponse(status: number, code: string, detail?: unknown): Response {
  const body: Record<string, unknown> = { error: code };
  if (detail !== undefined) body.detail = detail;
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function fromHttpError(err: unknown): Response {
  if (err instanceof HttpError) return errorResponse(err.status, err.code, err.detail);
  const msg = err instanceof Error ? err.message : String(err);
  return errorResponse(500, 'internal_error', msg);
}

const DEFAULT_MAX_BYTES = 32 * 1024;

export async function readBoundedText(req: Request, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  const len = req.headers.get('content-length');
  if (len) {
    const n = parseInt(len, 10);
    if (Number.isFinite(n) && n > maxBytes) {
      throw new HttpError(413, 'payload_too_large', { maxBytes });
    }
  }
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'payload_too_large', { maxBytes });
  return text;
}

export async function readBoundedJson(req: Request, maxBytes = DEFAULT_MAX_BYTES): Promise<unknown> {
  const text = await readBoundedText(req, maxBytes);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

export function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip') ?? 'unknown';
}
