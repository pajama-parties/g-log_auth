import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AUTH_CONFIG } from '../auth/auth.constants.js';
import { authConfig, type AuthConfig } from './auth.config.js';

/** AUTH_CONFIG(카카오·JWT·쿠키 설정)를 어느 모듈에서든 @Inject(AUTH_CONFIG)로 */
@Global()
@Module({
  providers: [
    {
      provide: AUTH_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): AuthConfig => authConfig((key) => config.get<string>(key)),
    },
  ],
  exports: [AUTH_CONFIG],
})
export class AuthConfigModule {}
