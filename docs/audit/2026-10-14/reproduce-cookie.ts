import { createRequire } from 'node:module';

const requireApi = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const Fastify = requireApi('fastify');
const cookie = requireApi('@fastify/cookie');
const app = Fastify({ logger: false });
await app.register(cookie, { secret: 'synthetic-audit-cookie-secret-2026-only' });
app.get('/probe', async (_request: unknown, reply: { setCookie: (...args: unknown[]) => void }) => {
  reply.setCookie('absen_session', 'synthetic-audit-token', {
    signed: true,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
  return { status: 'ok' };
});
try {
  const response = await app.inject({ method: 'GET', url: '/probe' });
  const value = decodeURIComponent(response.headers['set-cookie'].split(';')[0].split('=')[1]);
  const unsigned = app.unsignCookie(value);
  console.log(
    JSON.stringify({
      hasSmokeExpectedPrefix: value.startsWith('s:'),
      signatureValid: unsigned.valid,
      tokenMatches: unsigned.value === 'synthetic-audit-token',
    }),
  );
} finally {
  await app.close();
}
