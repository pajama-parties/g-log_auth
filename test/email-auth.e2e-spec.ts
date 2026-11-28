/**
 * 이메일 가입·로그인 e2e (도커 PostgreSQL 필요). 스웨거 문서가 뜨는지도 확인.
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { In, type DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { LoginHistory } from '../src/database/schema/entities/auth/login-history.entity.js';
import { User } from '../src/database/schema/entities/auth/user.entity.js';
import { UserProfile } from '../src/database/schema/entities/service/user-profile.entity.js';

function cookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const value = raw?.find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);
  return value ? value : undefined;
}

describe('이메일 가입·로그인 (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const tag = randomUUID().slice(0, 8);
  const email = `Test.${tag}@Example.com`; // 저장은 소문자로
  const password = 'garden1234';

  beforeAll(async () => {
    process.env.SIGN_IN_RATE_LIMIT = '1000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // 기본 해시 비용(~0.3초)은 테스트에 느려서 낮춤
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ logN: 10 }))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    const users = await db.getRepository(User).find({ where: { email: email.toLowerCase() }, withDeleted: true });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      await db.getRepository(UserProfile).delete({ userId: In(ids) });
      await db.getRepository(LoginHistory).delete({ userId: In(ids) });
      await db.getRepository(User).delete({ id: In(ids) });
    }
    delete process.env.SIGN_IN_RATE_LIMIT;
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('가입 입력값 검사: 400 + 어떤 항목이 틀렸는지', async () => {
    const res = await http().post('/api/auth/signup').send({ email: 'not-an-email', password: 'short', name: '' }).expect(400);
    const messages = (res.body.message as string[]).join('\n');
    expect(messages).toMatch(/email/);
    expect(messages).toMatch(/password/);
    expect(messages).toMatch(/name/);
    await http().post('/api/auth/signup').send({ email: `x${tag}@example.com`, password: 'onlyletters', name: 'a' }).expect(400);
  });

  it('가입 → 201 + 쿠키 + 바로 로그인 상태, 비밀번호는 해시로만 저장', async () => {
    const res = await http().post('/api/auth/signup').send({ email, password, name: ' 이메일 집사 ' }).expect(201);
    expect(res.body).toEqual([
      expect.objectContaining({ name: '이메일 집사', email: email.toLowerCase(), connectedAt: null, role: '식물 집사' }),
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    const access = cookie(res, 'access_token');
    expect(access).toBeDefined();
    await http().get('/api/me').set('Cookie', `access_token=${access}`).expect(200);

    const stored = await db
      .getRepository(User)
      .createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.email = :email', { email: email.toLowerCase() })
      .getOneOrFail();
    expect(stored.passwordHash).toBeTruthy();
    expect(stored.passwordHash).not.toContain(password);
  });

  it('같은 이메일(대소문자만 다름)로 다시 가입하면 409', async () => {
    await http().post('/api/auth/signup').send({ email: email.toUpperCase(), password, name: '중복' }).expect(409);
  });

  it('로그인: 맞으면 200 + 쿠키, 틀린 비밀번호와 없는 이메일은 같은 401', async () => {
    const ok = await http().post('/api/auth/login').send({ email: `  ${email.toUpperCase()} `, password }).expect(200);
    expect(ok.body[0]).toMatchObject({ name: '이메일 집사' });
    expect(cookie(ok, 'refresh_token')).toBeDefined();

    const wrong = await http().post('/api/auth/login').send({ email, password: 'wrong-pass1' }).expect(401);
    const unknown = await http().post('/api/auth/login').send({ email: `nobody.${tag}@example.com`, password }).expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);

    const failures = await db.getRepository(LoginHistory).count({ where: { method: 'EMAIL', success: false } });
    expect(failures).toBeGreaterThanOrEqual(2);
  });

  it('정지된 계정: 비밀번호가 맞을 때만 403 (틀리면 그냥 401)', async () => {
    await db.getRepository(User).update({ email: email.toLowerCase() }, { status: 'SUSPENDED' });
    try {
      await http().post('/api/auth/login').send({ email, password: 'wrong-pass1' }).expect(401);
      await http().post('/api/auth/login').send({ email, password }).expect(403);
    } finally {
      await db.getRepository(User).update({ email: email.toLowerCase() }, { status: 'ACTIVE' });
    }
  });

  it('로그인은 1분에 SIGN_IN_RATE_LIMIT번까지, 넘으면 429', async () => {
    process.env.SIGN_IN_RATE_LIMIT = '3';
    try {
      // 위 테스트들이 이미 3번 넘게 불렀으므로 바로 429
      const res = await http().post('/api/auth/login').send({ email, password });
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      process.env.SIGN_IN_RATE_LIMIT = '1000';
    }
  });

  it('스웨거 문서: /api/auth/docs-json 에 인증·계정 API가 있음', async () => {
    const res = await http().get('/api/auth/docs-json').expect(200);
    const paths = Object.keys(res.body.paths as object);
    expect(paths).toEqual(
      expect.arrayContaining(['/api/auth/signup', '/api/auth/login', '/api/auth/kakao', '/api/auth/refresh', '/api/auth/logout', '/api/me']),
    );
    // 카카오 리다이렉트 흐름은 /api 접두사 없이 문서화
    expect(paths).toEqual(expect.arrayContaining(['/auth/kakao', '/auth/kakao/callback']));
    expect(paths).not.toContain('/api/auth/kakao/callback');
    expect(Object.keys(res.body.paths['/auth/kakao/callback'].get.responses)).toEqual(expect.arrayContaining(['303', '401']));
    const signupBody = res.body.paths['/api/auth/signup'].post.requestBody;
    expect(JSON.stringify(signupBody)).toMatch(/password/);
  });
});
