import { RequestMethod, StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ACCESS_COOKIE } from './auth/auth.constants.js';

/** main.ts와 e2e 테스트가 같은 설정을 쓰도록 모아 둠 */
export function configureApp(app: INestApplication) {
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

  // API 문서: http://localhost:3000/api/docs (JSON: /api/docs-json)
  const config = new DocumentBuilder()
    .setTitle('g-log auth API')
    .setDescription(
      [
        '인증·계정 API. 코드에서 자동 생성되므로 항상 실제 동작과 같습니다.',
        '',
        '- 로그인하면 `access_token`(15분), `refresh_token`(14일) HttpOnly 쿠키가 설정됩니다. 프런트는 `credentials: "include"`만 쓰면 됩니다.',
        '- API가 401이면 `POST /api/auth/refresh` → 원래 요청 재시도 → 또 401이면 로그인 화면.',
        '- 조회 응답은 한 건이어도 배열입니다.',
        '- 이 페이지에서 시험하려면 먼저 `POST /api/auth/login`(또는 signup)을 실행하세요. 같은 주소라 쿠키가 자동으로 붙습니다.',
      ].join('\n'),
    )
    .setVersion('0.2.0')
    .addCookieAuth(ACCESS_COOKIE)
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));
}
