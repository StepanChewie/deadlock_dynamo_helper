// RED contract: relational row implementation must satisfy this shape and index policy.
import { getMetadataArgsStorage } from 'typeorm';
import { StatlockerVsHeroWpaRowV1Entity } from '../src/deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';

describe('Statlocker VS_HERO_WPA relational row V1 contract', () => {
  it('maps the required relational row shape', () => {
    const metadata = getMetadataArgsStorage();
    const table = metadata.tables.find((candidate) => candidate.target === StatlockerVsHeroWpaRowV1Entity);
    const columns = metadata.columns
      .filter((candidate) => candidate.target === StatlockerVsHeroWpaRowV1Entity)
      .map((candidate) => candidate.propertyName);

    expect(table?.name).toBe('statlocker_vs_hero_wpa_rows_v1');
    expect(columns).toEqual(expect.arrayContaining([
      'snapshotId',
      'statlockerPatchId',
      'rulesetVersion',
      'catalogSha256',
      'rankBucket',
      'heroId',
      'enemyHeroId',
      'itemId',
      'count',
      'deltaWpa',
      'meanWpa',
    ]));
  });

  it('defines identity query indexes and source-row uniqueness', () => {
    const metadata = getMetadataArgsStorage();
    const indexes = metadata.indices
      .filter((candidate) => candidate.target === StatlockerVsHeroWpaRowV1Entity)
      .map((candidate) => ({ name: candidate.name, columns: candidate.columns }));

    expect(indexes).toEqual(expect.arrayContaining([
      {
        name: 'idx_statlocker_vs_hero_wpa_identity_hero_enemy_v1',
        columns: ['statlockerPatchId', 'rulesetVersion', 'catalogSha256', 'heroId', 'enemyHeroId'],
      },
      {
        name: 'idx_statlocker_vs_hero_wpa_identity_hero_item_v1',
        columns: ['statlockerPatchId', 'rulesetVersion', 'catalogSha256', 'heroId', 'itemId'],
      },
      {
        name: 'uq_statlocker_vs_hero_wpa_source_row_v1',
        columns: ['snapshotId', 'rankBucket', 'heroId', 'enemyHeroId', 'itemId'],
      },
    ]));
  });
});
