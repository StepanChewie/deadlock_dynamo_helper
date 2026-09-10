import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { In, Repository } from 'typeorm';
import { AppDataSource } from '../database/data-source';
import { AdaptiveRecommendationDecisionV1Entity } from '../deadlock-live/entities/adaptive-recommendation-decision-v1.entity';
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

type StatlockerFixtureDataset =
  | 'WPA_PATCH_DATA'
  | 'T4_CHAINS'
  | 'HERO_LEADERBOARD'
  | 'PRO_BUILD_ANALYSIS';

export interface CaptureStatlockerBuildV2FixtureArgs {
  heroId: number;
  matchId: string;
  out: string;
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

interface FixtureReplayDecisionV2 {
  state: {
    decisionId: string;
    matchId: string;
    playerSlot: number;
    gameTimeSec: number;
    rulesetId: string;
    heroId: number;
    ownedItemIds: readonly number[];
    spendableSouls: Record<string, unknown>;
    shopOpportunity: Record<string, unknown>;
  };
  catalogVersionId?: string;
  catalogSha256?: string;
  rulesetId?: string;
  allyHeroIds?: readonly number[];
  enemyHeroIds: readonly number[];
  enemyHeroes?: readonly Record<string, unknown>[];
  enemyLiveStates?: readonly Record<string, unknown>[];
  allyItemIds?: readonly number[];
  enemyItemIds?: readonly number[];
  ourTeamSouls?: number;
  enemyTeamSouls?: number;
  slots?: Record<string, unknown>;
  investment?: Record<string, unknown>;
  economyRules?: Record<string, unknown>;
  economyRulesEvidence?: string;
  stateRevision?: string;
}

interface FixtureLiveReplayV2 {
  decisionId: string;
  matchId: string;
  decidedAt: string;
  replayInput: {
    decision: FixtureReplayDecisionV2;
    evidence?: Record<string, unknown>;
  };
}

interface FixtureSnapshotProvenanceV2 {
  dataset: string;
  scopeKey: string;
  snapshotId: string;
  contentSha256: string;
  fetchedAt: string;
}

export interface StatlockerBuildV2FixtureSourceInput {
  heroId: number;
  requestedMatchId: string;
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
  liveReplay: FixtureLiveReplayV2;
  snapshotProvenance?: readonly FixtureSnapshotProvenanceV2[];
}

export interface StatlockerBuildV2Fixture {
  metadata: {
    contract: 'STATLOCKER_BUILD_V2_REAL_FIXTURE_1';
    source: 'EXISTING_DATABASE';
    heroId: number;
    requestedMatchId: string;
    matchId: string;
    decisionId: string;
    decidedAt: string;
    identity: FixtureIdentityV2;
    snapshotProvenance: readonly FixtureSnapshotProvenanceV2[];
  };
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
  liveState: FixtureReplayDecisionV2;
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

  const heroId = Number(values.get('heroId'));
  const matchId = values.get('matchId')?.trim();
  const out = values.get('out')?.trim();
  if (!Number.isSafeInteger(heroId) || heroId <= 0) {
    throw new Error('Fixture capture requires a positive integer --heroId');
  }
  if (!matchId) throw new Error('Fixture capture requires --matchId');
  if (!/^\d+$/.test(matchId)) throw new Error('Fixture capture matchId must contain decimal digits only');
  if (!out) throw new Error('Fixture capture requires --out');
  return { heroId, matchId, out };
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
  validateSourceIdentity(input);
  const topTen = selectTopTen(input.leaderboard, input.heroId);
  if (topTen.length !== REQUIRED_PROFILE_COUNT) {
    throw new Error(`Fixture capture requires exactly ${REQUIRED_PROFILE_COUNT} ranked HERO_LEADERBOARD profiles`);
  }

  const analysisByAccount = new Map<string, StatlockerProBuildAnalysisV1>();
  for (const analysis of input.proBuildAnalyses) {
    if (analysis.heroId !== input.heroId || !analysis.accountId) continue;
    if (!analysisByAccount.has(analysis.accountId)) analysisByAccount.set(analysis.accountId, analysis);
  }
  const proBuildAnalyses = topTen
    .map((profile) => analysisByAccount.get(profile.accountId))
    .filter((analysis): analysis is StatlockerProBuildAnalysisV1 => analysis !== undefined);
  if (proBuildAnalyses.length !== REQUIRED_PROFILE_COUNT) {
    throw new Error(`Fixture capture requires exactly ${REQUIRED_PROFILE_COUNT} ranked PRO_BUILD_ANALYSIS profiles`);
  }

