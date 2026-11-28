import { Injectable } from '@nestjs/common';
import { TokenService } from '@nestjs/authentication';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, IsNull, MoreThan, Not } from 'typeorm';
import { OAuthAccount } from '../database/schema/entities/auth/oauth-account.entity.js';
import { User } from '../database/schema/entities/auth/user.entity.js';
import { Device } from '../database/schema/entities/service/device.entity.js';
import { Notification } from '../database/schema/entities/service/notification.entity.js';
import { Plant } from '../database/schema/entities/service/plant.entity.js';
import { UserProfile } from '../database/schema/entities/service/user-profile.entity.js';
import type { UserRole } from '../database/schema/enums.js';
import type { MeResponse, UpdateMeInput } from './me.schemas.js';

const ROLE_LABELS: Record<UserRole, string> = { USER: '식물 집사', ADMIN: '관리자' };
/** 2시간 넘게 값이 없으면 오프라인 (devices.last_seen_at 기준) */
const OFFLINE_AFTER_MS = 2 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 탈퇴한 회원이 남긴 글·댓글에 보이는 이름 */
const WITHDRAWN_NICKNAME = '탈퇴한 사용자';


/** '10월 30일' (한국 시간) */
function koreanMonthDay(date: Date): string {
  const kst = new Date(date.getTime() + 9 * 60 * 60 * 1000);
  return `${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일`;
}

@Injectable()
export class MeService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly tokens: TokenService,
  ) {}

  /** 닉네임·카카오톡 메시지 동의 변경 */
  async updateMe(user: User, input: UpdateMeInput): Promise<MeResponse> {
    const changes: Partial<UserProfile> = {};
    if (input.name !== undefined) changes.nickname = input.name;
    if (input.kakaoConsent !== undefined) {
      changes.kakaoConsent = input.kakaoConsent;
      changes.kakaoConsentAt = input.kakaoConsent ? new Date() : null;
    }
    if (Object.keys(changes).length > 0) {
      await this.db.getRepository(UserProfile).update({ userId: user.id }, changes);
    }
    return this.getMe(user);
  }

  /**
   * 탈퇴. 계정과 서비스 데이터를 트랜잭션 하나로 정리함 (중간에 실패하면 전부 되돌림).
   * auth: 계정을 WITHDRAWN + 소프트 삭제, 이메일·비밀번호 비움, 카카오 연결 삭제(다시 로그인하면 새 계정).
   * service: 프로필 익명화(글·댓글은 '탈퇴한 사용자'로 남음), 화분·알림 소프트 삭제, 센서는 연결 해제(다른 사람이 다시 등록 가능).
   * refresh 토큰 폐기는 커밋한 뒤에 함 (TokenService가 자기 연결로 저장소를 씀).
   */
  async withdraw(user: User): Promise<void> {
    await this.db.transaction(async (em) => {
      await em.update(User, { id: user.id }, { status: 'WITHDRAWN', email: null, passwordHash: null });
      await em.softDelete(User, { id: user.id });
      await em.delete(OAuthAccount, { userId: user.id });
      await em.update(UserProfile, { userId: user.id }, {
        nickname: WITHDRAWN_NICKNAME,
        kakaoConsent: false,
        kakaoConsentAt: null,
        notifyDry: false,
        notifyWet: false,
        notifyOffline: false,
        notifyAdvice: false,
      });
      await em.softDelete(Plant, { userId: user.id });
      await em.softDelete(Notification, { userId: user.id });
      await em.update(Device, { userId: user.id }, { userId: null, plantId: null });
    });
    await this.tokens.revokeAll(String(user.id));
  }

  async getMe(user: User): Promise<MeResponse> {
    const [profile, kakao, potCount, sensorTotal, sensorOnline] = await Promise.all([
      this.db.getRepository(UserProfile).findOne({ where: { userId: user.id } }),
      this.db.getRepository(OAuthAccount).findOne({ where: { userId: user.id, provider: 'KAKAO' } }),
      this.db.getRepository(Plant).count({ where: { userId: user.id } }),
      this.db.getRepository(Device).count({ where: { userId: user.id, plantId: Not(IsNull()) } }),
      this.db.getRepository(Device).count({
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
