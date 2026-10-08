import 'dotenv/config';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from './database.config';

// Used by the TypeORM CLI (migration:generate / run / revert).
export default new DataSource(buildDataSourceOptions());
