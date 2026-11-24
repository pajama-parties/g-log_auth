import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { Public, TokenService } from '@nestjs/authentication';
import type { Request, Response } from 'express';
import type { AuthConfig } from '../config/auth.config.js';
import { MeService, type MeResponse } from '../me/me.service.js';
import { clearAuthCookies, durationMs, readCookie, setAuthCookies } from './auth-cookies.js';
import { AUTH_CONFIG, KAKAO_STATE_COOKIE, REFRESH_COOKIE } from './auth.constants.js';
import { AuthService } from './auth.service.js';
import { KakaoClient } from './kakao.client.js';

const STATE_COOKIE_PATH = '/auth/kakao';

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 인증 API. 로그인 전에도 부를 수 있어야 하므로 전부 @Public().
 * - POST /api/auth/kakao     : 프런트가 받은 인가 코드로 로그인 (스웨거)
 * - POST /api/auth/refresh   : access 토큰 재발급 (refresh 쿠키 사용)
 * - POST /api/auth/logout    : 로그아웃
 * - GET  /auth/kakao         : (개발용) 카카오 로그인 화면으로 이동
 * - GET  /auth/kakao/callback: (개발용) 카카오가 돌려보내는 주소. 카카오 콘솔에 등록한 Redirect URI
 */
@Public()
@Controller('auth')
export class AuthController {
  private readonly refreshTtlMs: number;

  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly kakao: KakaoClient,
    private readonly me: MeService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {
    this.refreshTtlMs = durationMs(config.jwt.refreshTtl);
  }

  @Get('kakao')
  kakaoStart(@Res() res: Response) {
    // 콜백에서 같은 값이 돌아오는지 확인 (남이 만든 로그인 링크로 내 브라우저가 로그인되는 것 방지)
    const state = randomBytes(16).toString('base64url');
    res.cookie(KAKAO_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.secureCookies,
      path: STATE_COOKIE_PATH,
      maxAge: 10 * 60 * 1000,
    });
    res.redirect(this.kakao.authorizeUrl(state));
  }

  @Get('kakao/callback')
  async kakaoCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse[]> {
    const expected = readCookie(req.headers.cookie, KAKAO_STATE_COOKIE);
    res.clearCookie(KAKAO_STATE_COOKIE, { path: STATE_COOKIE_PATH });
    if (error) throw new UnauthorizedException('카카오 로그인이 취소되었습니다.');
    if (!state || !expected || !sameString(state, expected)) {
      throw new UnauthorizedException('로그인 요청이 만료되었습니다. 다시 시도해 주세요.');
    }
    if (!code) throw new BadRequestException('code가 없습니다.');
    return this.signIn(code, req, res);
  }

  @Post('kakao')
  @HttpCode(200)
  async kakaoLogin(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code !== 'string' || code.length === 0 || code.length > 512) {
      throw new BadRequestException('code(카카오 인가 코드)가 필요합니다.');
    }
    return this.signIn(code, req, res);
  }

  @Post('refresh')
  @HttpCode(204)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE);
    if (!refreshToken) {
      clearAuthCookies(res, this.config.secureCookies);
      throw new UnauthorizedException('다시 로그인해 주세요.');
    }
    try {
      // 한 번 쓴 refresh 토큰은 버려지고 새 것이 발급됨. 이미 쓴 토큰이 또 오면(탈취 의심) 그 로그인 전체를 끊음
      const pair = await this.tokens.refresh(refreshToken);
      setAuthCookies(res, pair, { secure: this.config.secureCookies, refreshTtlMs: this.refreshTtlMs });
    } catch (err) {
      clearAuthCookies(res, this.config.secureCookies);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // access 토큰이 이미 만료됐어도 로그아웃은 되어야 하므로 refresh 쿠키로 처리
    const refreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE);
    if (refreshToken) await this.tokens.revoke(refreshToken);
    clearAuthCookies(res, this.config.secureCookies);
  }

  private async signIn(code: string, req: Request, res: Response): Promise<MeResponse[]> {
    const user = await this.auth.loginWithKakao(code, req.ip);
    const pair = await this.tokens.issue(String(user.id), { method: 'kakao' });
    setAuthCookies(res, pair, { secure: this.config.secureCookies, refreshTtlMs: this.refreshTtlMs });
    return [await this.me.getMe(user)];
  }
}
