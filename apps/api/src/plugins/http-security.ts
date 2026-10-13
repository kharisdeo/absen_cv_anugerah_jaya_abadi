import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

const ALLOWED_METHODS = Object.freeze(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const ALLOWED_METHOD_SET = new Set<string>(ALLOWED_METHODS);
const ALLOWED_HEADERS = Object.freeze(['content-type']);
const ALLOWED_HEADER_SET = new Set<string>(ALLOWED_HEADERS);

function appendVary(reply: FastifyReply, names: readonly string[]): void {
  const current = reply.getHeader('vary');
  const currentValue = Array.isArray(current)
    ? current.join(', ')
    : typeof current === 'string'
      ? current
      : '';
  const values = currentValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.some((value) => value === '*')) return;

  const seen = new Set(values.map((value) => value.toLowerCase()));
  for (const name of names) {
    if (!seen.has(name.toLowerCase())) values.push(name);
    seen.add(name.toLowerCase());
  }
  reply.header('Vary', values.join(', '));
}

function isAllowedOrigin(origin: string | undefined, allowedOrigin: string | undefined): boolean {
  return origin !== undefined && allowedOrigin !== undefined && origin === allowedOrigin;
}

function readRequestedHeaders(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return [];
  return value
    .split(',')
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
}

function setCredentialedCorsHeaders(reply: FastifyReply, origin: string): void {
  reply.header('Access-Control-Allow-Origin', origin);
  reply.header('Access-Control-Allow-Credentials', 'true');
}

function isPreflight(request: FastifyRequest): boolean {
  return (
    request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined
  );
}

/** Register the API's browser boundary and transport-safe response headers. */
export function registerApiHttpSecurity(
  app: FastifyInstance,
  allowedOrigin: string | undefined,
): void {
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    const originAllowed = isAllowedOrigin(origin, allowedOrigin);

    if (isPreflight(request)) {
      const requestedMethod = request.headers['access-control-request-method']?.toUpperCase();
      const requestedHeaders = readRequestedHeaders(
        request.headers['access-control-request-headers'],
      );
      const preflightAllowed =
        originAllowed &&
        requestedMethod !== undefined &&
        ALLOWED_METHOD_SET.has(requestedMethod) &&
        requestedHeaders.every((header) => ALLOWED_HEADER_SET.has(header));

      if (!preflightAllowed || origin === undefined) {
        return reply.code(403).send();
      }

      setCredentialedCorsHeaders(reply, origin);
      reply.header('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
      if (requestedHeaders.length > 0) {
        reply.header('Access-Control-Allow-Headers', 'Content-Type');
      }
      return reply.code(204).send();
    }

    if (originAllowed && origin !== undefined) {
      setCredentialedCorsHeaders(reply, origin);
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');

    const varyNames = ['Origin'];
    if (isPreflight(request)) {
      varyNames.push('Access-Control-Request-Method');
      if (request.headers['access-control-request-headers'] !== undefined) {
        varyNames.push('Access-Control-Request-Headers');
      }
    }
    appendVary(reply, varyNames);
    return payload;
  });
}
