import { join } from 'node:path';
import type { DataSourceOptions } from 'typeorm';
import { ENTITIES } from '../database/schema/entities/index.js';

/** Nest(ConfigService)와 TypeORM CLI(process.env) 양쪽에서 같은 설정을 쓰기 위한 읽기 함수 */
export type EnvGetter = (key: string) => string | undefined;

function required(get: EnvGetter, key: string): string {
  const value = get(key);
  if (value === undefined || value === '') {
    throw new Error(`환경 변수 ${key} 가 비어 있습니다. backend/.env 를 확인하세요 (.env.example 참고).`);
  }
  return value;
}

/**
 * PostgreSQL DB 하나에 스키마 두 개 (auth: 계정·토큰, service: 화분·커뮤니티 등).
 * 스키마 사이에도 실제 FK가 있고, 한 연결이라 두 스키마의 변경을 트랜잭션 하나로 묶을 수 있음.
 */
export function dbOptions(get: EnvGetter): DataSourceOptions {
  return {
    type: 'postgres',
    host: required(get, 'DB_HOST'),
    port: Number(required(get, 'DB_PORT')),
    username: required(get, 'DB_USER'),
    password: required(get, 'DB_PASSWORD'),
    database: required(get, 'DB_NAME'),
    // BIGINT id를 number로 받음 (기본은 문자열. IDENTITY 값은 2^53을 넘지 않음)
    parseInt8: true,
    entities: ENTITIES,
    migrations: [join(import.meta.dirname, '..', 'database', 'schema', 'migrations', '*.js')],
    // 마이그레이션 기록은 public 스키마에 둠 (auth·service 스키마는 첫 마이그레이션이 만듦)
    migrationsTableName: 'typeorm_migrations',
    synchronize: false, // 테이블은 마이그레이션으로만 바꿈
    logging: get('DB_LOGGING') === 'true',
  };
}
