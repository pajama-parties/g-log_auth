import type { CookieOptions, Response } from 'express';
import type { TokenPair } from '@nestjs/authentication';
import { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.constants.js';

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** '15m', '14d' 같은 기간 → 밀리초 */
export function durationMs(value: string | number): number {
  if (typeof value === 'number') return value;
  const match = /^(\d+)\s*([smhd])$/.exec(value.trim());
  if (!match) throw new Error(`기간 형식이 잘못되었습니다: "${value}" (예: 15m, 14d)`);
  return Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
}

/** 요청의 Cookie 헤더에서 값 하나 읽기 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function base(secure: boolean): CookieOptions {
  // HttpOnly: JS에서 못 읽음(XSS로 토큰 탈취 방지). SameSite=Lax: 다른 사이트에서 보낸 POST에는 쿠키가 안 실림(CSRF 방지)
  return { httpOnly: true, sameSite: 'lax', secure };
}

export function setAuthCookies(res: Response, tokens: TokenPair, opts: { secure: boolean; refreshTtlMs: number }) {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, { ...base(opts.secure), path: '/', maxAge: tokens.expiresIn * 1000 });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base(opts.secure),
    path: REFRESH_COOKIE_PATH,
    maxAge: opts.refreshTtlMs,
  });
}

export function clearAuthCookies(res: Response, secure: boolean) {
  res.clearCookie(ACCESS_COOKIE, { ...base(secure), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(secure), path: REFRESH_COOKIE_PATH });
}