  const liveState = sanitizeLiveReplayDecision(input.liveReplay, input.heroId, input.requestedMatchId);
  const enemyHeroIds = uniqueSortedPositiveIntegers(liveState.enemyHeroIds);
  if (enemyHeroIds.length !== REQUIRED_ENEMY_ROSTER_SIZE) {
    throw new Error(`Fixture capture requires a complete enemy roster of ${REQUIRED_ENEMY_ROSTER_SIZE} unique heroes`);
  }

  const wpaPatchData: StatlockerWpaPatchDataV1 = {
    patchId: input.wpaPatchData.patchId,
    items: input.wpaPatchData.items
      .filter((item) => item.heroId === input.heroId)
      .map(cloneJson)
      .sort((left, right) => left.itemId - right.itemId),
  };
  const t4Chains: StatlockerT4ChainsV1 = {
    chains: input.t4Chains.chains
      .filter((chain) => chain.heroId === input.heroId)
      .map((chain) => ({ ...cloneJson(chain), itemIds: [...chain.itemIds].sort((a, b) => a - b) }))
      .sort(compareT4Chains),
  };
  const enemySet = new Set(enemyHeroIds);
  const vsHeroWpaRows = input.vsHeroWpaRows
    .filter((row) =>
      row.heroId === input.heroId &&
      row.statlockerPatchId === input.identity.statlockerPatchId &&
      row.rulesetVersion === input.identity.rulesetVersion &&
      row.catalogSha256.toLowerCase() === input.identity.catalogSha256.toLowerCase() &&
      enemySet.has(row.enemyHeroId),
    )
    .map(cloneJson)
    .sort(compareVsHeroRows);

