import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';

/**
 * 요청 횟수 제한. AppModule에서 AuthModule 다음에 import해야 함
 * (전역 가드는 import 순서대로 실행 → 로그인 가드가 먼저 req.user를 채워야 사용자별로 셈).
 * 기본: 로그인한 사용자는 사용자별, 로그인 전 요청은 IP별로 API마다 1분에 100번. 로그인·가입은 컨트롤러에서 더 낮춤
 */
@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: 100 }],
      // req.user는 로그인 가드가 채움 (공개 API면 null)
      getTracker: (req) => (req.user ? `user:${(req.user as { id: number }).id}` : `ip:${req.ip as string}`),
    }),
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class RateLimitModule {}
