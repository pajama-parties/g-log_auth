import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Not } from 'typeorm';
import { AUTH_CONNECTION } from '../config/database.config.js';
import { OAuthAccount } from '../database/schema/entities/auth/oauth-account.entity.js';
import type { User } from '../database/schema/entities/auth/user.entity.js';
import { Device } from '../database/schema/entities/service/device.entity.js';
import { Plant } from '../database/schema/entities/service/plant.entity.js';
import { UserProfile } from '../database/schema/entities/service/user-profile.entity.js';
import type { UserRole } from '../database/schema/enums.js';

/** 스웨거 components.schemas.User */
export interface MeResponse {
  name: string;
  role: string;
  email: string | null;
  connectedAt: string | null;
  kakaoConsent: boolean;
  potCount: number;
  sensorOnline: number;
  sensorTotal: number;
  recordedDays: number;
}

const ROLE_LABELS: Record<UserRole, string> = { USER: '식물 집사', ADMIN: '관리자' };
/** 2시간 넘게 값이 없으면 오프라인 (devices.last_seen_at 기준) */
const OFFLINE_AFTER_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** '10월 30일' (한국 시간) */
function koreanMonthDay(date: Date): string {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}

@Injectable()
export class MeService {
  constructor(
    @InjectDataSource(AUTH_CONNECTION) private readonly authDb: DataSource,
    @InjectDataSource() private readonly serviceDb: DataSource,
  ) {}

  async getMe(user: User): Promise<MeResponse> {
    const [profile, kakao, potCount, sensorTotal, sensorOnline] = await Promise.all([
      this.serviceDb.getRepository(UserProfile).findOne({ where: { userId: user.id } }),
      this.authDb.getRepository(OAuthAccount).findOne({ where: { userId: user.id, provider: 'KAKAO' } }),
      this.serviceDb.getRepository(Plant).count({ where: { userId: user.id } }),
      this.serviceDb.getRepository(Device).count({ where: { userId: user.id, plantId: Not(IsNull()) } }),
      this.serviceDb.getRepository(Device).count({
        where: { userId: user.id, plantId: Not(IsNull()), lastSeenAt: MoreThan(new Date(Date.now() - OFFLINE_AFTER_MS)) },
      }),
    ]);

    const since = profile?.createdAt ?? user.createdAt;
    return {
      name: profile?.nickname ?? ROLE_LABELS.USER,
      role: ROLE_LABELS[user.role],
      email: user.email ?? kakao?.providerEmail ?? null,
      connectedAt: kakao ? koreanMonthDay(kakao.linkedAt) : null,
      kakaoConsent: profile?.kakaoConsent ?? false,
      potCount,
      sensorOnline,
      sensorTotal,
      // 확인 필요(설계 엑셀 개요 8번): 지금은 "가입 후 며칠째"로 계산
      recordedDays: Math.floor((Date.now() - since.getTime()) / DAY_MS) + 1,
    };
  }
}
