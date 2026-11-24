// TypeORM CLI 전용 (npm run migration:*). 앱은 DatabaseModule을 사용.
import './load-env.js';
import { DataSource } from 'typeorm';
import { serviceDbOptions } from '../config/database.config.js';

export default new DataSource(serviceDbOptions((key) => process.env[key]));
