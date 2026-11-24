import type { Duration } from '@nestjs/authentication';
import type { EnvGetter } from './database.config.js';

export interface AuthConfig {
  kakao: {
    clientId: string;
    /** 카카오 콘솔에서 Client Secret을 "사용함"으로 했을 때만 */
    clientSecret?: string;
    redirectUri: string;
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
  return {
    kakao: {
      clientId: required(get, 'KAKAO_CLIENT_ID'),
      clientSecret: get('KAKAO_CLIENT_SECRET') || undefined,
      redirectUri: required(get, 'KAKAO_REDIRECT_URI'),
    },
    jwt: {
      accessSecret: required(get, 'JWT_ACCESS_SECRET'),
      accessTtl: duration(get, 'JWT_ACCESS_EXPIRES_IN', '15m'),
      refreshTtl: duration(get, 'JWT_REFRESH_EXPIRES_IN', '14d'),
    },
    secureCookies: get('NODE_ENV') === 'production',
  };
}
