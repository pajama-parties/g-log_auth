import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { Mailer } from '@nestjs/mail';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager, IsNull, MoreThanOrEqual, QueryFailedError } from 'typeorm';
import { AuthToken } from '../database/schema/entities/auth/auth-token.entity.js';
import { LoginHistory } from '../database/schema/entities/auth/login-history.entity.js';
import { OAuthAccount } from '../database/schema/entities/auth/oauth-account.entity.js';
import { User } from '../database/schema/entities/auth/user.entity.js';
import { UserProfile } from '../database/schema/entities/service/user-profile.entity.js';
import type { LoginMethod } from '../database/schema/enums.js';
import type { EmailCodeVerifyInput, LoginInput, SignupInput } from './auth.schemas.js';
import { emailCodeMail } from './email-code.mail.js';
import { KakaoClient, type KakaoProfile } from './kakao.client.js';

const DEFAULT_NICKNAME = '식물 집사';
const NICKNAME_MAX = 30;

/** 이메일 로그인 코드: 6자리 숫자, 10분, 코드 하나당 5번까지 틀릴 수 있음, 다시 받기는 60초 뒤부터 */
export const EMAIL_CODE_TTL_MINUTES = 10;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_SECONDS = 60;
const INVALID_CODE = '인증 코드가 올바르지 않거나 만료되었습니다.';

