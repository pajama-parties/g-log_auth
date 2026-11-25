import { timingSafeEqual } from 'node:crypto';
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
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExcludeEndpoint,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { openApiArray } from '../common/openapi.js';
import type { AuthConfig } from '../config/auth.config.js';
import type { User } from '../database/schema/entities/auth/user.entity.js';
import { meResponseSchema, type MeResponse } from '../me/me.schemas.js';
import { MeService } from '../me/me.service.js';
import { clearAuthCookies, durationMs, readCookie, setAuthCookies } from './auth-cookies.js';
import { ACCESS_COOKIE, AUTH_CONFIG, KAKAO_STATE_COOKIE, REFRESH_COOKIE } from './auth.constants.js';
import {
  kakaoLoginSchema,
  loginSchema,
  signupSchema,
  type KakaoLoginInput,
  type LoginInput,
  type SignupInput,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { KAKAO_STATE_COOKIE_PATH, issueKakaoState } from './kakao-state.js';
import { KakaoClient } from './kakao.client.js';

/** 비밀번호 무작위 대입 방지: 같은 IP에서 1분에 SIGN_IN_RATE_LIMIT(기본 10)번까지. 요청마다 읽어서 테스트에서 바꿀 수 있음 */
const SIGN_IN_LIMIT = { default: { limit: () => Number(process.env.SIGN_IN_RATE_LIMIT ?? 10), ttl: 60_000 } };
/** 카카오 콜백 성공 후 이동할 곳 (로그인한 내 정보 JSON) */
const AFTER_LOGIN_URL = '/api/me';
const COOKIE_NOTE ='access_token(15분)·refresh_token(14일) HttpOnly 쿠키를 설정합니다.';

function sameString(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * 인증 API. 로그인 전에도 부를 수 있어야 하므로 전부 @Public().
 * GET /auth/kakao, /auth/kakao/callback 은 /api 접두사 없음 (카카오 콘솔에 등록한 Redirect URI)
 */
@ApiTags('인증')
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

  @Post('signup')
  @Throttle(SIGN_IN_LIMIT)
  @ApiOperation({ summary: '이메일 가입', description: `가입 후 바로 로그인됩니다. ${COOKIE_NOTE}` })
  @ApiCreatedResponse({ description: '가입한 내 정보(한 건짜리 배열)', schema: openApiArray(meResponseSchema) })
  @ApiBadRequestResponse({ description: '이메일 형식, 비밀번호 8~64자(영문+숫자), 닉네임 1~30자' })
  @ApiConflictResponse({ description: '이미 가입된 이메일' })
  @ApiTooManyRequestsResponse({ description: '1분에 10번 초과' })
  async signup(
    @Body({ schema: signupSchema }) body: SignupInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse[]> {
    const user = await this.auth.signupWithEmail(body, req.ip);
    return this.issue(user, 'password', res);
  }

  @Post('login')
  @HttpCode(200)
  @Throttle(SIGN_IN_LIMIT)
  @ApiOperation({ summary: '이메일 로그인', description: COOKIE_NOTE })
  @ApiOkResponse({ description: '내 정보(한 건짜리 배열)', schema: openApiArray(meResponseSchema) })
  @ApiUnauthorizedResponse({ description: '이메일 또는 비밀번호가 틀림 (어느 쪽인지 알려 주지 않음)' })
  @ApiForbiddenResponse({ description: '정지된 계정' })
  @ApiTooManyRequestsResponse({ description: '1분에 10번 초과' })
  async login(
    @Body({ schema: loginSchema }) body: LoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse[]> {
    const user = await this.auth.loginWithEmail(body, req.ip);
    return this.issue(user, 'password', res);
  }

  @Post('kakao')
  @HttpCode(200)
  @Throttle(SIGN_IN_LIMIT)
  @ApiOperation({ summary: '카카오 로그인', description: `프런트가 받은 카카오 인가 코드로 로그인합니다. 처음이면 가입까지. ${COOKIE_NOTE}` })
  @ApiOkResponse({ description: '내 정보(한 건짜리 배열)', schema: openApiArray(meResponseSchema) })
  @ApiUnauthorizedResponse({ description: '인가 코드가 틀렸거나 이미 썼거나 만료됨' })
  @ApiForbiddenResponse({ description: '정지된 계정' })
  async kakaoLogin(
    @Body({ schema: kakaoLoginSchema }) body: KakaoLoginInput,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MeResponse[]> {
    const user = await this.auth.loginWithKakao(body.code, req.ip);
    return this.issue(user, 'kakao', res);
  }

  @Post('refresh')
  @HttpCode(204)
  @ApiOperation({
    summary: 'access 토큰 재발급',
    description: 'API가 401이면 한 번 호출하고 원래 요청을 다시 보냅니다. refresh_token 쿠키는 한 번 쓰면 새 것으로 바뀝니다.',
  })
  @ApiNoContentResponse({ description: '새 쿠키를 설정했습니다.' })
  @ApiUnauthorizedResponse({ description: 'refresh 토큰이 없거나 만료·폐기·재사용됨 → 다시 로그인' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE);
    if (!refreshToken) {
      clearAuthCookies(res, this.config.secureCookies);
      throw new UnauthorizedException('다시 로그인해 주세요.');
    }
    try {
      // 이미 쓴 토큰이 또 오면(탈취 의심) 그 로그인 전체를 끊음
      const pair = await this.tokens.refresh(refreshToken);
      setAuthCookies(res, pair, { secure: this.config.secureCookies, refreshTtlMs: this.refreshTtlMs });
    } catch (err) {
      clearAuthCookies(res, this.config.secureCookies);
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @ApiOperation({ summary: '로그아웃', description: '이 기기의 로그인만 끝냅니다. access 토큰이 만료됐어도 됩니다.' })
  @ApiNoContentResponse({ description: '쿠키를 지웠습니다.' })
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = readCookie(req.headers.cookie, REFRESH_COOKIE);
    if (refreshToken) await this.tokens.revoke(refreshToken);
    clearAuthCookies(res, this.config.secureCookies);
  }

  /** (개발용) 브라우저로 열면 카카오 로그인 화면으로 */
  @Get('kakao')
  @ApiExcludeEndpoint()
  kakaoStart(@Res() res: Response) {
    const state = issueKakaoState(res, this.config.secureCookies);
    res.redirect(this.kakao.authorizeUrl(state));
  }

  /**
   * (개발용) 카카오가 돌려보내는 주소.
   * 성공하면 /api/me 로 303 → 주소창에 code·state가 남지 않아 새로고침·뒤로가기로 콜백이 다시 열리지 않음.
   */
  @Get('kakao/callback')
  @ApiExcludeEndpoint()
  async kakaoCallback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const expected = readCookie(req.headers.cookie, KAKAO_STATE_COOKIE);
    res.clearCookie(KAKAO_STATE_COOKIE, { path: KAKAO_STATE_COOKIE_PATH });
    if (error) throw new UnauthorizedException('카카오 로그인이 취소되었습니다.');
    if (!state || !expected || !sameString(state, expected)) {
      // 방금 성공한 콜백이 한 번 더 열린 경우(state 쿠키는 이미 지워짐): 이미 로그인돼 있으면 "만료" 대신 내 정보로
      if (readCookie(req.headers.cookie, ACCESS_COOKIE)) return res.redirect(303, AFTER_LOGIN_URL);
      throw new UnauthorizedException('로그인 요청이 만료되었습니다. /auth/kakao 에서 다시 시작해 주세요.');
    }
    if (!code) throw new BadRequestException('code가 없습니다.');
    const user = await this.auth.loginWithKakao(code, req.ip);
    await this.setTokens(user, 'kakao', res);
    res.redirect(303, AFTER_LOGIN_URL);
  }

  /** 토큰 발급 → 쿠키 → 내 정보 응답 */
  private async issue(user: User, method: string, res: Response): Promise<MeResponse[]> {
    await this.setTokens(user, method, res);
    return [await this.me.getMe(user)];
  }

  private async setTokens(user: User, method: string, res: Response) {
    const pair = await this.tokens.issue(String(user.id), { method });
    setAuthCookies(res, pair, { secure: this.config.secureCookies, refreshTtlMs: this.refreshTtlMs });
  }
}
