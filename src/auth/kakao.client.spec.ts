import { describe, expect, it } from 'vitest';
import { authConfig } from '../config/auth.config.js';
import { KakaoClient } from './kakao.client.js';

function clientFor(nodeEnv: string | undefined) {
  const env: Record<string, string | undefined> = {
    NODE_ENV: nodeEnv,
    KAKAO_CLIENT_ID: 'client-id',
    KAKAO_REDIRECT_URI: 'http://localhost:3000/auth/kakao/callback',
    JWT_ACCESS_SECRET: 'x'.repeat(32),
  };
  return new KakaoClient(authConfig((key) => env[key]));
}

describe('KakaoClient.authorizeUrl', () => {
  it('개발 환경에서는 prompt=login을 붙여 매번 로그인 화면을 띄운다', () => {
    const url = new URL(clientFor(undefined).authorizeUrl('state-1'));
    expect(url.searchParams.get('prompt')).toBe('login');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('client_id')).toBe('client-id');
  });

  it('운영 환경(NODE_ENV=production)에서는 prompt를 붙이지 않는다', () => {
    const url = new URL(clientFor('production').authorizeUrl('state-1'));
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});
