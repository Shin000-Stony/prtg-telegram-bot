import { getConfig } from './config/env';
import { getLogger, resetLoggerForTesting } from './core/logger';
import { getDatabase, closeDatabase, resetDatabaseForTesting } from './infrastructure/database/database';
import { runMigrations, resetMigrationsForTesting } from './infrastructure/database/migration-runner';
import { customerRepository } from './modules/customers/customer.repository';
import { customerService } from './modules/customers/customer.service';
import { groupRepository } from './modules/groups/group.repository';
import { groupService } from './modules/groups/group.service';
import { accessService } from './modules/groups/access.service';
import { mappingRepository } from './modules/mapping/mapping.repository';
import { mappingService } from './modules/mapping/mapping.service';
import { csvImportService } from './modules/imports/csv-import.service';

export interface AppDependencies {
  config: ReturnType<typeof getConfig>;
  logger: ReturnType<typeof getLogger>;
  db: ReturnType<typeof getDatabase>;
  customerRepository: typeof customerRepository;
  customerService: typeof customerService;
  groupRepository: typeof groupRepository;
  groupService: typeof groupService;
  accessService: typeof accessService;
  mappingRepository: typeof mappingRepository;
  mappingService: typeof mappingService;
  csvImportService: typeof csvImportService;
}

let dependencies: AppDependencies | null = null;

export function bootstrap(): AppDependencies {
  if (dependencies) {
    return dependencies;
  }

  const config = getConfig();
  const logger = getLogger();

  logger.info('Starting application bootstrap');

  const db = getDatabase();
  runMigrations();

  dependencies = {
    config,
    logger,
    db,
    customerRepository,
    customerService,
    groupRepository,
    groupService,
    accessService,
    mappingRepository,
    mappingService,
    csvImportService,
  };

  logger.info('Bootstrap completed');
  return dependencies;
}

export function getDependencies(): AppDependencies {
  if (!dependencies) {
    return bootstrap();
  }
  return dependencies;
}

export function shutdown(): void {
  const logger = getLogger();
  logger.info('Shutting down application');
  closeDatabase();
  dependencies = null;
}

export function resetForTesting(): void {
  shutdown();
  resetLoggerForTesting();
  resetDatabaseForTesting();
  resetMigrationsForTesting();
  dependencies = null;
}