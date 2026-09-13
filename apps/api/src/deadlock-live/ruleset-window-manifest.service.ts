import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { GameRuleset } from './entities/game-ruleset.entity';
import { ItemCatalogVersion } from './entities/item-catalog-version.entity';
import { sha256StableJson } from './stable-json';

const ALLOWED_RULESET_STATUSES = new Set(['active', 'inactive', 'deprecated']);
const MAX_MANIFEST_ENTRIES = 1000;

export class RulesetWindowManifestEntryDto {
  clientVersion?: number;
  validFrom?: string;
  validTo?: string;
  status?: string;
  evidence?: Record<string, unknown>;
}

export class ApplyRulesetWindowManifestDto {
  source?: string;
  dryRun?: boolean;
  replaceExistingWindows?: boolean;
  requireCatalogs?: boolean;
  allowNonMonotonicVersions?: boolean;
  entries?: RulesetWindowManifestEntryDto[];
}

export interface NormalizedRulesetWindowEntry {
  clientVersion: number;
  validFrom: Date;
  validTo?: Date;
  status: string;
  evidence: Record<string, unknown>;
}

export interface RulesetWindowCandidate {
  clientVersion: number;
  validFrom?: Date;
  validTo?: Date;
  status: string;
  source: string;
}

export interface RulesetWindowConflict {
  leftClientVersion: number;
  rightClientVersion: number;
  leftValidFrom: string;
  leftValidTo?: string;
  rightValidFrom: string;
  rightValidTo?: string;
}

export interface NormalizedRulesetWindowManifest {
  entries: NormalizedRulesetWindowEntry[];
  errors: string[];
  warnings: string[];
}

interface PreparedRulesetWindowManifest {
  source: string;
  manifestHash: string;
  entries: NormalizedRulesetWindowEntry[];
  missingRulesets: number[];
  missingCatalogs: number[];
  conflicts: RulesetWindowConflict[];
  errors: string[];
  warnings: string[];
  replaceExistingWindows: boolean;
  requireCatalogs: boolean;
}

