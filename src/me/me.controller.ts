import { Controller, Get } from '@nestjs/common';
import { CurrentUser } from '@nestjs/authentication';
import type { User } from '../database/schema/entities/auth/user.entity.js';
import { MeService, type MeResponse } from './me.service.js';

/** 로그인 필요 (전역 가드). 쿠키가 없거나 만료면 401 */
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  /** 스웨거 규칙: 조회 응답은 한 건이어도 배열 */
  @Get()
  async getMe(@CurrentUser() user: User): Promise<MeResponse[]> {
    return [await this.me.getMe(user)];
  }
}
