import { InstanceChecker } from 'typeorm/util/InstanceChecker';
import { databaseOptions } from '../src/database/data-source';
import { BuildArchetypeMatchLockV2Entity } from '../src/deadlock-live/entities/build-archetype-match-lock-v2.entity';

describe('database data-source CLI contract', () => {
  it('exports exactly one DataSource instance for TypeORM CLI discovery', async () => {
    const dataSourceModule = await import('../src/database/data-source');
    const dataSourceExports = Object.values(dataSourceModule)
      .filter((value) => InstanceChecker.isDataSource(value));

    expect(dataSourceExports).toHaveLength(1);
    expect(dataSourceExports[0]).toBe(dataSourceModule.AppDataSource);
  });

  it('registers the V2 match-lock entity in the runtime DataSource', () => {
    expect(databaseOptions.entities).toEqual(
      expect.arrayContaining([BuildArchetypeMatchLockV2Entity]),
    );
  });
});
