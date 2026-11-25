import { Body, Controller, Delete, Get, HttpCode, Inject, Patch, Res } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { clearAuthCookies } from '../auth/auth-cookies.js';
import { ACCESS_COOKIE, AUTH_CONFIG } from '../auth/auth.constants.js';
import { openApiArray } from '../common/openapi.js';
import type { AuthConfig } from '../config/auth.config.js';
import type { User } from '../database/schema/entities/auth/user.entity.js';
import { meResponseSchema, updateMeSchema, withdrawSchema, type MeResponse, type UpdateMeInput } from './me.schemas.js';
import { MeService } from './me.service.js';

/** 계정 API. 로그인 필요 (전역 가드). 쿠키가 없거나 만료면 401 */
@ApiTags('계정')
@ApiCookieAuth(ACCESS_COOKIE)
@ApiUnauthorizedResponse({ description: '로그인 안 됨 / access 토큰 만료 → POST /api/auth/refresh' })
@Controller('me')
export class MeController {
  constructor(
    private readonly me: MeService,
    @Inject(AUTH_CONFIG) private readonly config: AuthConfig,
  ) {}

  @Get()
  @ApiOperation({ summary: '내 정보', description: '프론트엔드는 배열의 첫 번째 값을 사용합니다.' })
  @ApiOkResponse({ description: '내 정보(한 건짜리 배열)', schema: openApiArray(meResponseSchema) })
  async getMe(@CurrentUser() user: User): Promise<MeResponse[]> {
    return [await this.me.getMe(user)];
  }

  @Patch()
  @ApiOperation({ summary: '내 정보 변경', description: '닉네임과 카카오톡 메시지 전송 동의 여부. 바꾼 항목만 보냅니다.' })
  @ApiOkResponse({ description: '변경된 내 정보', schema: openApiArray(meResponseSchema) })
  @ApiBadRequestResponse({ description: '닉네임 1~30자, kakaoConsent는 boolean, 그 밖의 항목은 거부' })
  async updateMe(@CurrentUser() user: User, @Body({ schema: updateMeSchema }) body: UpdateMeInput): Promise<MeResponse[]> {
    return [await this.me.updateMe(user, body)];
  }

  @Delete()
  @HttpCode(204)
  @ApiOperation({ summary: '서비스 탈퇴', description: '화면에서 확인 문구 "삭제"를 입력해야 합니다. 로그인 쿠키도 지웁니다.' })
  @ApiNoContentResponse({ description: '탈퇴 처리하고 로그아웃했습니다.' })
  @ApiBadRequestResponse({ description: 'confirm이 "삭제"가 아님' })
  async withdraw(
    @CurrentUser() user: User,
    @Body({ schema: withdrawSchema }) _body: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.me.withdraw(user);
    clearAuthCookies(res, this.config.secureCookies);
  }
}
