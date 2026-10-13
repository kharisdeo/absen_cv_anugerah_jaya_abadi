import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from './app-error.js';

interface ProblemDetails {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  instance: string;
  code: string;
  requestId: string;
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }

  return typeof error.statusCode === 'number' ? error.statusCode : undefined;
}

function sendProblem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  detail: string,
): FastifyReply {
  const problem: ProblemDetails = {
    type: 'about:blank',
    title:
      status === 404
        ? 'Not Found'
        : status === 503
          ? 'Service Unavailable'
          : status >= 500
            ? 'Internal Server Error'
            : 'Request Error',
    status,
    detail,
    instance: new URL(request.url, 'http://localhost').pathname,
    code,
    requestId: request.id,
  };

  return reply
    .header('x-request-id', request.id)
    .status(status)
    .type('application/problem+json')
    .send(problem);
}

export function registerErrorHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const appError = error instanceof AppError ? error : undefined;
    const candidateStatus = appError?.statusCode ?? getStatusCode(error);
    const status =
      candidateStatus !== undefined &&
      ((candidateStatus >= 400 && candidateStatus <= 499) || candidateStatus === 503)
        ? candidateStatus
        : 500;
    const code =
      appError?.code ??
      (status === 413
        ? 'PAYLOAD_TOO_LARGE'
        : status === 415
          ? 'UNSUPPORTED_MEDIA_TYPE'
          : status === 429
            ? 'RATE_LIMITED'
            : status === 500
              ? 'INTERNAL_SERVER_ERROR'
              : 'INVALID_REQUEST');
    const detail =
      appError?.publicMessage ??
      (status === 500 ? 'An unexpected error occurred.' : 'The request could not be processed.');

    if (status >= 500) {
      request.log.error({ err: error }, 'Unhandled request error');
    } else {
      request.log.info({ code, statusCode: status }, 'Request rejected');
    }

    return sendProblem(request, reply, status, code, detail);
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(request, reply, 404, 'NOT_FOUND', 'The requested resource was not found.'),
  );
}
