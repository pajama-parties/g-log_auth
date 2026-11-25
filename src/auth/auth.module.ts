import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthenticationModule } from '@nestjs/authentication';
import { AuthConfigModule } from '../config/auth-config.module.js';
import { authConfig } from '../config/auth.config.js';
import type { User } from '../database/schema/entities/auth/user.entity.js';
import { MeModule } from '../me/me.module.js';
import { AuthController } from './auth.controller.js';
import { DevAuthController } from './dev-auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtCookieAuth, JwtHeaderAuth } from './jwt-auth.providers.js';
import { KakaoClient } from './kakao.client.js';
import { TypeOrmRefreshTokenStore } from './typeorm-refresh-token.store.js';

// @CurrentUser(), AuthenticationContext 에서 쓰는 사용자 타입
declare module '@nestjs/authentication' {
  interface AuthenticationTypes {
    user: User;
  }
}

/**
 * 인증: 카카오 로그인 → JWT(access 15분) + refresh 토큰(14일, DB 저장, 1회용).
 * 전역 가드가 모든 API를 로그인 필요로 막고, 열어 둘 곳만 @Public().
 */
@Module({
  imports: [
    AuthConfigModule,
    AuthenticationModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const { jwt } = authConfig((key) => config.get<string>(key));
        return {
          accessToken: { key: jwt.accessSecret, ttl: jwt.accessTtl },
          // absoluteTtl: 계속 돌려 써도 이 기간이 지나면 다시 로그인
          refreshToken: { ttl: jwt.refreshTtl, absoluteTtl: '90d' },
        };
      },
    }),
    MeModule,
  ],
  controllers: [AuthController, DevAuthController],
  providers: [
    AuthService,
    KakaoClient,
    TypeOrmRefreshTokenStore,
    JwtCookieAuth,
    JwtHeaderAuth,
  ],
})
export class AuthModule {}
