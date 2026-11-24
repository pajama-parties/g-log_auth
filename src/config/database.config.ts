import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { AUTH_ENTITIES } from '../database/schema/entities/auth/index.js';
import { SERVICE_ENTITIES } from '../database/schema/entities/service/index.js';

/** Nest(ConfigService)와 TypeORM CLI(process.env) 양쪽에서 같은 설정을 쓰기 위한 읽기 함수 */
export type EnvGetter = (key: string) => string | undefined;

/** 인증 DB 연결 이름. 서비스 DB는 기본 연결('default') */
export const AUTH_CONNECTION = 'auth';

function required(get: EnvGetter, key: string): string {
  const value = get(key);
  if (value === undefined || value === '') {
    throw new Error(`환경 변수 ${key} 가 비어 있습니다. backend/.env 를 확인하세요 (.env.example 참고).`);
  }
  return value;
}

function baseOptions(get: EnvGetter) {
  return {
    type: 'mysql' as const,
    host: required(get, 'DB_HOST'),
    port: Number(required(get, 'DB_PORT')),
    username: required(get, 'DB_USER'),
    password: required(get, 'DB_PASSWORD'),
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z', // DATETIME은 모두 UTC로 저장
    supportBigNumbers: true,
    bigNumberStrings: false, // BIGINT id를 number로 받음 (AUTO_INCREMENT는 2^53을 넘지 않음)
    synchronize: false, // 테이블은 마이그레이션으로만 바꿈
    logging: get('DB_LOGGING') === 'true',
  };
}

const migrationsDir = (db: 'auth' | 'service') =>
  join(import.meta.dirname, '..', 'database', 'schema', 'migrations', db, '*.js');

export function authDbOptions(get: EnvGetter): DataSourceOptions {
  return {
    ...baseOptions(get),
    database: required(get, 'AUTH_DB_NAME'),
    entities: AUTH_ENTITIES,
    migrations: [migrationsDir('auth')],
    migrationsTableName: 'typeorm_migrations',
  };
}

export function serviceDbOptions(get: EnvGetter): DataSourceOptions {
  return {
    ...baseOptions(get),
    database: required(get, 'SERVICE_DB_NAME'),
    entities: SERVICE_ENTITIES,
    migrations: [migrationsDir('service')],
    migrationsTableName: 'typeorm_migrations',
  };
}