/** 사용자별로 다르게 해시 → 같은 코드가 동시에 여러 명에게 발급돼도 token_hash(UNIQUE)가 겹치지 않음 */
function hashEmailCode(userId: number, code: string): string {
  return createHash('sha256').update(`${userId}:${code}`).digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** PostgreSQL unique_violation */
function isDuplicateKey(err: unknown): boolean {
  return err instanceof QueryFailedError && (err.driverError as { code?: string } | undefined)?.code === '23505';
}

function nicknameOf(nickname: string | null | undefined): string {
  return (nickname?.trim() || DEFAULT_NICKNAME).slice(0, NICKNAME_MAX);
}

/** 계정과 같은 트랜잭션에서 프로필을 만듦 (service.user_profiles.user_id → auth.users FK) */
async function createUserWithProfile(em: EntityManager, fields: Partial<User>, nickname: string | null): Promise<User> {
  const user = await em.save(em.create(User, { role: 'USER', status: 'ACTIVE', ...fields }));
  await em.insert(UserProfile, { userId: user.id, nickname: nicknameOf(nickname) });
  return user;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly kakao: KakaoClient,
    private readonly passwordHasher: PasswordHasher,
    private readonly mailer: Mailer,
  ) {}

  /** 로그인 유지 중인 사용자. 정지·탈퇴했으면 null (→ 401) */
  findActiveUser(id: number): Promise<User | null> {
    if (!Number.isSafeInteger(id)) return Promise.resolve(null);
    return this.db.getRepository(User).findOne({ where: { id, status: 'ACTIVE' } });
  }

  /** 카카오 인가 코드로 로그인. 처음이면 회원가입까지 */
  async loginWithKakao(code: string, ip: string | undefined): Promise<User> {
    let profile: KakaoProfile;
    try {
      profile = await this.kakao.profileFromCode(code);
    } catch (err) {
      await this.recordLogin('KAKAO', null, false, ip);
      throw err;
    }

    const user = await this.findOrCreateKakaoUser(profile);
    if (user.status !== 'ACTIVE') {
      await this.recordLogin('KAKAO', user.id, false, ip);
      throw new ForbiddenException('이용이 정지된 계정입니다.');
    }

    await this.db.getRepository(User).update({ id: user.id }, { lastLoginAt: new Date() });
    await this.recordLogin('KAKAO', user.id, true, ip);
    return user;
  }

  /** 이메일 가입. 이미 있는 이메일이면 409. 성공하면 바로 로그인 처리(토큰 발급은 컨트롤러) */
  async signupWithEmail(input: SignupInput, ip: string | undefined): Promise<User> {
    const passwordHash = await this.passwordHasher.hash(input.password);
    let user: User;
    try {
      // 먼저 조회하고 넣으면 동시 가입 때 둘 다 통과하므로, 넣어 보고 UNIQUE 위반을 409로 바꿈
      user = await this.db.transaction((em) =>
        createUserWithProfile(
          em,
          { email: input.email, passwordHash, passwordChangedAt: new Date(), lastLoginAt: new Date() },
          input.name,
        ),
      );
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // 코드만 요청하고 인증하지 않은 계정(비밀번호 없음·미인증)은 이 가입으로 가져감 → 코드 요청만으로 남의 이메일을 선점하지 못함
      const claimed = await this.claimUnverifiedEmail(input.email, passwordHash, input.name);
      if (!claimed) throw new ConflictException('이미 가입된 이메일입니다.');
      user = claimed;
    }
    await this.recordLogin('EMAIL', user.id, true, ip);
    // 해시가 응답·로그로 새지 않게 떼고 돌려줌
    const { passwordHash: _hash, ...rest } = user;
    return rest as User;
  }

  /**
   * 이메일 로그인. 없는 이메일과 틀린 비밀번호는 같은 401·같은 문구.
   * 없는 이메일이어도 verify()가 가짜 해시를 검사하므로 응답 시간으로 가입 여부를 알 수 없음.
   */
  async loginWithEmail(input: LoginInput, ip: string | undefined): Promise<User> {
    const found = await this.db
      .getRepository(User)
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: input.email })
      .getOne();

    const valid = await this.passwordHasher.verify(input.password, found?.passwordHash);
    if (!found || !valid) {
      await this.recordLogin('EMAIL', found?.id ?? null, false, ip);
      throw new UnauthorizedException('이메일 또는 비밀번호가 올바르지 않습니다.');
    }
    // 비밀번호가 맞은 뒤에만 정지 여부를 알려 줌
    if (found.status !== 'ACTIVE') {
      await this.recordLogin('EMAIL', found.id, false, ip);
      throw new ForbiddenException('이용이 정지된 계정입니다.');
    }

    const changes: Partial<User> = { lastLoginAt: new Date() };
    if (found.passwordHash && this.passwordHasher.needsRehash(found.passwordHash)) {
      changes.passwordHash = await this.passwordHasher.hash(input.password);
    }
    await this.db.getRepository(User).update({ id: found.id }, changes);
    await this.recordLogin('EMAIL', found.id, true, ip);
    const { passwordHash: _hash, ...user } = found;
    return user as User;
  }

  /**
   * 이메일 로그인 1단계: 6자리 코드를 메일로 보냄. 처음 보는 이메일이면 계정(email_verified=0)을 먼저 만듦.
   * 코드는 auth_tokens(EMAIL_VERIFY)에 해시로 저장하고, 새로 받으면 이전 코드는 못 씀.
   */
  async requestEmailCode(email: string): Promise<void> {
    const user = await this.findOrCreateEmailUser(email);
    const tokens = this.db.getRepository(AuthToken);

    const last = await tokens.findOne({ where: { userId: user.id, purpose: 'EMAIL_VERIFY' }, order: { createdAt: 'DESC' } });
    if (last && !last.usedAt && Date.now() - last.createdAt.getTime() < EMAIL_CODE_RESEND_SECONDS * 1000) {
      throw new HttpException(`인증 코드는 ${EMAIL_CODE_RESEND_SECONDS}초 뒤에 다시 받을 수 있습니다.`, HttpStatus.TOO_MANY_REQUESTS);
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await this.db.transaction(async (em) => {
        await em.delete(AuthToken, { userId: user.id, purpose: 'EMAIL_VERIFY' });
        await em.insert(AuthToken, {
          userId: user.id,
          purpose: 'EMAIL_VERIFY',
          tokenHash: hashEmailCode(user.id, code),
          expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_MINUTES * 60_000),
        });
      });
    } catch (err) {
      // 같은 이메일로 거의 동시에 두 번 요청
      if (isDuplicateKey(err)) throw new HttpException('잠시 후 다시 시도해 주세요.', HttpStatus.TOO_MANY_REQUESTS);
      throw err;
    }

    try {
      await this.mailer.send(emailCodeMail(email, code, EMAIL_CODE_TTL_MINUTES));
    } catch (err) {
      // 못 보낸 코드는 지워서 바로 다시 요청할 수 있게
      await tokens.delete({ userId: user.id, purpose: 'EMAIL_VERIFY' });
      this.logger.error('인증 코드 메일 발송 실패', err instanceof Error ? err.stack : String(err));
      throw new ServiceUnavailableException('메일을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  /** 이메일 로그인 2단계: 코드가 맞으면 email_verified=1 로 바꾸고 로그인 */
  async verifyEmailCode(input: EmailCodeVerifyInput, ip: string | undefined): Promise<User> {
    const user = await this.db.getRepository(User).findOne({ where: { email: input.email } });
    const tokens = this.db.getRepository(AuthToken);
    const token = user
      ? await tokens.findOne({ where: { userId: user.id, purpose: 'EMAIL_VERIFY', usedAt: IsNull() } })
      : null;
    if (!user || !token || token.expiresAt.getTime() <= Date.now()) {
      await this.recordLogin('EMAIL', user?.id ?? null, false, ip);
      throw new UnauthorizedException(INVALID_CODE);
    }

    if (!sameHash(token.tokenHash, hashEmailCode(user.id, input.code))) {
      await this.recordLogin('EMAIL', user.id, false, ip);
      // 무작위 대입 방지: 이 코드를 받은 뒤 실패가 5번이면 코드 폐기
      const failures = await this.db.getRepository(LoginHistory).count({
        where: { userId: user.id, method: 'EMAIL', success: false, createdAt: MoreThanOrEqual(token.createdAt) },
      });
      if (failures >= EMAIL_CODE_MAX_ATTEMPTS) {
        await tokens.delete({ id: token.id });
        throw new UnauthorizedException('인증 코드를 여러 번 틀렸습니다. 코드를 다시 받아 주세요.');
      }
      throw new UnauthorizedException(INVALID_CODE);
    }

    // 같은 코드로 동시에 두 번 와도 한 번만 성공
    const used = await tokens.update({ id: token.id, usedAt: IsNull() }, { usedAt: new Date() });
    if (used.affected !== 1) {
      await this.recordLogin('EMAIL', user.id, false, ip);
      throw new UnauthorizedException(INVALID_CODE);
    }
    // 코드가 맞은 뒤에만 정지 여부를 알려 줌
    if (user.status !== 'ACTIVE') {
      await this.recordLogin('EMAIL', user.id, false, ip);
      throw new ForbiddenException('이용이 정지된 계정입니다.');
    }

    await this.db.getRepository(User).update({ id: user.id }, { emailVerified: true, lastLoginAt: new Date() });
    await this.recordLogin('EMAIL', user.id, true, ip);
    user.emailVerified = true;
    return user;
  }

  private async findOrCreateEmailUser(email: string): Promise<User> {
    const users = this.db.getRepository(User);
    const existing = await users.findOne({ where: { email } });
    if (existing) return existing;
    try {
      return await this.db.transaction((em) => createUserWithProfile(em, { email, emailVerified: false }, null));
    } catch (err) {
      // 동시에 두 번 요청 → 먼저 만든 계정 사용
      if (isDuplicateKey(err)) {
        const created = await users.findOne({ where: { email } });
        if (created) return created;
      }
      throw err;
    }
  }

  /**
   * 미인증·비밀번호 없는 계정에 비밀번호를 붙여 가입 처리. 조건은 UPDATE 한 번으로 확인 (동시 요청 대비).
   * 코드 요청 때 기본 닉네임으로 만든 프로필은 가입할 때 입력한 닉네임으로 바꿈
   */
  private async claimUnverifiedEmail(email: string, passwordHash: string, nickname: string): Promise<User | null> {
    return this.db.transaction(async (em) => {
      const result = await em
        .createQueryBuilder()
        .update(User)
        .set({ passwordHash, passwordChangedAt: new Date(), lastLoginAt: new Date() })
        .where('email = :email AND email_verified = false AND password_hash IS NULL AND deleted_at IS NULL', { email })
        .execute();
      if (result.affected !== 1) return null;
      const user = await em.findOneOrFail(User, { where: { email } });
      await em.update(UserProfile, { userId: user.id }, { nickname: nicknameOf(nickname) });
      // 코드 로그인용으로 보냈던 코드는 무효화
      await em.delete(AuthToken, { userId: user.id, purpose: 'EMAIL_VERIFY' });
      return user;
    });
  }

  private async findOrCreateKakaoUser(profile: KakaoProfile): Promise<User> {
    const existing = await this.findByKakaoId(profile.id);
    if (existing) return existing;

    try {
      return await this.db.transaction(async (em) => {
        const user = await createUserWithProfile(em, { email: null }, profile.nickname);
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
    const link = await this.db
      .getRepository(OAuthAccount)
      .findOne({ where: { provider: 'KAKAO', providerUserId: kakaoId } });
    if (!link) return null;
    const user = await this.db.getRepository(User).findOne({ where: { id: link.userId } });
    if (user) return user;
    await this.db.getRepository(OAuthAccount).delete({ id: link.id });
    return null;
  }


  private async recordLogin(method: LoginMethod, userId: number | null, success: boolean, ip: string | undefined) {
    try {
      await this.db.getRepository(LoginHistory).insert({ userId, method, success, ipAddress: ip?.slice(0, 45) ?? null });
    } catch (err) {
      // 기록 실패로 로그인이 막히면 안 됨
      this.logger.error('login_history 저장 실패', err instanceof Error ? err.stack : String(err));
    }
  }
}
