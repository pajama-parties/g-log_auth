import { RequestMethod, type INestApplication } from '@nestjs/common';

/** main.ts와 e2e 테스트가 같은 설정을 쓰도록 모아 둠 */
export function configureApp(app: INestApplication) {
  // 스웨거 servers: /api. 카카오 콘솔에 등록한 Redirect URI(/auth/kakao/callback)와 개발용 시작 주소만 접두사 없이 둠
  app.setGlobalPrefix('api', {
    exclude: [
      { path: 'auth/kakao', method: RequestMethod.GET },
      { path: 'auth/kakao/callback', method: RequestMethod.GET },
    ],
  });
}
