import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { In, Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { RecommendationItemCatalogItemV1 } from '../deadlock-live/entities/recommendation-item-catalog-item-v1.entity';
import { RecommendationItemCatalogRecipeV1 } from '../deadlock-live/entities/recommendation-item-catalog-recipe-v1.entity';
import { RecommendationItemCatalogVersionV1 } from '../deadlock-live/entities/recommendation-item-catalog-version-v1.entity';
import { StatlockerEvidenceSnapshotV1Entity } from '../deadlock-live/entities/statlocker-evidence-snapshot-v1.entity';
import { StatlockerVsHeroWpaRowV1Entity } from '../deadlock-live/entities/statlocker-vs-hero-wpa-row-v1.entity';
import {
  StatlockerHeroLeaderboardV1,
  StatlockerProBuildAnalysisV1,
  StatlockerT4ChainsV1,
  StatlockerWpaPatchDataV1,
} from '../statlocker-adaptive/statlocker-adaptive.types';

const REQUIRED_PROFILE_COUNT = 10;
const REQUIRED_ENEMY_ROSTER_SIZE = 6;
const MAX_IDENTITY_CANDIDATES = 50;

type StatlockerFixtureDataset =
  | 'WPA_PATCH_DATA'
  | 'T4_CHAINS'
  | 'HERO_LEADERBOARD'
  | 'PRO_BUILD_ANALYSIS';

export interface CaptureStatlockerBuildV2FixtureArgs {
  request: string;
  out: string;
}

export interface StatlockerBuildV2RequestContext {
  matchId: string;
  heroId: number;
  gameTimeSec: number;
  ownedItemIds: readonly number[];
  spendableSouls: number;
  localSteamId?: string;
  allyHeroIds?: readonly number[];
  enemyHeroIds: readonly number[];
  enemyLiveStates?: readonly Record<string, unknown>[];
  allyItemIds?: readonly number[];
  enemyItemIds?: readonly number[];
  unlockedFlexSlots?: number;
  totalCapacity: number;
  stateRevision: string;
}

interface FixtureIdentityV2 {
  rulesetVersion: string;
  catalogSha256: string;
  statlockerPatchId: string;
}

interface FixtureCatalogVersionV2 {
  catalogVersionId: string;
  contentCatalogVersionId?: string;
  clientVersion?: string;
  rulesetKey: string;
  source: string;
  payloadSha256: string;
  importedAt?: string;
}

interface FixtureCatalogItemV2 {
  catalogVersionId: string;
  itemId: number;
  name: string;
  className?: string;
  itemType?: string;
  slotType?: string;
  cost?: number;
  tier?: number;
  shopable?: boolean;
  disabled?: boolean;
  active?: boolean;
  isActiveItem?: boolean;
  activationType?: string;
  rawPayload: Record<string, unknown>;
}

interface FixtureCatalogRecipeV2 {
  catalogVersionId: string;
  parentItemId: number;
  componentItemId: number;
  componentOrder: number;
}

interface FixtureVsHeroWpaRowV2 {
  snapshotId: string;
  statlockerPatchId: string;
  rulesetVersion: string;
  catalogSha256: string;
  rankBucket: string;
  heroId: number;
  enemyHeroId: number;
  itemId: number;
  count: number;
  deltaWpa: number;
  meanWpa?: number;
}

interface FixtureSnapshotProvenanceV2 {
  dataset: string;
  scopeKey: string;
  snapshotId: string;
  contentSha256: string;
  fetchedAt: string;
}

export interface StatlockerBuildV2FixtureSourceInput {
  request: StatlockerBuildV2RequestContext;
  identity: FixtureIdentityV2;
  leaderboard: StatlockerHeroLeaderboardV1;
  proBuildAnalyses: readonly StatlockerProBuildAnalysisV1[];
  wpaPatchData: StatlockerWpaPatchDataV1;
  t4Chains: StatlockerT4ChainsV1;
  vsHeroWpaRows: readonly FixtureVsHeroWpaRowV2[];
  catalog: {
    version: FixtureCatalogVersionV2;
    items: readonly FixtureCatalogItemV2[];
    recipes: readonly FixtureCatalogRecipeV2[];
  };
  snapshotProvenance?: readonly FixtureSnapshotProvenanceV2[];
}

export interface StatlockerBuildV2Fixture {
  metadata: {
    contract: 'STATLOCKER_BUILD_V2_REAL_FIXTURE_1';
    source: 'STATLOCKER_ONLY';
    buildEvidenceSource: 'STATLOCKER_ONLY';
    liveContextSource: 'REQUEST';
    heroId: number;
    matchId: string;
    identity: FixtureIdentityV2;
    snapshotProvenance: readonly FixtureSnapshotProvenanceV2[];
  };
  request: StatlockerBuildV2RequestContext;
  leaderboard: StatlockerHeroLeaderboardV1;
  proBuildAnalyses: readonly StatlockerProBuildAnalysisV1[];
  wpaPatchData: StatlockerWpaPatchDataV1;
  t4Chains: StatlockerT4ChainsV1;
  vsHeroWpaRows: readonly FixtureVsHeroWpaRowV2[];
  catalog: {
    version: FixtureCatalogVersionV2;
    items: readonly FixtureCatalogItemV2[];
    recipes: readonly FixtureCatalogRecipeV2[];
  };
}

export function parseCaptureStatlockerBuildV2FixtureArgs(
  argv: readonly string[],
): CaptureStatlockerBuildV2FixtureArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected fixture capture argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
    values.set(key.slice(2), value);
    index += 1;
  }

  const request = values.get('request')?.trim();
  const out = values.get('out')?.trim();
  if (!request) throw new Error('Fixture capture requires --request');
  if (!out) throw new Error('Fixture capture requires --out');

  const unexpected = [...values.keys()].filter((key) => key !== 'request' && key !== 'out');
  if (unexpected.length > 0) {
    throw new Error(`Unexpected fixture capture option(s): ${unexpected.map((key) => `--${key}`).join(', ')}`);
  }
  return { request, out };
}

