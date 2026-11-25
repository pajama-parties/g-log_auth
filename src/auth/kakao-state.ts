import { randomBytes } from 'node:crypto';
import type { Response } from 'express';
import { KAKAO_STATE_COOKIE } from './auth.constants.js';

/** state 쿠키는 콜백(/auth/kakao/callback)에만 실려 감 */
export const KAKAO_STATE_COOKIE_PATH = '/auth/kakao';

/**
 * 카카오 인가 요청용 state 발급 + 쿠키 저장.
 * 콜백에서 같은 값이 돌아오는지 확인 (남이 만든 로그인 링크로 내 브라우저가 로그인되는 것 방지)
 */
export function issueKakaoState(res: Response, secure: boolean): string {
  const state = randomBytes(16).toString('base64url');
  res.cookie(KAKAO_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: KAKAO_STATE_COOKIE_PATH,
    maxAge: 10 * 60 * 1000,
  });
  return state;
}
