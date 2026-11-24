/**
 * 인증 e2e: 도커 MySQL(npm run db:up + migration:run)이 켜져 있어야 함.
 * 카카오 서버 대신 KakaoClient를 가짜로 바꿔서, 가입·로그인·쿠키·refresh 회전·재사용 감지·로그아웃을 확인.
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { KakaoClient, type KakaoProfile } from '../src/auth/kakao.client.js';
import { AUTH_CONNECTION } from '../src/config/database.config.js';
import { OAuthAccount } from '../src/database/schema/entities/auth/oauth-account.entity.js';
import { User } from '../src/database/schema/entities/auth/user.entity.js';
import { UserProfile } from '../src/database/schema/entities/service/user-profile.entity.js';

/** set-cookie 헤더에서 이름=값 꺼내기 */
function cookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const line = raw?.find((c) => c.startsWith(`${name}=`));
  const value = line?.split(';')[0].slice(name.length + 1);
  return value ? value : undefined;
}

describe('인증 (e2e)', () => {
  let app: INestApplication<App>;
  let authDb: DataSource;
  let serviceDb: DataSource;
  const kakaoId = `test-${randomUUID()}`;
  let profile: KakaoProfile = { id: kakaoId, nickname: '테스트 집사', email: null, profileImageUrl: null };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(KakaoClient)
      .useValue({
        profileFromCode: async (code: string) => {
          if (code !== 'good-code') throw new UnauthorizedException();
          return profile;
        },
        authorizeUrl: () => 'https://kauth.kakao.com/oauth/authorize',
      })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    authDb = app.get<DataSource>(getDataSourceToken(AUTH_CONNECTION));
    serviceDb = app.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    const link = await authDb.getRepository(OAuthAccount).findOne({ where: { provider: 'KAKAO', providerUserId: kakaoId } });
    if (link) {
      await serviceDb.getRepository(UserProfile).delete({ userId: link.userId });
      // users 삭제 → oauth_accounts, refresh 토큰, login_history(SET NULL)가 FK로 정리됨
      await authDb.getRepository(User).delete({ id: link.userId });
    }
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('로그인 없이 /api/me 는 401', async () => {
    await http().get('/api/me').expect(401);
  });

  it('잘못된 인가 코드는 401, 코드 없으면 400', async () => {
    await http().post('/api/auth/kakao').send({ code: 'bad' }).expect(401);
    await http().post('/api/auth/kakao').send({}).expect(400);
  });

  it('첫 로그인: 가입 + 쿠키 발급, 두 번째 로그인은 같은 계정', async () => {
    const first = await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    expect(first.body).toEqual([expect.objectContaining({ name: '테스트 집사', role: '식물 집사', potCount: 0 })]);
    expect(cookie(first, 'access_token')).toBeDefined();
    expect(cookie(first, 'refresh_token')).toBeDefined();
    const setCookies = (first.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(setCookies).toMatch(/access_token=[^;]+;.*HttpOnly/);
    expect(setCookies).toMatch(/refresh_token=[^;]+;.*Path=\/api\/auth/);

    profile = { ...profile, nickname: '바뀐 닉네임' }; // 카카오 닉네임이 바뀌어도 우리 닉네임은 유지
    await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    const links = await authDb.getRepository(OAuthAccount).count({ where: { provider: 'KAKAO', providerUserId: kakaoId } });
    expect(links).toBe(1);
    const me = await http().get('/api/me').set('Cookie', `access_token=${cookie(first, 'access_token')}`).expect(200);
    expect(me.body[0].name).toBe('테스트 집사');
  });

  it('access 토큰: 쿠키와 Bearer 헤더 둘 다 됨', async () => {
    const login = await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    const access = cookie(login, 'access_token')!;
    await http().get('/api/me').set('Cookie', `access_token=${access}`).expect(200);
    await http().get('/api/me').set('Authorization', `Bearer ${access}`).expect(200);
    await http().get('/api/me').set('Cookie', `access_token=${access}x`).expect(401);
  });

  it('refresh: 새 토큰으로 바뀌고, 쓴 토큰을 또 쓰면 그 로그인 전체가 끊김', async () => {
    const login = await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    const r1 = cookie(login, 'refresh_token')!;

    const rotated = await http().post('/api/auth/refresh').set('Cookie', `refresh_token=${r1}`).expect(204);
    const r2 = cookie(rotated, 'refresh_token')!;
    const a2 = cookie(rotated, 'access_token')!;
    expect(r2).not.toBe(r1);
    await http().get('/api/me').set('Cookie', `access_token=${a2}`).expect(200);

    // r1 재사용 → 탈취로 보고 패밀리 전체 폐기 → r2도 못 씀
    await http().post('/api/auth/refresh').set('Cookie', `refresh_token=${r1}`).expect(401);
    await http().post('/api/auth/refresh').set('Cookie', `refresh_token=${r2}`).expect(401);
  });

  it('로그아웃하면 그 refresh 토큰은 더 못 씀 (다른 기기 로그인은 유지)', async () => {
    const deviceA = await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    const deviceB = await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    const ra = cookie(deviceA, 'refresh_token')!;
    const rb = cookie(deviceB, 'refresh_token')!;

    const out = await http().post('/api/auth/logout').set('Cookie', `refresh_token=${ra}`).expect(204);
    expect((out.headers['set-cookie'] as unknown as string[]).join('\n')).toMatch(/access_token=;/);
    await http().post('/api/auth/refresh').set('Cookie', `refresh_token=${ra}`).expect(401);
    await http().post('/api/auth/refresh').set('Cookie', `refresh_token=${rb}`).expect(204);
  });

  it('정지된 계정은 갖고 있던 access 토큰으로도 401, 다시 로그인하면 403', async () => {
    const login = await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(200);
    const access = cookie(login, 'access_token')!;
    const link = await authDb.getRepository(OAuthAccount).findOneOrFail({ where: { provider: 'KAKAO', providerUserId: kakaoId } });

    await authDb.getRepository(User).update({ id: link.userId }, { status: 'SUSPENDED' });
    try {
      await http().get('/api/me').set('Cookie', `access_token=${access}`).expect(401);
      await http().post('/api/auth/kakao').send({ code: 'good-code' }).expect(403);
    } finally {
      await authDb.getRepository(User).update({ id: link.userId }, { status: 'ACTIVE' });
    }
  });
});
