import fs from 'node:fs';
import path from 'node:path';

const REQUIRED_NEW_TABLES = [
  'adaptive_recommendation_decisions_v1',
  'model_bundle_registry_v1',
  'recommendation_dataset_registry_v1',
  'recommendation_decision_candidates_v8',
  'recommendation_decisions_v8',
  'recommendation_evidence_snapshots_v8',
  'recommendation_exposure_acks_v8',
  'recommendation_roadmap_evidence_v1',
  'recommendation_telemetry_events',
  'recommendation_telemetry_rejections_v8',
  'recommendation_value_dataset_registry_v1',
  'souls_affordability_evidence_v2',
  'statlocker_evidence_snapshots_v1',
  'recommendation_item_catalog_versions_v1',
  'recommendation_item_catalog_items_v1',
  'recommendation_item_catalog_recipes_v1',
] as const;

describe('production database policy', () => {
  const srcRoot = path.resolve(__dirname, '../src');
  const repoRoot = path.resolve(__dirname, '../../..');
  const appModulePath = path.join(srcRoot, 'app.module.ts');
  const dataSourcePath = path.join(srcRoot, 'database', 'data-source.ts');
  const migrationsPath = path.join(srcRoot, 'database', 'migrations');

  it('disables schema synchronization and uses explicit migrations', () => {
    const appModuleSource = fs.readFileSync(appModulePath, 'utf8');

    expect(appModuleSource).toContain('databaseOptions');
    expect(appModuleSource).not.toContain('synchronize: true');
    expect(fs.existsSync(dataSourcePath)).toBe(true);
    expect(fs.existsSync(migrationsPath)).toBe(true);

    if (!fs.existsSync(dataSourcePath) || !fs.existsSync(migrationsPath)) {
      return;
    }

    const dataSourceSource = fs.readFileSync(dataSourcePath, 'utf8');
    expect(dataSourceSource).toContain('synchronize: false');
    expect(dataSourceSource).toContain('migrations:');

    const recommendationMigrationPath = path.join(
      migrationsPath,
      '1788220800000-create-recommendation-runtime-tables.ts',
    );
    expect(fs.existsSync(recommendationMigrationPath)).toBe(true);
    const migrationSource = fs.readFileSync(recommendationMigrationPath, 'utf8');

    for (const tableName of REQUIRED_NEW_TABLES) {
      expect(migrationSource).toContain(tableName);
    }

    expect(migrationSource).not.toMatch(/(?:ALTER|DROP)\s+TABLE\s+["']?item_catalog_/i);
  });

  it('runs explicit migrations before the production Compose API begins serving', () => {
    const appModuleSource = fs.readFileSync(appModulePath, 'utf8');
    const composeSource = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
    const envExampleSource = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

    expect(appModuleSource).toContain("migrationsRun: process.env.DB_RUN_MIGRATIONS === 'true'");
    expect(composeSource).toContain('DB_RUN_MIGRATIONS: ${DB_RUN_MIGRATIONS:-true}');
    expect(envExampleSource).toContain('DB_RUN_MIGRATIONS=true');
  });
});