@Injectable()
export class RulesetWindowManifestService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(GameRuleset)
    private readonly rulesetRepository: Repository<GameRuleset>,
    @InjectRepository(ItemCatalogVersion)
    private readonly catalogVersionRepository: Repository<ItemCatalogVersion>,
  ) {}

  async getStatus() {
    const [rulesets, catalogs] = await Promise.all([
      this.rulesetRepository.find({ order: { clientVersion: 'ASC' } }),
      this.catalogVersionRepository.find({ order: { clientVersion: 'ASC' } }),
    ]);
    const catalogVersions = new Set(catalogs.map((catalog) => Number(catalog.clientVersion)));
    const candidates = rulesets.map(toRulesetWindowCandidate);
    const conflicts = findRulesetWindowConflicts(candidates);

    return {
      rulesetCount: rulesets.length,
      importedCatalogCount: catalogs.length,
      windowedRulesetCount: candidates.filter((candidate) => candidate.validFrom !== undefined).length,
      activeWindowCount: candidates.filter(
        (candidate) => candidate.status === 'active' && candidate.validFrom !== undefined,
      ).length,
      openEndedWindowCount: candidates.filter(
        (candidate) =>
          candidate.status === 'active' &&
          candidate.validFrom !== undefined &&
          candidate.validTo === undefined,
      ).length,
      rulesetsWithoutCatalog: candidates
        .filter((candidate) => !catalogVersions.has(candidate.clientVersion))
        .map((candidate) => candidate.clientVersion),
      conflicts,
    };
  }

  async validateManifest(dto: ApplyRulesetWindowManifestDto = {}) {
    const prepared = await this.prepareManifest(dto);
    return this.toValidationResponse(prepared);
  }

  async applyManifest(dto: ApplyRulesetWindowManifestDto = {}) {
    const prepared = await this.prepareManifest(dto);
    const validation = this.toValidationResponse(prepared);
    if (dto.dryRun === true) {
      return {
        ...validation,
        applied: false,
        dryRun: true,
      };
    }
    if (prepared.errors.length > 0) {
      throw new Error(`Ruleset window manifest is invalid: ${prepared.errors.join('; ')}`);
    }

    const appliedAt = new Date();
    const entryByClientVersion = new Map(
      prepared.entries.map((entry) => [entry.clientVersion, entry]),
    );
    const result = await this.dataSource.transaction(async (manager) => {
      const rulesetRepository = manager.getRepository(GameRuleset);
      const rulesets = await rulesetRepository.find({ order: { clientVersion: 'ASC' } });
      let cleared = 0;
      let applied = 0;

      if (prepared.replaceExistingWindows) {
        for (const ruleset of rulesets) {
          const clientVersion = Number(ruleset.clientVersion);
          if (entryByClientVersion.has(clientVersion)) {
            continue;
          }
          if (ruleset.validFrom || ruleset.validTo) {
            ruleset.validFrom = null as unknown as Date;
            ruleset.validTo = null as unknown as Date;
            ruleset.rawMetadata = {
              ...(ruleset.rawMetadata ?? {}),
              windowClearedByManifest: {
                manifestHash: prepared.manifestHash,
                source: prepared.source,
                appliedAt: appliedAt.toISOString(),
              },
            };
            await rulesetRepository.save(ruleset);
            cleared += 1;
          }
        }
      }

      for (const entry of prepared.entries) {
        const ruleset = await findRulesetByClientVersion(manager, entry.clientVersion);
        if (!ruleset) {
          throw new Error(`No ruleset exists for client version ${entry.clientVersion}`);
        }
        ruleset.validFrom = entry.validFrom;
        ruleset.validTo = entry.validTo ?? (null as unknown as Date);
        ruleset.status = entry.status;
        ruleset.rawMetadata = {
          ...(ruleset.rawMetadata ?? {}),
          windowManifest: {
            manifestHash: prepared.manifestHash,
            source: prepared.source,
            appliedAt: appliedAt.toISOString(),
            validFrom: entry.validFrom.toISOString(),
            validTo: entry.validTo?.toISOString(),
            status: entry.status,
            evidence: entry.evidence,
          },
        };
        await rulesetRepository.save(ruleset);
        applied += 1;
      }

      return { applied, cleared };
    });

    return {
      ...validation,
      applied: true,
      dryRun: false,
      appliedAt,
      appliedWindowCount: result.applied,
      clearedWindowCount: result.cleared,
    };
  }

  private async prepareManifest(
    dto: ApplyRulesetWindowManifestDto,
  ): Promise<PreparedRulesetWindowManifest> {
    const source = normalizeManifestSource(dto.source);
    const normalized = normalizeRulesetWindowManifest(
      dto.entries,
      dto.allowNonMonotonicVersions === true,
    );
    const [rulesets, catalogs] = await Promise.all([
      this.rulesetRepository.find({ order: { clientVersion: 'ASC' } }),
      this.catalogVersionRepository.find({ order: { clientVersion: 'ASC' } }),
    ]);
    const rulesetVersions = new Set(rulesets.map((ruleset) => Number(ruleset.clientVersion)));
    const catalogVersions = new Set(catalogs.map((catalog) => Number(catalog.clientVersion)));
    const entryVersions = new Set(normalized.entries.map((entry) => entry.clientVersion));
    const missingRulesets = normalized.entries
      .filter((entry) => !rulesetVersions.has(entry.clientVersion))
      .map((entry) => entry.clientVersion);
    const missingCatalogs = normalized.entries
      .filter((entry) => !catalogVersions.has(entry.clientVersion))
      .map((entry) => entry.clientVersion);
    const replaceExistingWindows = dto.replaceExistingWindows === true;
    const requireCatalogs = dto.requireCatalogs !== false;
    const proposedCandidates: RulesetWindowCandidate[] = [];

    for (const ruleset of rulesets) {
      const clientVersion = Number(ruleset.clientVersion);
      const replacement = normalized.entries.find(
        (entry) => entry.clientVersion === clientVersion,
      );
      if (replacement) {
        proposedCandidates.push({
          clientVersion,
          validFrom: replacement.validFrom,
          validTo: replacement.validTo,
          status: replacement.status,
          source: `manifest:${source}`,
        });
      } else if (!replaceExistingWindows) {
        proposedCandidates.push(toRulesetWindowCandidate(ruleset));
      }
    }
    for (const entry of normalized.entries) {
      if (!rulesetVersions.has(entry.clientVersion)) {
        proposedCandidates.push({
          clientVersion: entry.clientVersion,
          validFrom: entry.validFrom,
          validTo: entry.validTo,
          status: entry.status,
          source: `manifest:${source}`,
        });
      }
    }

    const conflicts = findRulesetWindowConflicts(proposedCandidates);
    const errors = [...normalized.errors];
    const warnings = [...normalized.warnings];
    if (!source) {
      errors.push('source is required');
    }
    if (missingRulesets.length > 0) {
      errors.push(`Missing rulesets for client versions: ${missingRulesets.join(', ')}`);
    }
    if (requireCatalogs && missingCatalogs.length > 0) {
      errors.push(`Missing catalogs for client versions: ${missingCatalogs.join(', ')}`);
    } else if (missingCatalogs.length > 0) {
      warnings.push(`Catalogs are missing for client versions: ${missingCatalogs.join(', ')}`);
    }
    if (conflicts.length > 0) {
      errors.push(
        `Overlapping active ruleset windows: ${conflicts
          .map((conflict) => `${conflict.leftClientVersion}/${conflict.rightClientVersion}`)
          .join(', ')}`,
      );
    }
    if (!replaceExistingWindows) {
      const retainedWindowVersions = rulesets
        .filter(
          (ruleset) =>
            !entryVersions.has(Number(ruleset.clientVersion)) && Boolean(ruleset.validFrom),
        )
        .map((ruleset) => Number(ruleset.clientVersion));
      if (retainedWindowVersions.length > 0) {
        warnings.push(
          `Existing windows not present in the manifest will be retained: ${retainedWindowVersions.join(', ')}`,
        );
      }
    }

    const manifestHash = sha256StableJson({
      source,
      entries: normalized.entries.map((entry) => ({
        clientVersion: entry.clientVersion,
        validFrom: entry.validFrom.toISOString(),
        validTo: entry.validTo?.toISOString(),
        status: entry.status,
        evidence: entry.evidence,
      })),
    });

    return {
      source,
      manifestHash,
      entries: normalized.entries,
      missingRulesets,
      missingCatalogs,
      conflicts,
      errors,
      warnings,
      replaceExistingWindows,
      requireCatalogs,
    };
  }

  private toValidationResponse(prepared: PreparedRulesetWindowManifest) {
    return {
      valid: prepared.errors.length === 0,
      source: prepared.source,
      manifestHash: prepared.manifestHash,
      entryCount: prepared.entries.length,
      replaceExistingWindows: prepared.replaceExistingWindows,
      requireCatalogs: prepared.requireCatalogs,
      missingRulesets: prepared.missingRulesets,
      missingCatalogs: prepared.missingCatalogs,
      conflicts: prepared.conflicts,
      errors: prepared.errors,
      warnings: prepared.warnings,
      preview: prepared.entries.map((entry) => ({
        clientVersion: entry.clientVersion,
        validFrom: entry.validFrom,
        validTo: entry.validTo,
        status: entry.status,
        evidence: entry.evidence,
      })),
    };
  }
}

