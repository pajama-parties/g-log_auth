import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryFailedError } from 'typeorm';
import { AUTH_CONNECTION } from '../config/database.config.js';
import { LoginHistory } from '../database/schema/entities/auth/login-history.entity.js';
import { OAuthAccount } from '../database/schema/entities/auth/oauth-account.entity.js';
import { User } from '../database/schema/entities/auth/user.entity.js';
import { UserProfile } from '../database/schema/entities/service/user-profile.entity.js';
import { KakaoClient, type KakaoProfile } from './kakao.client.js';

const DEFAULT_NICKNAME = '식물 집사';
const NICKNAME_MAX = 30;

function isDuplicateKey(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY';
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDataSource(AUTH_CONNECTION) private readonly authDb: DataSource,
    @InjectDataSource() private readonly serviceDb: DataSource,
    private readonly kakao: KakaoClient,
  ) {}

  /** 로그인 유지 중인 사용자. 정지·탈퇴했으면 null (→ 401) */
  findActiveUser(id: number): Promise<User | null> {
    if (!Number.isSafeInteger(id)) return Promise.resolve(null);
    return this.authDb.getRepository(User).findOne({ where: { id, status: 'ACTIVE' } });
  }

  /** 카카오 인가 코드로 로그인. 처음이면 회원가입까지 */
  async loginWithKakao(code: string, ip: string | undefined): Promise<User> {
    let profile: KakaoProfile;
    try {
      profile = await this.kakao.profileFromCode(code);
    } catch (err) {
      await this.recordLogin(null, false, ip);
      throw err;
    }

    const user = await this.findOrCreateKakaoUser(profile);
    if (user.status !== 'ACTIVE') {
      await this.recordLogin(user.id, false, ip);
      throw new ForbiddenException('이용이 정지된 계정입니다.');
    }

    await this.ensureProfile(user.id, profile.nickname);
    await this.authDb.getRepository(User).update({ id: user.id }, { lastLoginAt: new Date() });
    await this.recordLogin(user.id, true, ip);
    return user;
  }

  private async findOrCreateKakaoUser(profile: KakaoProfile): Promise<User> {
    const existing = await this.findByKakaoId(profile.id);
    if (existing) return existing;

    try {
      return await this.authDb.transaction(async (em) => {
        const user = await em.save(em.create(User, { email: null, role: 'USER', status: 'ACTIVE' }));
        await em.insert(OAuthAccount, {
          userId: user.id,
          provider: 'KAKAO',
          providerUserId: profile.id,
          providerEmail: profile.email,
        });
        return user;
      });
    } catch (err) {
      // 같은 사람이 동시에 두 번 로그인 → 먼저 끝난 쪽이 만든 계정을 사용
      if (isDuplicateKey(err)) {
        const created = await this.findByKakaoId(profile.id);
        if (created) return created;
      }
      throw err;
    }
  }

  /** (KAKAO, 회원번호)로 계정 찾기. 연결은 있는데 회원이 탈퇴(소프트 삭제)했다면 연결을 지우고 새로 가입시킴 */
  private async findByKakaoId(kakaoId: string): Promise<User | null> {
    const link = await this.authDb
      .getRepository(OAuthAccount)
      .findOne({ where: { provider: 'KAKAO', providerUserId: kakaoId } });
    if (!link) return null;
    const user = await this.authDb.getRepository(User).findOne({ where: { id: link.userId } });
    if (user) return user;
    await this.authDb.getRepository(OAuthAccount).delete({ id: link.id });
    return null;
  }

  /**
   * service_db.user_profiles 행 보장. auth_db와 다른 DB라 트랜잭션을 함께 못 묶으므로
   * 로그인할 때마다 "없으면 만들기"로 맞춤 (가입 도중 끊겨도 다음 로그인에 복구됨)
   */
  private async ensureProfile(userId: number, nickname: string | null) {
    const name = (nickname?.trim() || DEFAULT_NICKNAME).slice(0, NICKNAME_MAX);
    await this.serviceDb
      .createQueryBuilder()
      .insert()
      .into(UserProfile)
      .values({ userId, nickname: name })
      .orIgnore()
      .execute();
  }

  private async recordLogin(userId: number | null, success: boolean, ip: string | undefined) {
    try {
      await this.authDb.getRepository(LoginHistory).insert({ userId, method: 'KAKAO', success, ipAddress: ip?.slice(0, 45) ?? null });
    } catch (err) {
      // 기록 실패로 로그인이 막히면 안 됨
      this.logger.error('login_history 저장 실패', err instanceof Error ? err.stack : String(err));
    }
  }
}
