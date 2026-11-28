import { RequestMethod, StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ACCESS_COOKIE } from './auth/auth.constants.js';

/** main.ts와 e2e 테스트가 같은 설정을 쓰도록 모아 둠 */
export function configureApp(app: INestApplication) {
  // nginx 등 프록시 뒤에서 실행할 때 X-Forwarded-For의 실제 클라이언트 IP를 req.ip로 씀 (로그인 횟수 제한·로그인 기록).
  // 값은 Express 'trust proxy' 형식 (예: loopback, uniquelocal). 비우면 프록시를 믿지 않음
  const trustProxy = app.get(ConfigService).get<string>('TRUST_PROXY');
  if (trustProxy) app.getHttpAdapter().getInstance().set('trust proxy', trustProxy);

  // 스웨거 servers: /api. 카카오 콘솔에 등록한 Redirect URI(/auth/kakao/callback)와 개발용 시작 주소만 접두사 없이 둠
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'auth/kakao', method: RequestMethod.GET },
      { path: 'auth/kakao/callback', method: RequestMethod.GET },
      { path: 'auth/dev', method: RequestMethod.GET },
    ],
  });
  // @Body({ schema: zod스키마 }) 검사. 실패하면 400 + message 배열 ("email: 이메일 형식이 올바르지 않습니다.")
  app.useGlobalPipes(new StandardSchemaValidationPipe());

  // API 문서: http://localhost:3000/api/auth/docs (JSON: /api/auth/docs-json)
  // 서비스 API의 /api/docs와 겹치지 않게 /api/auth 아래에 둠 → nginx 한 주소 뒤에서 두 문서를 함께 열 수 있음
  const config = new DocumentBuilder()
    .setTitle('g-log auth API')
    .setDescription(
      [
        '인증·계정 API. 코드에서 자동 생성되므로 항상 실제 동작과 같습니다.',
        '',
        '- 로그인하면 `access_token`(15분), `refresh_token`(14일) HttpOnly 쿠키가 설정됩니다. 프런트는 `credentials: "include"`만 쓰면 됩니다.',
        '- API가 401이면 `POST /api/auth/refresh` → 원래 요청 재시도 → 또 401이면 로그인 화면.',
        '- 조회 응답은 한 건이어도 배열입니다.',
        '- 이메일 코드 로그인: `POST /api/auth/email/code`(코드 메일 발송) → `POST /api/auth/email/verify`(코드 입력 → 로그인, 처음이면 가입).',
        '- 카카오 로그인: 서버가 처리하는 방식은 브라우저를 `/auth/kakao`로 이동(콜백 후 `/api/me`로 돌아옴), 프런트가 인가 코드를 받는 방식은 `POST /api/auth/kakao`.',
        '- 이 페이지에서 시험하려면 먼저 `POST /api/auth/login`(또는 signup)을 실행하세요. 같은 주소라 쿠키가 자동으로 붙습니다.',
      ].join('\n'),
    )
    .setVersion('0.3.0')
    .addCookieAuth(ACCESS_COOKIE)
    .build();
  SwaggerModule.setup('api/auth/docs', app, () => SwaggerModule.createDocument(app, config));
}
