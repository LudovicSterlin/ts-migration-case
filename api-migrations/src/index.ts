import { defineHook } from '@directus/extensions-sdk';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { retryAsync } from 'ts-retry';
import {
  buildConnectionUrlFromEnvVariables,
  getConnectionHeaders,
  getCustomerName,
} from './utils/config';
import { MigrationFile, MyMigrations, MyMigrationsUp } from './utils/types';

const HF_MIGRATION_TABLE_NAME = 'my_migrations';
const MIGRATIONS_FOLDER_NAME = 'migrations';

export default defineHook(({ action }, hookExtensionContext) => {
  let { logger, database } = hookExtensionContext;
  logger = logger.child({ name: 'api-migrations' });

  const enableMigration = process.env.HF_ENABLE_API_MIGRATION === 'true';
  if (!enableMigration) {
    logger.info('Hook is not enabled. Your migrations will not be proceeded.');
    return;
  }

  const connectionUrl = buildConnectionUrlFromEnvVariables();

  action('server.start', (): void => {
    const handler = async () => {
      // Action hooks executes when server starts
      logger.info('Running My migrations...');

      // Get Completed migrations from database
      const completedMigrations = (await database
        .select('*')
        .from(HF_MIGRATION_TABLE_NAME)
        .orderBy('version')) as MyMigrations[];
      logger.info(`Found ${completedMigrations.length} migrations in db`);

      // Get migrations files
      const migrationsFolderPath = path.join(__dirname, MIGRATIONS_FOLDER_NAME);
      const migrationFiles = readdirSync(migrationsFolderPath).filter((file) =>
        file.endsWith('.js')
      );
      
      function parseFileName(fileName: string, custom = false) {
        const version = fileName.split('-')[0] || '-1';
        return {
          file: path.join(
            custom ? customerMigrationsFolderPath : migrationsFolderPath,
            fileName
          ),
          name: fileName.split('-').slice(1).join(' ').split('.')[0],
          version: version,
          completed: !!completedMigrations.find(
            (migration) => migration.version === version
          ),
        };
      }

      // general migration list
      let migrations: MigrationFile[] = migrationFiles.map((filename) => parseFileName(filename));

      let customerName;
      try {
        customerName = getCustomerName();
      } catch (error) {
        logger.info(
          `Customer name is not set. Only general migrations will run.`
        );
        logger.warn(error);
      }

      // add customer migration list
      if (customerName) {
        const customerMigrationsFolderPath: string = path.join(
          migrationsFolderPath,
          customerName
        );

        const customerMigrationFiles: string[] = existsSync(customerMigrationsFolderPath)
          ? readdirSync(customerMigrationsFolderPath).filter((file) =>
              file.endsWith('.js')
            )
          : [];

        const customerMigrations = customerMigrationFiles
          .map((filename) => parseFileName(filename, true))
          .sort((a, b) => (a.version > b.version ? 1 : -1));
          
        migrations = migrations.concat(customerMigrations);
      }

      logger.info(`Found ${migrations.length} My migrations file`);

      const migrationKeys = new Set(migrations.map((m) => m.version));
      if (migrations.length > migrationKeys.size) {
        throw new Error(
          'Migration keys collide! Please ensure that every migration uses a unique key.'
        );
      }

      if (migrations && migrations.length > 0) {
        const headers = getConnectionHeaders();
        if (!headers) {
          logger.error(
            `No headers generated, migrations will not be run !`
          );
          return;
        }
        const migrationsToApply = migrations.filter((m) => !m.completed);
        logger.info(`${migrationsToApply.length} migrations left to apply`);
        for (const migration of migrationsToApply) {
          const migrationName = migration.name as string;
          logger.info(`Applying "${migrationName}" ...`);
          // eslint-disable-next-line  @typescript-eslint/no-var-requires
          const { up } = require(migration.file) as {
            up: MyMigrationsUp;
          };
          try {
            await retryAsync(
              async () => {
                await up(connectionUrl, headers);
              },
              { delay: 1000, maxTry: 2 }
            );
            logger.info(`migration "${migrationName}" ✔ Done`);
            await database
              .insert({
                version: migration.version,
                name: migrationName,
              })
              .into(HF_MIGRATION_TABLE_NAME);
          } catch (error) {
            logger.info(`Error during migration: "${migrationName}"`);
            logger.error(error);
            return;
          }
        }
      }
      logger.info('My migrations. ✔ Done');
    };
    handler().catch((err) => {
      logger.error(err);
    });
  });
});
