import { durationMs, readCookie } from './auth-cookies.js';

describe('auth-cookies', () => {
  it('durationMs: 15m, 14d 를 밀리초로', () => {
    expect(durationMs('15m')).toBe(15 * 60 * 1000);
    expect(durationMs('14d')).toBe(14 * 24 * 60 * 60 * 1000);
    expect(() => durationMs('2w')).toThrow();
  });

  it('readCookie: 이름이 정확히 같은 쿠키만 읽음', () => {
    const header = 'x_access_token=wrong; access_token=a.b.c; refresh_token=r%2Bx';
    expect(readCookie(header, 'access_token')).toBe('a.b.c');
    expect(readCookie(header, 'refresh_token')).toBe('r+x');
    expect(readCookie(header, 'missing')).toBeUndefined();
    expect(readCookie(undefined, 'access_token')).toBeUndefined();
    expect(readCookie('access_token=%E0%A4%A', 'access_token')).toBeUndefined();
  });
});
