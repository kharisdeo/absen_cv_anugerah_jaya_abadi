export const SESSION_COOKIE_NAME = 'absen_session';

export type SmokeAssertion = (condition: boolean, message: string) => asserts condition;

export type SessionCookieCodec = Readonly<{
  parseCookie: (cookieHeader: string) => Record<string, string>;
  unsignCookie: (value: string) => Readonly<{ valid: boolean; value: string | null }>;
}>;

export function readSignedSessionCookie(
  header: unknown,
  cookieCodec: SessionCookieCodec,
  requireCheck: SmokeAssertion,
): Readonly<{ cookie: string; token: string }> {
  const setCookies = Array.isArray(header)
    ? header.filter((value): value is string => typeof value === 'string')
    : typeof header === 'string'
      ? [header]
      : [];

  const candidates = setCookies.flatMap((setCookie) => {
    const cookie = setCookie.split(';', 1)[0]?.trim() ?? '';
    try {
      const parsed = cookieCodec.parseCookie(cookie);
      return Object.hasOwn(parsed, SESSION_COOKIE_NAME)
        ? [{ setCookie, cookie, signedValue: parsed[SESSION_COOKIE_NAME]! }]
        : [];
    } catch {
      return [];
    }
  });

  requireCheck(candidates.length === 1, 'Login must set exactly one expected session cookie.');

  const candidate = candidates[0];
  requireCheck(candidate !== undefined, 'Login must set exactly one expected session cookie.');
  const { setCookie, cookie, signedValue } = candidate;
  const attributes = setCookie
    .split(';')
    .slice(1)
    .map((attribute) => attribute.trim());
  requireCheck(
    attributes.some((attribute) => /^httponly$/i.test(attribute)),
    'Session cookie must be HttpOnly.',
  );
  requireCheck(
    attributes.some((attribute) => /^samesite=strict$/i.test(attribute)),
    'Session cookie must use SameSite=Strict.',
  );
  requireCheck(
    attributes.some((attribute) => /^path=\/$/i.test(attribute)),
    'Session cookie must use Path=/.',
  );

  const unsigned = cookieCodec.unsignCookie(signedValue);
  requireCheck(unsigned.valid, 'Session cookie signature must be valid.');
  requireCheck(
    typeof unsigned.value === 'string' && unsigned.value.length > 0,
    'Session cookie must contain a signed token.',
  );

  return { cookie, token: unsigned.value };
}