export function statlockerFixtureScope(
  dataset: StatlockerFixtureDataset,
  input: { heroId: number; statlockerPatchId: string; accountId?: string },
): string {
  if (dataset === 'WPA_PATCH_DATA') return `patch:${input.statlockerPatchId}`;
  if (dataset === 'T4_CHAINS') return 'global';
  if (dataset === 'HERO_LEADERBOARD') return `hero:${input.heroId}`;
  const accountId = input.accountId?.trim();
  if (!accountId) throw new Error('PRO_BUILD_ANALYSIS fixture scope requires accountId');
  return `hero:${input.heroId}:account:${accountId}`;
}

export function resolveFixtureCatalogContentVersionId(
  version: { catalogVersionId: string; contentCatalogVersionId?: string },
): string {
  const contentCatalogVersionId = version.contentCatalogVersionId?.trim();
  return contentCatalogVersionId || version.catalogVersionId;
}

export function buildStatlockerBuildV2Fixture(
  input: StatlockerBuildV2FixtureSourceInput,
): StatlockerBuildV2Fixture {
  const request = normalizeRequestContext(input.request);
  validateSourceIdentity(input, request);
  const heroId = request.heroId;
  const topTen = selectTopTen(input.leaderboard, heroId);
  if (topTen.length !== REQUIRED_PROFILE_COUNT) {
    throw new Error(`Fixture capture requires exactly ${REQUIRED_PROFILE_COUNT} ranked HERO_LEADERBOARD profiles`);
  }

  const analysisByAccount = new Map<string, StatlockerProBuildAnalysisV1>();
  for (const analysis of input.proBuildAnalyses) {
    if (analysis.heroId !== heroId || !analysis.accountId) continue;
    if (!analysisByAccount.has(analysis.accountId)) analysisByAccount.set(analysis.accountId, analysis);
  }
  const proBuildAnalyses = topTen
    .map((profile) => analysisByAccount.get(profile.accountId))
    .filter((analysis): analysis is StatlockerProBuildAnalysisV1 => analysis !== undefined);
  if (proBuildAnalyses.length !== REQUIRED_PROFILE_COUNT) {
    throw new Error(`Fixture capture requires exactly ${REQUIRED_PROFILE_COUNT} ranked PRO_BUILD_ANALYSIS profiles`);
  }

  const enemyHeroIds = uniqueSortedPositiveIntegers(request.enemyHeroIds);
  if (enemyHeroIds.length !== REQUIRED_ENEMY_ROSTER_SIZE) {
    throw new Error(`Fixture capture requires a complete enemy roster of ${REQUIRED_ENEMY_ROSTER_SIZE} unique heroes in the request`);
  }

  const wpaPatchData: StatlockerWpaPatchDataV1 = {
    patchId: input.wpaPatchData.patchId,
    items: input.wpaPatchData.items
      .filter((item) => item.heroId === heroId)
      .map(cloneJson)
      .sort((left, right) => left.itemId - right.itemId),
  };
  const t4Chains: StatlockerT4ChainsV1 = {
    chains: input.t4Chains.chains
      .filter((chain) => chain.heroId === heroId)
      .map((chain) => ({ ...cloneJson(chain), itemIds: [...chain.itemIds].sort((a, b) => a - b) }))
      .sort(compareT4Chains),
  };

  const enemySet = new Set(enemyHeroIds);
  const vsHeroWpaRows = input.vsHeroWpaRows
    .filter((row) =>
      row.heroId === heroId &&
      row.statlockerPatchId === input.identity.statlockerPatchId &&
      row.rulesetVersion === input.identity.rulesetVersion &&
      row.catalogSha256.toLowerCase() === input.identity.catalogSha256.toLowerCase() &&
      enemySet.has(row.enemyHeroId),
    )
    .map(cloneJson)
    .sort(compareVsHeroRows);
  if (vsHeroWpaRows.length === 0) {
    throw new Error(`Fixture capture requires nonzero compatible VS_HERO_WPA rows for hero ${heroId}`);
  }

  const relevantItemIds = collectRelevantItemIds({
    proBuildAnalyses,
    wpaPatchData,
    t4Chains,
    vsHeroWpaRows,
    request,
    recipes: input.catalog.recipes,
  });
  const catalogItems = input.catalog.items
    .filter((item) => relevantItemIds.has(item.itemId))
    .map(cloneJson)
    .sort((left, right) => left.itemId - right.itemId);
  const catalogRecipes = input.catalog.recipes
    .filter((recipe) => relevantItemIds.has(recipe.parentItemId) && relevantItemIds.has(recipe.componentItemId))
    .map(cloneJson)
    .sort(compareRecipes);

  const snapshotProvenance = [...(input.snapshotProvenance ?? [])]
    .map(cloneJson)
    .sort((left, right) =>
      left.dataset.localeCompare(right.dataset) ||
      left.scopeKey.localeCompare(right.scopeKey) ||
      left.snapshotId.localeCompare(right.snapshotId));

  return {
    metadata: {
      contract: 'STATLOCKER_BUILD_V2_REAL_FIXTURE_1',
      source: 'STATLOCKER_ONLY',
      buildEvidenceSource: 'STATLOCKER_ONLY',
      liveContextSource: 'REQUEST',
      heroId,
      matchId: request.matchId,
      identity: {
        ...input.identity,
        catalogSha256: input.identity.catalogSha256.toLowerCase(),
      },
      snapshotProvenance,
    },
    request,
    leaderboard: {
      heroId,
      profiles: topTen.map(cloneJson),
    },
    proBuildAnalyses: proBuildAnalyses.map(cloneJson),
    wpaPatchData,
    t4Chains,
    vsHeroWpaRows,
    catalog: {
      version: cloneJson(input.catalog.version),
      items: catalogItems,
      recipes: catalogRecipes,
    },
  };
}