export function normalizeRulesetWindowManifest(
  entries: RulesetWindowManifestEntryDto[] | undefined,
  allowNonMonotonicVersions = false,
): NormalizedRulesetWindowManifest {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { entries: [], errors: ['entries must contain at least one window'], warnings };
  }
  if (entries.length > MAX_MANIFEST_ENTRIES) {
    return {
      entries: [],
      errors: [`entries cannot contain more than ${MAX_MANIFEST_ENTRIES} windows`],
      warnings,
    };
  }

  const normalized: NormalizedRulesetWindowEntry[] = [];
  const seenVersions = new Set<number>();
  entries.forEach((entry, index) => {
    const clientVersion = normalizePositiveInteger(entry?.clientVersion);
    if (!clientVersion) {
      errors.push(`entries[${index}].clientVersion must be a positive integer`);
      return;
    }
    if (seenVersions.has(clientVersion)) {
      errors.push(`Duplicate client version ${clientVersion}`);
      return;
    }
    seenVersions.add(clientVersion);

    const validFrom = parseManifestDate(entry.validFrom, `entries[${index}].validFrom`, errors);
    const validTo =
      entry.validTo !== undefined
        ? parseManifestDate(entry.validTo, `entries[${index}].validTo`, errors)
        : undefined;
    const status = normalizeRulesetStatus(entry.status, index, errors);
    const evidence = normalizeEvidence(entry.evidence, index, errors);
    if (!validFrom || !status || !evidence) {
      return;
    }
    if (validTo && validFrom >= validTo) {
      errors.push(`entries[${index}].validFrom must be earlier than validTo`);
      return;
    }
    normalized.push({ clientVersion, validFrom, validTo, status, evidence });
  });

  normalized.sort((left, right) => left.validFrom.getTime() - right.validFrom.getTime());
  if (!allowNonMonotonicVersions) {
    for (let index = 1; index < normalized.length; index += 1) {
      if (normalized[index].clientVersion <= normalized[index - 1].clientVersion) {
        errors.push(
          `Client versions must increase with validFrom: ${normalized[index - 1].clientVersion} before ${normalized[index].clientVersion}`,
        );
      }
    }
  }

  const manifestConflicts = findRulesetWindowConflicts(
    normalized.map((entry) => ({
      clientVersion: entry.clientVersion,
      validFrom: entry.validFrom,
      validTo: entry.validTo,
      status: entry.status,
      source: 'manifest',
    })),
  );
  if (manifestConflicts.length > 0) {
    errors.push(
      `Manifest contains overlapping active windows: ${manifestConflicts
        .map((conflict) => `${conflict.leftClientVersion}/${conflict.rightClientVersion}`)
        .join(', ')}`,
    );
  }

  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous.validTo && previous.validTo < current.validFrom) {
      warnings.push(
        `Gap between client versions ${previous.clientVersion} and ${current.clientVersion}`,
      );
    }
  }

  return { entries: normalized, errors, warnings };
}

