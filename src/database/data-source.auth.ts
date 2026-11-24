// TypeORM CLI 전용 (npm run migration:*). 앱은 DatabaseModule을 사용.
import './load-env.js';
import { DataSource } from 'typeorm';
import { authDbOptions } from '../config/database.config.js';

export default new DataSource(authDbOptions((key) => process.env[key]));
