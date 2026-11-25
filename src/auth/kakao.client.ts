import { BadGatewayException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { AuthConfig } from '../config/auth.config.js';
import { AUTH_CONFIG } from './auth.constants.js';

export interface KakaoProfile {
  /** 카카오 회원번호 */
  id: string;
  nickname: string | null;
  /** 동의항목에 이메일이 없으면 null */
  email: string | null;
  profileImageUrl: string | null;
}

interface KakaoTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

interface KakaoUserResponse {
  id: number;
  kakao_account?: {
    email?: string;
    is_email_verified?: boolean;
    profile?: { nickname?: string; profile_image_url?: string };
  };
}

const TIMEOUT_MS = 5000;

/** 카카오 REST API: 인가 코드 → 토큰 → 사용자 정보 */
@Injectable()
export class KakaoClient {
  private readonly logger = new Logger(KakaoClient.name);

  constructor(@Inject(AUTH_CONFIG) private readonly config: AuthConfig) {}

  /** 카카오 로그인 화면 주소 (개발용 GET /auth/kakao 에서 사용) */
  authorizeUrl(state: string): string {
    const url = new URL('https://kauth.kakao.com/oauth/authorize');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.kakao.clientId,
      redirect_uri: this.config.kakao.redirectUri,
      state,
    });
    // 개발용: 카카오 로그인 세션이 남아 있어도 로그인 화면을 다시 띄워 인증 과정을 반복 테스트
    if (this.config.kakao.forceLogin) params.set('prompt', 'login');
    url.search = params.toString();
    return url.toString();
  }

  /** 인가 코드로 사용자 정보까지 가져오기. 코드가 틀렸거나 만료됐으면 401 */
  async profileFromCode(code: string): Promise<KakaoProfile> {
    const token = await this.exchangeCode(code);
    return this.fetchProfile(token.access_token);
  }

  private async exchangeCode(code: string): Promise<KakaoTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.config.kakao.clientId,
      redirect_uri: this.config.kakao.redirectUri,
      code,
    });
    if (this.config.kakao.clientSecret) body.set('client_secret', this.config.kakao.clientSecret);

    const res = await this.request('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body,
    });
    if (res.ok) return (await res.json()) as KakaoTokenResponse;

    const error = (await res.json().catch(() => ({}))) as { error?: string; error_code?: string; error_description?: string };
    this.logger.warn(`카카오 토큰 발급 실패 ${res.status} ${error.error_code ?? ''} ${error.error_description ?? ''}`);
    // invalid_grant: 코드가 틀렸거나, 이미 썼거나, 만료됐거나, redirect_uri가 다름 → 다시 로그인
    if (res.status === 400 || res.status === 401) throw new UnauthorizedException('카카오 인가 코드가 유효하지 않습니다.');
    throw new BadGatewayException('카카오 로그인 서버 응답 오류');
  }

  private async fetchProfile(accessToken: string): Promise<KakaoProfile> {
    const res = await this.request('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      this.logger.warn(`카카오 사용자 정보 조회 실패 ${res.status}`);
      throw new BadGatewayException('카카오 사용자 정보를 가져오지 못했습니다.');
    }
    const user = (await res.json()) as KakaoUserResponse;
    const account = user.kakao_account ?? {};
    return {
      id: String(user.id),
      nickname: account.profile?.nickname ?? null,
      // 인증되지 않은 이메일은 쓰지 않음
      email: account.email && account.is_email_verified ? account.email : null,
      profileImageUrl: account.profile?.profile_image_url ?? null,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      this.logger.error(`카카오 요청 실패: ${url}`, err instanceof Error ? err.stack : String(err));
      throw new BadGatewayException('카카오 서버에 연결하지 못했습니다.');
    }
  }
}
