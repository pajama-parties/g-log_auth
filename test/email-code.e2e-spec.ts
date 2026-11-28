/**
 * 이메일 코드 로그인 e2e (도커 PostgreSQL 필요). 메일은 InMemoryMailTransport로 받아서 코드를 꺼냄.
 */
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PasswordHasher } from '@nestjs/authentication';
import { InMemoryMailTransport, MailSmtpError, MailTransport } from '@nestjs/mail';
import { getDataSourceToken } from '@nestjs/typeorm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { In, type DataSource } from 'typeorm';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AuthToken } from '../src/database/schema/entities/auth/auth-token.entity.js';
import { LoginHistory } from '../src/database/schema/entities/auth/login-history.entity.js';
import { User } from '../src/database/schema/entities/auth/user.entity.js';
import { UserProfile } from '../src/database/schema/entities/service/user-profile.entity.js';

function cookie(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const value = raw?.find((c) => c.startsWith(`${name}=`))?.split(';')[0].slice(name.length + 1);
  return value ? value : undefined;
}

describe('이메일 코드 로그인 (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  const mailbox = new InMemoryMailTransport();
  const tag = randomUUID().slice(0, 8);
  const emails: string[] = [];
  const newEmail = () => {
    const e = `code.${tag}.${emails.length}@example.com`;
    emails.push(e);
    return e;
  };

  /** 마지막으로 이 주소에 간 메일 제목에서 6자리 코드 */
  const lastCode = (to: string): string => {
    const mail = mailbox.assertSent({ to });
    const match = /(\d{6})/.exec(mail.subject);
    if (!match) throw new Error(`코드 없음: ${mail.subject}`);
    return match[1];
  };
  /** 재요청 대기(60초)를 건너뛰려고 마지막 코드의 발급 시각을 과거로 */
  const ageCode = async (email: string) => {
    const user = await db.getRepository(User).findOneByOrFail({ email });
    await db.getRepository(AuthToken).update({ userId: user.id }, { createdAt: new Date(Date.now() - 120_000) });
  };

  beforeAll(async () => {
    process.env.SIGN_IN_RATE_LIMIT = '1000';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MailTransport)
      .useValue(mailbox)
      .overrideProvider(PasswordHasher)
      .useValue(new PasswordHasher({ logN: 10 }))
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get<DataSource>(getDataSourceToken());
  });

  afterAll(async () => {
    const users = await db.getRepository(User).find({ where: { email: In(emails) }, withDeleted: true });
    const ids = users.map((u) => u.id);
    if (ids.length > 0) {
      await db.getRepository(UserProfile).delete({ userId: In(ids) });
      await db.getRepository(LoginHistory).delete({ userId: In(ids) });
      await db.getRepository(User).delete({ id: In(ids) }); // auth_tokens는 CASCADE
    }
    delete process.env.SIGN_IN_RATE_LIMIT;
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('처음 보는 이메일: 코드 요청 → 미인증 계정 생성 → 코드 인증 → 가입·로그인', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/code').send({ email: email.toUpperCase() }).expect(204);

    const created = await db.getRepository(User).findOneByOrFail({ email });
    expect(created.emailVerified).toBe(false);
    // 프로필은 계정과 같은 트랜잭션에서 만들어짐 (service.user_profiles → auth.users FK)
    expect(await db.getRepository(UserProfile).findOneByOrFail({ userId: created.id })).toMatchObject({ nickname: "식물 집사" });
    const token = await db.getRepository(AuthToken).findOneByOrFail({ userId: created.id });
    expect(token.purpose).toBe('EMAIL_VERIFY');
    expect(token.tokenHash).not.toContain(lastCode(email)); // 원문 저장 안 함

    const res = await http().post('/api/auth/email/verify').send({ email, code: lastCode(email) }).expect(200);
    expect(res.body).toEqual([expect.objectContaining({ email, name: '식물 집사' })]);
    const access = cookie(res, 'access_token');
    expect(access).toBeDefined();
    await http().get('/api/me').set('Cookie', `access_token=${access}`).expect(200);

    const after = await db.getRepository(User).findOneByOrFail({ email });
    expect(after.emailVerified).toBe(true);
    expect(after.lastLoginAt).not.toBeNull();

    // 같은 코드 재사용 불가
    await http().post('/api/auth/email/verify').send({ email, code: lastCode(email) }).expect(401);
  });

  it('이미 있는 계정(비밀번호 가입)은 같은 계정으로 로그인', async () => {
    const email = newEmail();
    await http().post('/api/auth/signup').send({ email, password: 'garden1234', name: '기존 집사' }).expect(201);
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    const res = await http().post('/api/auth/email/verify').send({ email, code: lastCode(email) }).expect(200);
    expect(res.body[0]).toMatchObject({ email, name: '기존 집사' });
    expect(await db.getRepository(User).countBy({ email })).toBe(1);
    // 비밀번호 로그인도 그대로
    await http().post('/api/auth/login').send({ email, password: 'garden1234' }).expect(200);
  });

  it('틀린 코드는 401, 5번 틀리면 코드 폐기 → 맞는 코드도 401', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    const code = lastCode(email);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) {
      await http().post('/api/auth/email/verify').send({ email, code: wrong }).expect(401);
    }
    const fifth = await http().post('/api/auth/email/verify').send({ email, code: wrong }).expect(401);
    expect(fifth.body.message).toMatch(/다시 받아/);
    await http().post('/api/auth/email/verify').send({ email, code }).expect(401);
  });

  it('60초 안에 다시 요청하면 429, 다시 받으면 이전 코드는 무효', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    const first = lastCode(email);
    await http().post('/api/auth/email/code').send({ email }).expect(429);

    await ageCode(email);
    mailbox.clear();
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    const second = lastCode(email);
    if (first !== second) {
      await http().post('/api/auth/email/verify').send({ email, code: first }).expect(401);
    }
    await http().post('/api/auth/email/verify').send({ email, code: second }).expect(200);
  });

  it('만료된 코드는 401', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    const user = await db.getRepository(User).findOneByOrFail({ email });
    await db.getRepository(AuthToken).update({ userId: user.id }, { expiresAt: new Date(Date.now() - 1000) });
    await http().post('/api/auth/email/verify').send({ email, code: lastCode(email) }).expect(401);
  });

  it('형식 검사: 이메일·코드 6자리', async () => {
    await http().post('/api/auth/email/code').send({ email: 'not-email' }).expect(400);
    await http().post('/api/auth/email/verify').send({ email: 'a@example.com', code: '12345' }).expect(400);
    await http().post('/api/auth/email/verify').send({ email: 'a@example.com', code: 'abcdef' }).expect(400);
  });

  it('없는 이메일로 인증만 시도하면 401 (계정을 만들지 않음)', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/verify').send({ email, code: '123456' }).expect(401);
    expect(await db.getRepository(User).countBy({ email })).toBe(0);
  });

  it('메일 발송 실패면 503, 코드는 지워져 바로 다시 요청 가능', async () => {
    const email = newEmail();
    // 5xx는 영구 실패라 재시도 없이 바로 실패
    mailbox.failNext(new MailSmtpError('RCPT TO', { code: 550, text: 'User unknown' }));
    await http().post('/api/auth/email/code').send({ email }).expect(503);
    await http().post('/api/auth/email/code').send({ email }).expect(204);
  });

  it('코드만 요청하고 인증 안 한 이메일은 비밀번호 가입 가능 (선점 방지)', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    const code = lastCode(email);
    // 코드 요청 때 계정과 함께 만든 프로필(기본 닉네임)이 가입할 때 입력한 닉네임으로 바뀜
    const signup = await http().post('/api/auth/signup').send({ email, password: 'garden1234', name: '진짜 주인' }).expect(201);
    expect(signup.body[0]).toMatchObject({ name: '진짜 주인' });
    // 가입하면서 보냈던 코드는 무효
    await http().post('/api/auth/email/verify').send({ email, code }).expect(401);
    // 인증까지 끝난 계정에는 다시 가입 불가
    await http().post('/api/auth/signup').send({ email, password: 'garden1234', name: '또' }).expect(409);
  });

  it('정지된 계정은 코드가 맞아도 403', async () => {
    const email = newEmail();
    await http().post('/api/auth/email/code').send({ email }).expect(204);
    await db.getRepository(User).update({ email }, { status: 'SUSPENDED' });
    await http().post('/api/auth/email/verify').send({ email, code: lastCode(email) }).expect(403);
  });

  it('스웨거 문서에 이메일 코드 로그인 API가 있음', async () => {
    const res = await http().get('/api/auth/docs-json').expect(200);
    expect(res.body.paths['/api/auth/email/code'].post.responses).toHaveProperty('204');
    expect(res.body.paths['/api/auth/email/verify'].post.responses).toHaveProperty('200');
    expect(JSON.stringify(res.body.paths['/api/auth/email/verify'].post.requestBody)).toMatch(/code/);
  });
});