export function findRulesetWindowConflicts(
  candidates: RulesetWindowCandidate[],
): RulesetWindowConflict[] {
  const active = candidates
    .filter((candidate) => candidate.status === 'active' && candidate.validFrom !== undefined)
    .sort((left, right) => left.validFrom!.getTime() - right.validFrom!.getTime());
  const conflicts: RulesetWindowConflict[] = [];

  for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
    const left = active[leftIndex];
    const leftEnd = left.validTo?.getTime() ?? Number.POSITIVE_INFINITY;
    for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
      const right = active[rightIndex];
      const rightStart = right.validFrom!.getTime();
      if (rightStart >= leftEnd) {
        break;
      }
      conflicts.push({
        leftClientVersion: left.clientVersion,
        rightClientVersion: right.clientVersion,
        leftValidFrom: left.validFrom!.toISOString(),
        leftValidTo: left.validTo?.toISOString(),
        rightValidFrom: right.validFrom!.toISOString(),
        rightValidTo: right.validTo?.toISOString(),
      });
    }
  }

  return conflicts;
}

function toRulesetWindowCandidate(ruleset: GameRuleset): RulesetWindowCandidate {
  return {
    clientVersion: Number(ruleset.clientVersion),
    validFrom: ruleset.validFrom || undefined,
    validTo: ruleset.validTo || undefined,
    status: ruleset.status,
    source: ruleset.source,
  };
}

async function findRulesetByClientVersion(
  manager: EntityManager,
  clientVersion: number,
): Promise<GameRuleset | undefined> {
  const repository = manager.getRepository(GameRuleset);
  return (
    (await repository.findOne({ where: { rulesetKey: `client-${clientVersion}` } })) ??
    (await repository.findOne({ where: { clientVersion } })) ??
    undefined
  );
}

function normalizeManifestSource(value: string | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeRulesetStatus(
  value: string | undefined,
  index: number,
  errors: string[],
): string | undefined {
  const status = value?.trim().toLowerCase() || 'active';
  if (!ALLOWED_RULESET_STATUSES.has(status)) {
    errors.push(`entries[${index}].status must be active, inactive, or deprecated`);
    return undefined;
  }
  return status;
}

function normalizeEvidence(
  value: Record<string, unknown> | undefined,
  index: number,
  errors: string[],
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`entries[${index}].evidence must be an object`);
    return undefined;
  }
  return value;
}

function parseManifestDate(
  value: string | undefined,
  fieldName: string,
  errors: string[],
): Date | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    errors.push(`${fieldName} is required`);
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    errors.push(`${fieldName} must be a valid ISO date`);
    return undefined;
  }
  return parsed;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