async function main(): Promise<void> {
  const args = parseCaptureStatlockerBuildV2FixtureArgs(process.argv.slice(2));
  const request = await loadRequestContext(args.request);
  await AppDataSource.initialize();
  try {
    const source = await loadStatlockerFixtureSourceFromDatabase(request);
    const fixture = buildStatlockerBuildV2Fixture(source);
    const outputPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `Captured Statlocker-only Build V2 fixture: hero=${fixture.metadata.heroId} match=${fixture.metadata.matchId} profiles=${fixture.proBuildAnalyses.length} wpaRows=${fixture.vsHeroWpaRows.length} out=${outputPath}\n`,
    );
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

async function loadRequestContext(path: string): Promise<StatlockerBuildV2RequestContext> {
  const inputPath = resolve(process.cwd(), path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inputPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(`Fixture capture could not read request ${inputPath}: ${describeError(error)}`);
  }
  return normalizeRequestContext(parsed);
}

async function loadStatlockerFixtureSourceFromDatabase(
  request: StatlockerBuildV2RequestContext,
): Promise<StatlockerBuildV2FixtureSourceInput> {
  const snapshotRepo = AppDataSource.getRepository(StatlockerEvidenceSnapshotV1Entity);
  const wpaRepo = AppDataSource.getRepository(StatlockerVsHeroWpaRowV1Entity);
  const catalogVersionRepo = AppDataSource.getRepository(RecommendationItemCatalogVersionV1);
  const catalogItemRepo = AppDataSource.getRepository(RecommendationItemCatalogItemV1);
  const catalogRecipeRepo = AppDataSource.getRepository(RecommendationItemCatalogRecipeV1);
  const scopeKey = statlockerFixtureScope('HERO_LEADERBOARD', {
    heroId: request.heroId,
    statlockerPatchId: 'identity-from-statlocker',
  });
  const leaderboardRows = await snapshotRepo.find({
    where: { dataset: 'HERO_LEADERBOARD', scopeKey },
    order: { fetchedAt: 'DESC', snapshotId: 'DESC' },
    take: MAX_IDENTITY_CANDIDATES,
  });
  if (leaderboardRows.length === 0) {
    throw new Error(`Fixture capture found no Statlocker HERO_LEADERBOARD snapshots for hero ${request.heroId}`);
  }

  const failures: string[] = [];
  for (const leaderboardRow of leaderboardRows) {
    try {
      return await loadExactStatlockerIdentity({
        request,
        leaderboardRow,
        snapshotRepo,
        wpaRepo,
        catalogVersionRepo,
        catalogItemRepo,
        catalogRecipeRepo,
      });
    } catch (error) {
      failures.push(`${leaderboardRow.snapshotId}: ${describeError(error)}`);
    }
  }

  throw new Error(
    `Fixture capture could not prove one complete Statlocker-only identity for hero ${request.heroId}: ${failures.slice(0, 5).join(' | ')}`,
  );
}

async function loadExactStatlockerIdentity(input: {
  request: StatlockerBuildV2RequestContext;
  leaderboardRow: StatlockerEvidenceSnapshotV1Entity;
  snapshotRepo: Repository<StatlockerEvidenceSnapshotV1Entity>;
  wpaRepo: Repository<StatlockerVsHeroWpaRowV1Entity>;
  catalogVersionRepo: Repository<RecommendationItemCatalogVersionV1>;
  catalogItemRepo: Repository<RecommendationItemCatalogItemV1>;
  catalogRecipeRepo: Repository<RecommendationItemCatalogRecipeV1>;
}): Promise<StatlockerBuildV2FixtureSourceInput> {
  const heroId = input.request.heroId;
  const identity: FixtureIdentityV2 = {
    rulesetVersion: nonEmptyString(input.leaderboardRow.rulesetVersion, 'Statlocker ruleset identity'),
    catalogSha256: sha256String(input.leaderboardRow.catalogSha256, 'Statlocker catalog identity'),
    statlockerPatchId: nonEmptyString(input.leaderboardRow.statlockerPatchId, 'Statlocker patch identity'),
  };
  const leaderboard = parseLeaderboard(input.leaderboardRow.payload, heroId);
  const topTen = selectTopTen(leaderboard, heroId);
  if (topTen.length !== REQUIRED_PROFILE_COUNT) {
    throw new Error(`requires exactly ${REQUIRED_PROFILE_COUNT} ranked HERO_LEADERBOARD profiles`);
  }

  const scopeInput = { heroId, statlockerPatchId: identity.statlockerPatchId };
  const profileRows: StatlockerEvidenceSnapshotV1Entity[] = [];
  const proBuildAnalyses: StatlockerProBuildAnalysisV1[] = [];
  for (const profile of topTen) {
    const row = await loadLatestSnapshot(input.snapshotRepo, {
      dataset: 'PRO_BUILD_ANALYSIS',
      scopeKey: statlockerFixtureScope('PRO_BUILD_ANALYSIS', { ...scopeInput, accountId: profile.accountId }),
      ...identity,
    });
    profileRows.push(row);
    proBuildAnalyses.push(parseProBuild(row.payload, heroId, profile.accountId));
  }

  const [wpaPatchRow, t4Row] = await Promise.all([
    loadLatestSnapshot(input.snapshotRepo, {
      dataset: 'WPA_PATCH_DATA',
      scopeKey: statlockerFixtureScope('WPA_PATCH_DATA', scopeInput),
      ...identity,
    }),
    loadLatestSnapshot(input.snapshotRepo, {
      dataset: 'T4_CHAINS',
      scopeKey: statlockerFixtureScope('T4_CHAINS', scopeInput),
      ...identity,
    }),
  ]);

  const enemyHeroIds = uniqueSortedPositiveIntegers(input.request.enemyHeroIds);
  if (enemyHeroIds.length !== REQUIRED_ENEMY_ROSTER_SIZE) {
    throw new Error(`request requires a complete enemy roster of ${REQUIRED_ENEMY_ROSTER_SIZE} unique heroes`);
  }
  const vsHeroWpaRows = await input.wpaRepo.find({
    where: {
      statlockerPatchId: identity.statlockerPatchId,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
      heroId,
      enemyHeroId: In(enemyHeroIds),
    },
    order: { enemyHeroId: 'ASC', itemId: 'ASC', rankBucket: 'ASC', snapshotId: 'ASC' },
  });
  if (vsHeroWpaRows.length === 0) {
    throw new Error(`found no compatible Statlocker VS_HERO_WPA rows for hero ${heroId}`);
  }

  const catalogVersion = await input.catalogVersionRepo.findOne({
    where: { rulesetKey: identity.rulesetVersion, payloadSha256: identity.catalogSha256 },
  });
  if (!catalogVersion) {
    throw new Error(`could not resolve legality catalog ${identity.catalogSha256} for ruleset ${identity.rulesetVersion}`);
  }
  const contentCatalogVersionId = resolveFixtureCatalogContentVersionId(catalogVersion);
  const [catalogItems, catalogRecipes] = await Promise.all([
    input.catalogItemRepo.find({
      where: { catalogVersionId: contentCatalogVersionId },
      order: { itemId: 'ASC' },
    }),
    input.catalogRecipeRepo.find({
      where: { catalogVersionId: contentCatalogVersionId },
      order: { parentItemId: 'ASC', componentOrder: 'ASC', componentItemId: 'ASC' },
    }),
  ]);
  if (catalogItems.length === 0) {
    throw new Error(`found no legality catalog items for content catalog ${contentCatalogVersionId}`);
  }

  return {
    request: input.request,
    identity,
    leaderboard,
    proBuildAnalyses,
    wpaPatchData: parseWpaPatch(wpaPatchRow.payload, identity.statlockerPatchId),
    t4Chains: parseT4Chains(t4Row.payload),
    vsHeroWpaRows: vsHeroWpaRows.map(toVsHeroFixtureRow),
    catalog: {
      version: toCatalogVersionFixture(catalogVersion),
      items: catalogItems.map(toCatalogItemFixture),
      recipes: catalogRecipes.map(toCatalogRecipeFixture),
    },
    snapshotProvenance: [
      input.leaderboardRow,
      ...profileRows,
      wpaPatchRow,
      t4Row,
    ].map(toSnapshotProvenance),
  };
}

async function loadLatestSnapshot(
  repository: Repository<StatlockerEvidenceSnapshotV1Entity>,
  input: FixtureIdentityV2 & { dataset: string; scopeKey: string },
): Promise<StatlockerEvidenceSnapshotV1Entity> {
  const rows = await repository.find({
    where: {
      dataset: input.dataset,
      scopeKey: input.scopeKey,
      rulesetVersion: input.rulesetVersion,
      catalogSha256: input.catalogSha256,
      statlockerPatchId: input.statlockerPatchId,
    },
    order: { fetchedAt: 'DESC', snapshotId: 'DESC' },
    take: 1,
  });
  const row = rows[0];
  if (!row) {
    throw new Error(`missing ${input.dataset} snapshot for ${input.scopeKey} at exact Statlocker identity`);
  }
  return row;
}

function selectTopTen(
  leaderboard: StatlockerHeroLeaderboardV1,
  heroId: number,
): Array<{ accountId: string; heroId: number; rank: number; playerName?: string }> {
  const valid = leaderboard.profiles
    .filter((profile) =>
      profile.heroId === heroId &&
      Number.isInteger(profile.rank) && profile.rank > 0 &&
      typeof profile.accountId === 'string' && profile.accountId.trim() !== '')
    .map((profile) => cloneJson(profile))
    .sort((left, right) => left.rank - right.rank || left.accountId.localeCompare(right.accountId));
  const result: Array<{ accountId: string; heroId: number; rank: number; playerName?: string }> = [];
  const seen = new Set<string>();
  for (const profile of valid) {
    if (seen.has(profile.accountId)) continue;
    seen.add(profile.accountId);
    result.push(profile);
    if (result.length === REQUIRED_PROFILE_COUNT) break;
  }
  return result;
}

function normalizeRequestContext(value: unknown): StatlockerBuildV2RequestContext {
  if (!isRecord(value)) throw new Error('Fixture capture request must be a JSON object');
  const matchId = nonEmptyString(value.matchId, 'request matchId');
  const heroId = positiveInteger(value.heroId, 'request heroId');
  const gameTimeSec = nonNegativeNumber(value.gameTimeSec, 'request gameTimeSec');
  const spendableSouls = nonNegativeNumber(value.spendableSouls, 'request spendableSouls');
  const totalCapacity = positiveInteger(value.totalCapacity, 'request totalCapacity');
  const stateRevision = nonEmptyString(value.stateRevision, 'request stateRevision');
  const enemyHeroIds = exactPositiveIntegerArray(value.enemyHeroIds, 'request enemyHeroIds');
  if (enemyHeroIds.length !== REQUIRED_ENEMY_ROSTER_SIZE) {
    throw new Error(`Fixture capture requires a complete enemy roster of ${REQUIRED_ENEMY_ROSTER_SIZE} unique heroes in the request`);
  }

  const request: StatlockerBuildV2RequestContext = {
    matchId,
    heroId,
    gameTimeSec,
    ownedItemIds: optionalPositiveIntegerArray(value.ownedItemIds, 'request ownedItemIds'),
    spendableSouls,
    allyHeroIds: optionalPositiveIntegerArray(value.allyHeroIds, 'request allyHeroIds'),
    enemyHeroIds,
    enemyLiveStates: normalizeEnemyLiveStates(value.enemyLiveStates, enemyHeroIds),
    allyItemIds: optionalPositiveIntegerArray(value.allyItemIds, 'request allyItemIds'),
    enemyItemIds: optionalPositiveIntegerArray(value.enemyItemIds, 'request enemyItemIds'),
    totalCapacity,
    stateRevision,
  };
  if (value.localSteamId !== undefined) request.localSteamId = nonEmptyString(value.localSteamId, 'request localSteamId');
  if (value.unlockedFlexSlots !== undefined) {
    request.unlockedFlexSlots = nonNegativeInteger(value.unlockedFlexSlots, 'request unlockedFlexSlots');
  }
  return request;
}

function normalizeEnemyLiveStates(
  value: unknown,
  enemyHeroIds: readonly number[],
): readonly Record<string, unknown>[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Fixture capture request enemyLiveStates must be an array');
  const enemySet = new Set(enemyHeroIds);
  const allowedKeys = [
    'steamId', 'playerName', 'heroId', 'heroName', 'level', 'souls', 'kills', 'deaths', 'assists',
    'heroDamage', 'health', 'maxHealth',
  ] as const;
  return value
    .map((entry) => {
      if (!isRecord(entry)) throw new Error('Fixture capture request enemyLiveStates entries must be objects');
      const heroId = positiveInteger(entry.heroId, 'request enemyLiveStates heroId');
      if (!enemySet.has(heroId)) throw new Error(`Fixture capture enemyLiveStates contains hero ${heroId} outside enemyHeroIds`);
      return pickRecord(entry, allowedKeys);
    })
    .sort((left, right) => Number(left.heroId) - Number(right.heroId));
}

function collectRelevantItemIds(input: {
  proBuildAnalyses: readonly StatlockerProBuildAnalysisV1[];
  wpaPatchData: StatlockerWpaPatchDataV1;
  t4Chains: StatlockerT4ChainsV1;
  vsHeroWpaRows: readonly FixtureVsHeroWpaRowV2[];
  request: StatlockerBuildV2RequestContext;
  recipes: readonly FixtureCatalogRecipeV2[];
}): Set<number> {
  const ids = new Set<number>();
  for (const analysis of input.proBuildAnalyses) for (const item of analysis.items) ids.add(item.itemId);
  for (const item of input.wpaPatchData.items) ids.add(item.itemId);
  for (const chain of input.t4Chains.chains) for (const itemId of chain.itemIds) ids.add(itemId);
  for (const row of input.vsHeroWpaRows) ids.add(row.itemId);
  for (const itemId of input.request.ownedItemIds) ids.add(itemId);
  for (const itemId of input.request.allyItemIds ?? []) ids.add(itemId);
  for (const itemId of input.request.enemyItemIds ?? []) ids.add(itemId);

  let changed = true;
  while (changed) {
    changed = false;
    for (const recipe of input.recipes) {
      if (!ids.has(recipe.parentItemId) && !ids.has(recipe.componentItemId)) continue;
      if (!ids.has(recipe.parentItemId)) {
        ids.add(recipe.parentItemId);
        changed = true;
      }
      if (!ids.has(recipe.componentItemId)) {
        ids.add(recipe.componentItemId);
        changed = true;
      }
    }
  }
  return ids;
}

function validateSourceIdentity(
  input: StatlockerBuildV2FixtureSourceInput,
  request: StatlockerBuildV2RequestContext,
): void {
  if (!input.identity.rulesetVersion || !input.identity.statlockerPatchId) {
    throw new Error('Fixture capture Statlocker identity is incomplete');
  }
  sha256String(input.identity.catalogSha256, 'Statlocker catalog identity');
  if (input.leaderboard.heroId !== request.heroId) throw new Error('Fixture capture leaderboard hero mismatch');
  if (input.wpaPatchData.patchId !== input.identity.statlockerPatchId) throw new Error('Fixture capture WPA patch identity mismatch');
  if (input.catalog.version.rulesetKey !== input.identity.rulesetVersion) throw new Error('Fixture capture catalog ruleset identity mismatch');
  if (input.catalog.version.payloadSha256.toLowerCase() !== input.identity.catalogSha256.toLowerCase()) {
    throw new Error('Fixture capture catalog SHA identity mismatch');
  }
}

function parseLeaderboard(payload: Record<string, unknown>, heroId: number): StatlockerHeroLeaderboardV1 {
  const value = payload as unknown as StatlockerHeroLeaderboardV1;
  if (value.heroId !== heroId || !Array.isArray(value.profiles)) {
    throw new Error(`Fixture capture invalid HERO_LEADERBOARD payload for hero ${heroId}`);
  }
  return value;
}

function parseProBuild(payload: Record<string, unknown>, heroId: number, accountId: string): StatlockerProBuildAnalysisV1 {
  const value = payload as unknown as StatlockerProBuildAnalysisV1;
  if (value.heroId !== heroId || value.accountId !== accountId || !Array.isArray(value.items)) {
    throw new Error(`Fixture capture invalid PRO_BUILD_ANALYSIS payload for account ${accountId}`);
  }
  return value;
}

function parseWpaPatch(payload: Record<string, unknown>, patchId: string): StatlockerWpaPatchDataV1 {
  const value = payload as unknown as StatlockerWpaPatchDataV1;
  if (value.patchId !== patchId || !Array.isArray(value.items)) throw new Error('Fixture capture invalid WPA_PATCH_DATA payload');
  return value;
}

function parseT4Chains(payload: Record<string, unknown>): StatlockerT4ChainsV1 {
  const value = payload as unknown as StatlockerT4ChainsV1;
  if (!Array.isArray(value.chains)) throw new Error('Fixture capture invalid T4_CHAINS payload');
  return value;
}

function toVsHeroFixtureRow(row: StatlockerVsHeroWpaRowV1Entity): FixtureVsHeroWpaRowV2 {
  return {
    snapshotId: row.snapshotId,
    statlockerPatchId: row.statlockerPatchId,
    rulesetVersion: row.rulesetVersion,
    catalogSha256: row.catalogSha256,
    rankBucket: row.rankBucket,
    heroId: row.heroId,
    enemyHeroId: row.enemyHeroId,
    itemId: Number(row.itemId),
    count: row.count,
    deltaWpa: row.deltaWpa,
    meanWpa: row.meanWpa,
  };
}

function toCatalogVersionFixture(row: RecommendationItemCatalogVersionV1): FixtureCatalogVersionV2 {
  return {
    catalogVersionId: row.catalogVersionId,
    contentCatalogVersionId: row.contentCatalogVersionId,
    clientVersion: row.clientVersion,
    rulesetKey: row.rulesetKey,
    source: row.source,
    payloadSha256: row.payloadSha256,
    importedAt: row.importedAt.toISOString(),
  };
}

function toCatalogItemFixture(row: RecommendationItemCatalogItemV1): FixtureCatalogItemV2 {
  return {
    catalogVersionId: row.catalogVersionId,
    itemId: Number(row.itemId),
    name: row.name,
    className: row.className,
    itemType: row.itemType,
    slotType: row.slotType,
    cost: row.cost,
    tier: row.tier,
    shopable: row.shopable,
    disabled: row.disabled,
    active: row.active,
    isActiveItem: row.isActiveItem,
    activationType: row.activationType,
    rawPayload: cloneJson(row.rawPayload),
  };
}

function toCatalogRecipeFixture(row: RecommendationItemCatalogRecipeV1): FixtureCatalogRecipeV2 {
  return {
    catalogVersionId: row.catalogVersionId,
    parentItemId: Number(row.parentItemId),
    componentItemId: Number(row.componentItemId),
    componentOrder: row.componentOrder,
  };
}

function toSnapshotProvenance(row: StatlockerEvidenceSnapshotV1Entity): FixtureSnapshotProvenanceV2 {
  return {
    dataset: row.dataset,
    scopeKey: row.scopeKey,
    snapshotId: row.snapshotId,
    contentSha256: row.contentSha256,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}

function compareVsHeroRows(left: FixtureVsHeroWpaRowV2, right: FixtureVsHeroWpaRowV2): number {
  return left.enemyHeroId - right.enemyHeroId ||
    left.itemId - right.itemId ||
    left.rankBucket.localeCompare(right.rankBucket) ||
    left.snapshotId.localeCompare(right.snapshotId);
}

function compareRecipes(left: FixtureCatalogRecipeV2, right: FixtureCatalogRecipeV2): number {
  return left.parentItemId - right.parentItemId ||
    left.componentOrder - right.componentOrder ||
    left.componentItemId - right.componentItemId;
}

function compareT4Chains(
  left: StatlockerT4ChainsV1['chains'][number],
  right: StatlockerT4ChainsV1['chains'][number],
): number {
  const leftKey = left.itemIds.join(',');
  const rightKey = right.itemIds.join(',');
  return leftKey.localeCompare(rightKey) || left.sampleSize - right.sampleSize;
}

function exactPositiveIntegerArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value)) throw new Error(`Fixture capture ${label} must be an array`);
  const normalized = value.map((entry) => positiveInteger(entry, label));
  const unique = [...new Set(normalized)];
  if (unique.length !== normalized.length) throw new Error(`Fixture capture ${label} must contain unique values`);
  return unique.sort((a, b) => a - b);
}

function optionalPositiveIntegerArray(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  return exactPositiveIntegerArray(value, label);
}

function uniqueSortedPositiveIntegers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
}

function pickRecord(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (value[key] !== undefined) result[key] = cloneJson(value[key]);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`Fixture capture ${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Fixture capture ${label} must be a non-negative integer`);
  return Number(value);
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Fixture capture ${label} must be a non-negative number`);
  }
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Fixture capture missing ${label}`);
  return value.trim();
}

function sha256String(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`Fixture capture invalid ${label}`);
  return value.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${describeError(error)}\n`);
    process.exitCode = 1;
  });
}