  const relevantItemIds = collectRelevantItemIds({
    proBuildAnalyses,
    wpaPatchData,
    t4Chains,
    vsHeroWpaRows,
    liveState,
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
      source: 'EXISTING_DATABASE',
      heroId: input.heroId,
      requestedMatchId: input.requestedMatchId,
      matchId: liveState.state.matchId,
      decisionId: input.liveReplay.decisionId,
      decidedAt: input.liveReplay.decidedAt,
      identity: {
        ...input.identity,
        catalogSha256: input.identity.catalogSha256.toLowerCase(),
      },
      snapshotProvenance,
    },
    leaderboard: {
      heroId: input.heroId,
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
    liveState,
  };
}

async function main(): Promise<void> {
  const args = parseCaptureStatlockerBuildV2FixtureArgs(process.argv.slice(2));
  await AppDataSource.initialize();
  try {
    const source = await loadFixtureSourceFromDatabase(args);
    const fixture = buildStatlockerBuildV2Fixture(source);
    const outputPath = resolve(process.cwd(), args.out);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
    process.stdout.write(
      `Captured Statlocker Build V2 fixture: hero=${fixture.metadata.heroId} match=${fixture.metadata.matchId} profiles=${fixture.proBuildAnalyses.length} wpaRows=${fixture.vsHeroWpaRows.length} out=${outputPath}\n`,
    );
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

async function loadFixtureSourceFromDatabase(
  args: CaptureStatlockerBuildV2FixtureArgs,
): Promise<StatlockerBuildV2FixtureSourceInput> {
  const replayRepo = AppDataSource.getRepository(AdaptiveRecommendationDecisionV1Entity);
  const snapshotRepo = AppDataSource.getRepository(StatlockerEvidenceSnapshotV1Entity);
  const wpaRepo = AppDataSource.getRepository(StatlockerVsHeroWpaRowV1Entity);
  const catalogVersionRepo = AppDataSource.getRepository(RecommendationItemCatalogVersionV1);
  const catalogItemRepo = AppDataSource.getRepository(RecommendationItemCatalogItemV1);
  const catalogRecipeRepo = AppDataSource.getRepository(RecommendationItemCatalogRecipeV1);

  const liveReplay = await loadLiveReplay(replayRepo, args.heroId, args.matchId);
  const decision = parseReplayDecision(liveReplay.replayInput.decision);
  const evidence = liveReplay.replayInput.evidence ?? {};
  const statlockerPatchId = nonEmptyString(evidence.statlockerPatchId, 'saved replay Statlocker patch identity');
  const rulesetVersion = nonEmptyString(decision.rulesetId ?? decision.state.rulesetId, 'saved replay ruleset identity');
  const catalogSha256 = sha256String(decision.catalogSha256, 'saved replay catalog identity');
  const identity: FixtureIdentityV2 = { rulesetVersion, catalogSha256, statlockerPatchId };
  const scopeInput = { heroId: args.heroId, statlockerPatchId };

  const leaderboardRow = await loadLatestSnapshot(snapshotRepo, {
    dataset: 'HERO_LEADERBOARD',
    scopeKey: statlockerFixtureScope('HERO_LEADERBOARD', scopeInput),
    ...identity,
  });
  const leaderboard = parseLeaderboard(leaderboardRow.payload, args.heroId);
  const topTen = selectTopTen(leaderboard, args.heroId);
  if (topTen.length !== REQUIRED_PROFILE_COUNT) {
    throw new Error(`Fixture capture requires exactly ${REQUIRED_PROFILE_COUNT} ranked HERO_LEADERBOARD profiles for hero ${args.heroId}`);
  }

  const profileRows: StatlockerEvidenceSnapshotV1Entity[] = [];
  const proBuildAnalyses: StatlockerProBuildAnalysisV1[] = [];
  for (const profile of topTen) {
    const row = await loadLatestSnapshot(snapshotRepo, {
      dataset: 'PRO_BUILD_ANALYSIS',
      scopeKey: statlockerFixtureScope('PRO_BUILD_ANALYSIS', { ...scopeInput, accountId: profile.accountId }),
      ...identity,
    });
    profileRows.push(row);
    proBuildAnalyses.push(parseProBuild(row.payload, args.heroId, profile.accountId));
  }

  const [wpaPatchRow, t4Row] = await Promise.all([
    loadLatestSnapshot(snapshotRepo, {
      dataset: 'WPA_PATCH_DATA',
      scopeKey: statlockerFixtureScope('WPA_PATCH_DATA', scopeInput),
      ...identity,
    }),
    loadLatestSnapshot(snapshotRepo, {
      dataset: 'T4_CHAINS',
      scopeKey: statlockerFixtureScope('T4_CHAINS', scopeInput),
      ...identity,
    }),
  ]);
  const enemyHeroIds = uniqueSortedPositiveIntegers(decision.enemyHeroIds);
  if (enemyHeroIds.length !== REQUIRED_ENEMY_ROSTER_SIZE) {
    throw new Error(`Fixture capture requires a complete enemy roster of ${REQUIRED_ENEMY_ROSTER_SIZE} unique heroes in saved replay ${liveReplay.decisionId}`);
  }
  const vsHeroWpaRows = await wpaRepo.find({
    where: {
      statlockerPatchId: identity.statlockerPatchId,
      rulesetVersion: identity.rulesetVersion,
      catalogSha256: identity.catalogSha256,
      heroId: args.heroId,
      enemyHeroId: In(enemyHeroIds),
    },
    order: { enemyHeroId: 'ASC', itemId: 'ASC', rankBucket: 'ASC', snapshotId: 'ASC' },
  });
  if (vsHeroWpaRows.length === 0) {
    throw new Error(`Fixture capture found no compatible VS_HERO_WPA rows for hero ${args.heroId} and match ${args.matchId}`);
  }

  const catalogVersion = await catalogVersionRepo.findOne({
    where: { rulesetKey: identity.rulesetVersion, payloadSha256: identity.catalogSha256 },
  });
  if (!catalogVersion) {
    throw new Error(`Fixture capture could not resolve catalog ${identity.catalogSha256} for ruleset ${identity.rulesetVersion}`);
  }
  const contentCatalogVersionId = resolveFixtureCatalogContentVersionId(catalogVersion);
  const [catalogItems, catalogRecipes] = await Promise.all([
    catalogItemRepo.find({
      where: { catalogVersionId: contentCatalogVersionId },
      order: { itemId: 'ASC' },
    }),
    catalogRecipeRepo.find({
      where: { catalogVersionId: contentCatalogVersionId },
      order: { parentItemId: 'ASC', componentOrder: 'ASC', componentItemId: 'ASC' },
    }),
  ]);
  if (catalogItems.length === 0) {
    throw new Error(`Fixture capture found no catalog items for content catalog ${contentCatalogVersionId}`);
  }

  return {
    heroId: args.heroId,
    requestedMatchId: args.matchId,
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
    liveReplay,
    snapshotProvenance: [
      leaderboardRow,
      ...profileRows,
      wpaPatchRow,
      t4Row,
    ].map(toSnapshotProvenance),
  };
}

async function loadLiveReplay(
  repository: Repository<AdaptiveRecommendationDecisionV1Entity>,
  heroId: number,
  matchId: string,
): Promise<FixtureLiveReplayV2> {
  const rows = await repository.find({
    where: { matchId },
    order: { decidedAt: 'DESC', decisionId: 'DESC' },
  });
  for (const row of rows) {
    const replayInput = row.replayInput as unknown as FixtureLiveReplayV2['replayInput'];
    if (!replayInput || typeof replayInput !== 'object') continue;
    try {
      const decision = parseReplayDecision(replayInput.decision);
      if (decision.state.heroId !== heroId || decision.state.matchId !== matchId) continue;
      if (uniqueSortedPositiveIntegers(decision.enemyHeroIds).length !== REQUIRED_ENEMY_ROSTER_SIZE) continue;
      return {
        decisionId: row.decisionId,
        matchId: row.matchId,
        decidedAt: row.decidedAt.toISOString(),
        replayInput: cloneJson(replayInput),
      };
    } catch {
      continue;
    }
  }
  throw new Error(`Fixture capture could not prove a complete enemy roster for hero ${heroId} in saved match ${matchId}`);
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
    throw new Error(`Fixture capture missing ${input.dataset} snapshot for ${input.scopeKey} at exact ruleset/catalog/patch identity`);
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

function sanitizeLiveReplayDecision(
  liveReplay: FixtureLiveReplayV2,
  heroId: number,
  requestedMatchId: string,
): FixtureReplayDecisionV2 {
  const decision = parseReplayDecision(liveReplay.replayInput.decision);
  if (decision.state.heroId !== heroId) {
    throw new Error(`Fixture capture saved replay hero ${decision.state.heroId} does not match requested hero ${heroId}`);
  }
  if (decision.state.matchId !== requestedMatchId || liveReplay.matchId !== requestedMatchId) {
    throw new Error(`Fixture capture saved replay match ${decision.state.matchId} does not match requested match ${requestedMatchId}`);
  }
  const enemyHeroIds = uniqueSortedPositiveIntegers(decision.enemyHeroIds);
  const sanitizedEnemyHeroes = (decision.enemyHeroes ?? [])
    .map((entry) => pickRecord(entry, ['heroId', 'heroName']))
    .filter((entry) => typeof entry.heroId === 'number')
    .sort((left, right) => Number(left.heroId) - Number(right.heroId));
  const sanitizedEnemyLiveStates = (decision.enemyLiveStates ?? [])
    .map((entry) => pickRecord(entry, [
      'heroId', 'level', 'souls', 'kills', 'deaths', 'assists', 'heroDamage', 'health', 'maxHealth',
    ]))
    .filter((entry) => typeof entry.heroId === 'number')
    .sort((left, right) => Number(left.heroId) - Number(right.heroId));

  return {
    state: {
      decisionId: decision.state.decisionId,
      matchId: decision.state.matchId,
      playerSlot: decision.state.playerSlot,
      gameTimeSec: decision.state.gameTimeSec,
      rulesetId: decision.state.rulesetId,
      heroId: decision.state.heroId,
      ownedItemIds: uniqueSortedPositiveIntegers(decision.state.ownedItemIds),
      spendableSouls: cloneJson(decision.state.spendableSouls),
      shopOpportunity: cloneJson(decision.state.shopOpportunity),
    },
    catalogVersionId: decision.catalogVersionId,
    catalogSha256: decision.catalogSha256,
    rulesetId: decision.rulesetId,
    allyHeroIds: uniqueSortedPositiveIntegers(decision.allyHeroIds ?? []),
    enemyHeroIds,
    enemyHeroes: sanitizedEnemyHeroes,
    enemyLiveStates: sanitizedEnemyLiveStates,
    allyItemIds: uniqueSortedPositiveIntegers(decision.allyItemIds ?? []),
    enemyItemIds: uniqueSortedPositiveIntegers(decision.enemyItemIds ?? []),
    ourTeamSouls: decision.ourTeamSouls,
    enemyTeamSouls: decision.enemyTeamSouls,
    slots: decision.slots ? cloneJson(decision.slots) : undefined,
    investment: decision.investment ? cloneJson(decision.investment) : undefined,
    economyRules: decision.economyRules ? cloneJson(decision.economyRules) : undefined,
    economyRulesEvidence: decision.economyRulesEvidence,
    stateRevision: decision.stateRevision,
  };
}

function collectRelevantItemIds(input: {
  proBuildAnalyses: readonly StatlockerProBuildAnalysisV1[];
  wpaPatchData: StatlockerWpaPatchDataV1;
  t4Chains: StatlockerT4ChainsV1;
  vsHeroWpaRows: readonly FixtureVsHeroWpaRowV2[];
  liveState: FixtureReplayDecisionV2;
  recipes: readonly FixtureCatalogRecipeV2[];
}): Set<number> {
  const ids = new Set<number>();
  for (const analysis of input.proBuildAnalyses) for (const item of analysis.items) ids.add(item.itemId);
  for (const item of input.wpaPatchData.items) ids.add(item.itemId);
  for (const chain of input.t4Chains.chains) for (const itemId of chain.itemIds) ids.add(itemId);
  for (const row of input.vsHeroWpaRows) ids.add(row.itemId);
  for (const itemId of input.liveState.state.ownedItemIds) ids.add(itemId);
  for (const itemId of input.liveState.allyItemIds ?? []) ids.add(itemId);
  for (const itemId of input.liveState.enemyItemIds ?? []) ids.add(itemId);

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

function validateSourceIdentity(input: StatlockerBuildV2FixtureSourceInput): void {
  if (!Number.isSafeInteger(input.heroId) || input.heroId <= 0) throw new Error('Fixture capture heroId must be positive');
  if (!input.requestedMatchId) throw new Error('Fixture capture requestedMatchId is required');
  if (!input.identity.rulesetVersion || !input.identity.statlockerPatchId) throw new Error('Fixture capture identity is incomplete');
  sha256String(input.identity.catalogSha256, 'fixture catalog identity');
  if (input.leaderboard.heroId !== input.heroId) throw new Error('Fixture capture leaderboard hero mismatch');
  if (input.wpaPatchData.patchId !== input.identity.statlockerPatchId) throw new Error('Fixture capture WPA patch identity mismatch');
  if (input.catalog.version.rulesetKey !== input.identity.rulesetVersion) throw new Error('Fixture capture catalog ruleset identity mismatch');
  if (input.catalog.version.payloadSha256.toLowerCase() !== input.identity.catalogSha256.toLowerCase()) {
    throw new Error('Fixture capture catalog SHA identity mismatch');
  }
}

function parseReplayDecision(value: unknown): FixtureReplayDecisionV2 {
  if (!isRecord(value) || !isRecord(value.state)) throw new Error('Fixture capture saved replay decision is invalid');
  const state = value.state;
  if (!Number.isSafeInteger(state.heroId) || !Array.isArray(value.enemyHeroIds)) {
    throw new Error('Fixture capture saved replay decision is missing hero/enemy roster');
  }
  return value as unknown as FixtureReplayDecisionV2;
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

function uniqueSortedPositiveIntegers(values: readonly number[]): number[] {
  return [...new Set(values.filter((value) => Number.isSafeInteger(value) && value > 0))].sort((a, b) => a - b);
}

function pickRecord(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (value[key] !== undefined) result[key] = cloneJson(value[key]);
  return result;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Fixture capture missing ${label}`);
  return value;
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

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
