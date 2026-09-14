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
  'build_archetype_snapshots_v2',
  'build_archetype_match_locks_v2',
  'adaptive_build_iterations_v1',
] as const;

const PREEXISTING_MIGRATIONS = [
  [1783785600000, 'InitialSchemaAndRawMetadata1783785600000'],
  [1783828800000, 'AddCatalogResolutionFields1783828800000'],
  [1783915200000, 'AddMetadataNormalizationFields1783915200000'],
  [1784088000000, 'DeduplicateItemCatalogContent1784088000000'],
  [1784937600000, 'PreserveRecipeComponentMultiplicity1784937600000'],
] as const;

const integrationDescribe =
  process.env.DB_MIGRATION_INTEGRATION === 'true' ? describe : describe.skip;

integrationDescribe('production database migration integration', () => {
  let dataSource: import('typeorm').DataSource;

  beforeAll(async () => {
    process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
    process.env.DB_PORT = process.env.DB_PORT || '5432';
    process.env.DB_USER = process.env.DB_USER || 'postgres';
    process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
    process.env.DB_NAME = process.env.DB_NAME || 'deadlock_builds';

    const { Client } = require('pg');
    const client = new Client({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });

    await client.connect();
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query(
      'CREATE TABLE item_catalog_versions (id integer PRIMARY KEY, sentinel text NOT NULL)',
    );
    await client.query(
      'CREATE TABLE item_catalog_items (id integer PRIMARY KEY, sentinel text NOT NULL)',
    );
    await client.query(
      'CREATE TABLE item_catalog_recipes (id integer PRIMARY KEY, sentinel text NOT NULL)',
    );
    await client.query("INSERT INTO item_catalog_versions VALUES (1, 'legacy-version')");
    await client.query("INSERT INTO item_catalog_items VALUES (1, 'legacy-item')");
    await client.query("INSERT INTO item_catalog_recipes VALUES (1, 'legacy-recipe')");

    await client.query(`
      CREATE TABLE migrations (
        id SERIAL PRIMARY KEY,
        timestamp bigint NOT NULL,
        name varchar NOT NULL
      )
    `);
    for (const [timestamp, name] of PREEXISTING_MIGRATIONS) {
      await client.query(
        'INSERT INTO migrations (timestamp, name) VALUES ($1, $2)',
        [timestamp, name],
      );
    }
    await client.end();

    const imported = await import('../src/database/data-source');
    dataSource = imported.AppDataSource;
    await dataSource.initialize();
    await dataSource.runMigrations();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  it('creates every new runtime table without mutating legacy catalog tables', async () => {
    const tableRows = (await dataSource.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    )) as Array<{ table_name: string }>;
    const tables = new Set(tableRows.map((row) => row.table_name));

    for (const tableName of REQUIRED_NEW_TABLES) {
      expect(tables.has(tableName)).toBe(true);
    }

    for (const tableName of [
      'item_catalog_versions',
      'item_catalog_items',
      'item_catalog_recipes',
    ]) {
      const rows = (await dataSource.query(
        `SELECT COUNT(*)::int AS count FROM "${tableName}"`,
      )) as Array<{ count: number }>;
      expect(rows[0]?.count).toBe(1);

      const columnRows = (await dataSource.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
        [tableName],
      )) as Array<{ column_name: string }>;
      expect(columnRows.map((row) => row.column_name)).toEqual(['id', 'sentinel']);
    }
  });

  it('records the runtime migrations and leaves no migration pending', async () => {
    const rows = (await dataSource.query(
      'SELECT name FROM migrations WHERE name = ANY($1::varchar[]) ORDER BY name',
      [[
        'CreateRecommendationRuntimeTables1788220800000',
        'CreateBuildArchetypeV2Runtime1789056000000',
        'ScopeBuildArchetypeMatchLocksByPlayerV11789228800000',
        'CreateAdaptiveBuildIterationsV11789315200000',
      ]],
    )) as Array<{ name: string }>;

    expect(rows.map((row) => row.name)).toEqual([
      'CreateAdaptiveBuildIterationsV11789315200000',
      'CreateBuildArchetypeV2Runtime1789056000000',
      'CreateRecommendationRuntimeTables1788220800000',
      'ScopeBuildArchetypeMatchLocksByPlayerV11789228800000',
    ]);
    expect(await dataSource.showMigrations()).toBe(false);
  });

  it('creates the build iteration history indexes', async () => {
    const indexes = (await dataSource.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'adaptive_build_iterations_v1'
       ORDER BY indexname`,
    )) as Array<{ indexname: string }>;
    const names = indexes.map((row) => row.indexname);

    expect(names).toContain('uq_build_iteration_plan_v1');
    expect(names).toContain('uq_build_iteration_not_ready_v1');
    expect(names).toContain('idx_build_iteration_match_v1');
    expect(names).toContain('idx_build_iteration_player_v1');
  });

  it('scopes archetype match locks by player', async () => {
    const columns = (await dataSource.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'build_archetype_match_locks_v2'
       ORDER BY ordinal_position`,
    )) as Array<{ column_name: string }>;
    expect(columns.map((row) => row.column_name)).toContain('steamId');

    const keys = (await dataSource.query(
      `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'build_archetype_match_locks_v2'::regclass AND i.indisprimary
       ORDER BY a.attname`,
    )) as Array<{ column_name: string }>;
    expect(keys.map((row) => row.column_name)).toEqual(['matchId', 'steamId']);
  });
});
