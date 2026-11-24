/** AuthConfig 주입 토큰 */
export const AUTH_CONFIG = Symbol('AUTH_CONFIG');

/** 쿠키 이름 */
export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
/** GET /auth/kakao → 콜백 사이 CSRF 방지용 state */
export const KAKAO_STATE_COOKIE = 'kakao_state';

/** refresh 쿠키는 이 경로 아래 요청에만 실려 감 (/api/auth/refresh, /api/auth/logout) */
export const REFRESH_COOKIE_PATH = '/api/auth';
