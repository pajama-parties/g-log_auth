import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { AuthenticationStorage, type RefreshTokenRecord, type RefreshTokenStore } from '@nestjs/authentication';
import { DataSource, IsNull, LessThan } from 'typeorm';
import { AUTH_CONNECTION } from '../config/database.config.js';
import { RefreshTokenFamily } from '../database/schema/entities/auth/refresh-token-family.entity.js';
import { RefreshToken } from '../database/schema/entities/auth/refresh-token.entity.js';

/**
 * @nestjs/authentication 의 refresh 토큰 저장소를 auth_db 에 둔다.
 * (기본값은 메모리라서 서버를 재시작하면 모두 로그아웃되고, 운영 모드에서는 시작 자체가 거부됨)
 */
@Injectable()
export class TypeOrmRefreshTokenStore implements RefreshTokenStore {
  constructor(
    @InjectDataSource(AUTH_CONNECTION) private readonly db: DataSource,
    storage: AuthenticationStorage,
  ) {
    storage.registerSource({ refreshTokens: this });
  }

  private get tokens() {
    return this.db.getRepository(RefreshToken);
  }

  private get families() {
    return this.db.getRepository(RefreshTokenFamily);
  }

  async getRefreshToken(id: string): Promise<RefreshTokenRecord | undefined> {
    const row = await this.tokens.findOne({ where: { id }, relations: { family: true } });
    if (!row) return undefined;
    return {
      id: row.id,
      familyId: row.familyId,
      userId: String(row.userId),
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      familyExpiresAt: row.family.expiresAt,
      // 선택 필드는 null 이 아니라 undefined 로 돌려줘야 함 (스토어 계약)
      ...(row.usedAt ? { usedAt: row.usedAt } : {}),
      ...(row.claims ? { claims: row.claims } : {}),
    };
  }

  async saveRefreshToken(record: RefreshTokenRecord): Promise<void> {
    const userId = Number(record.userId);
    await this.db.transaction(async (em) => {
      // 패밀리는 로그인 때 처음 생기고, 돌려 쓸 때는 이미 있음 → 없을 때만 넣기
      await em
        .createQueryBuilder()
        .insert()
        .into(RefreshTokenFamily)
        .values({ id: record.familyId, userId, expiresAt: record.familyExpiresAt, revokedAt: null })
        .orIgnore()
        .execute();
      await em.insert(RefreshToken, {
        id: record.id,
        familyId: record.familyId,
        userId,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        usedAt: null,
        // json 컬럼: TypeORM의 insert 타입이 Record<string, unknown>을 못 받아서 캐스팅
        claims: (record.claims ?? null) as never,
      });
    });
    // 수명이 끝난 패밀리 정리 (토큰은 FK CASCADE로 함께 삭제). 시각은 TokenService의 시계를 따름
    await this.families.delete({ expiresAt: LessThan(record.createdAt) });
  }

  async markRefreshTokenUsed(id: string, at: Date): Promise<boolean> {
    // 읽고-쓰기가 아니라 조건부 UPDATE 한 번: 동시에 두 번 오면 하나만 성공 → 나머지는 재사용(탈취)으로 처리됨
    const result = await this.tokens.update({ id, usedAt: IsNull() }, { usedAt: at });
    return result.affected === 1;
  }

  async revokeRefreshTokenFamily(familyId: string): Promise<void> {
    await this.families.update({ id: familyId, revokedAt: IsNull() }, { revokedAt: new Date() });
  }

  async isRefreshTokenFamilyRevoked(familyId: string): Promise<boolean> {
    const family = await this.families.findOne({ where: { id: familyId }, select: { id: true, revokedAt: true } });
    // 패밀리가 없으면(만료 정리됨) 쓸 수 없는 것으로 봄
    return !family || family.revokedAt !== null;
  }

  async revokeUserRefreshTokens(userId: string): Promise<void> {
    await this.families.update({ userId: Number(userId), revokedAt: IsNull() }, { revokedAt: new Date() });
  }
}
