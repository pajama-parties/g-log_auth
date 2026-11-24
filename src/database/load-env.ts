import { existsSync } from 'node:fs';

/** TypeORM CLI는 Nest를 거치지 않으므로 .env를 직접 읽음 (이미 설정된 환경 변수가 우선) */
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
