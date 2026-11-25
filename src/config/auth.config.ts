import type { Duration } from '@nestjs/authentication';
import type { EnvGetter } from './database.config.js';

export interface AuthConfig {
  kakao: {
    clientId: string;
    /** 카카오 콘솔에서 Client Secret을 "사용함"으로 했을 때만 */
    clientSecret?: string;
    redirectUri: string;
    /** 카카오 JavaScript SDK 키 (브라우저 로그인 버튼용). 없으면 SDK 로그인 버튼 비활성 */
    javascriptKey?: string;
    /** 개발 환경에서만 true: 인가 요청에 prompt=login을 붙여 카카오 세션이 있어도 매번 로그인 화면을 띄움 */
    forceLogin: boolean;
  };
  jwt: {
    /** HS256 키. 32바이트 이상 (짧으면 앱이 시작되지 않음) */
    accessSecret: string;
    accessTtl: Duration;
    refreshTtl: Duration;
  };
  /** 운영(HTTPS)에서만 쿠키에 Secure */
  secureCookies: boolean;
}

/** '15m', '14d' 형식만 허용 (쿠키 maxAge 계산과 같은 형식) */
function duration(get: EnvGetter, key: string, fallback: string): Duration {
  const value = get(key) || fallback;
  if (!/^\d+[smhd]$/.test(value)) {
    throw new Error(`환경 변수 ${key}="${value}" 형식이 잘못되었습니다. 예: 15m, 14d (단위 s/m/h/d)`);
  }
  return value as Duration;
}

function required(get: EnvGetter, key: string): string {
  const value = get(key);
  if (value === undefined || value === '') {
    throw new Error(`환경 변수 ${key} 가 비어 있습니다. backend/.env 를 확인하세요 (.env.example 참고).`);
  }
  return value;
}

export function authConfig(get: EnvGetter): AuthConfig {
  const production = get('NODE_ENV') === 'production';
  return {
    kakao: {
      clientId: required(get, 'KAKAO_CLIENT_ID'),
      clientSecret: get('KAKAO_CLIENT_SECRET') || undefined,
      redirectUri: required(get, 'KAKAO_REDIRECT_URI'),
      javascriptKey: get('KAKAO_JAVASCRIPT_KEY') || undefined,
      forceLogin: !production,
    },
    jwt: {
      accessSecret: required(get, 'JWT_ACCESS_SECRET'),
      accessTtl: duration(get, 'JWT_ACCESS_EXPIRES_IN', '15m'),
      refreshTtl: duration(get, 'JWT_REFRESH_EXPIRES_IN', '14d'),
    },
    secureCookies: production,
  };
}
