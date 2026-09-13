import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { GEP_TO_VALVE_ID } from './hero-id-aliases';
import {
  HeroSkillLevels,
  SKILL_BUILD_MAX_POINT_BUDGET,
  SkillBuildAnalysisService,
} from './skill-build-analysis.service';

type HeroIdSource = 'api' | 'gep';

@Controller('deadlock/analysis/heroes')
export class SkillBuildAnalysisController {
  constructor(private readonly skillBuildAnalysisService: SkillBuildAnalysisService) {}

  @Get(':heroId/skill-build')
  async getHeroSkillBuild(
    @Param('heroId') heroIdValue: string,
    @Query('maxPointBudget') maxPointBudgetValue?: string,
    @Query('levels') levelsValue?: string,
    @Query('heroIdSource') heroIdSourceValue?: string,
  ) {
    const heroId = parsePositiveSafeInteger(heroIdValue, 'heroId');
    const heroIdSource = parseHeroIdSource(heroIdSourceValue);
    const resolvedHeroId =
      heroIdSource === 'gep' ? GEP_TO_VALVE_ID[heroId] ?? heroId : heroId;
    const maxPointBudget =
      maxPointBudgetValue === undefined
        ? SKILL_BUILD_MAX_POINT_BUDGET
        : parsePositiveSafeInteger(maxPointBudgetValue, 'maxPointBudget');

    if (maxPointBudget > SKILL_BUILD_MAX_POINT_BUDGET) {
      throw new BadRequestException(
        `maxPointBudget must not exceed ${SKILL_BUILD_MAX_POINT_BUDGET}.`,
      );
    }

    const build = await this.skillBuildAnalysisService.getHeroSkillBuild(
      resolvedHeroId,
      {
        maxPointBudget,
        currentLevels: parseSkillLevels(levelsValue),
      },
    );

    return {
      ...build,
      heroId,
      resolvedHeroId,
    };
  }
}

function parseHeroIdSource(value: string | undefined): HeroIdSource {
  if (value === undefined || value === 'api') {
    return 'api';
  }
  if (value === 'gep') {
    return 'gep';
  }
  throw new BadRequestException('heroIdSource must be either api or gep.');
}

function parseSkillLevels(value: string | undefined): HeroSkillLevels | undefined {
  if (value === undefined) {
    return undefined;
  }

  const levels = value.split(',').map((part) => Number(part.trim()));
  if (
    levels.length !== 4 ||
    levels.some((level) => !Number.isSafeInteger(level) || level < 0 || level > 4)
  ) {
    throw new BadRequestException(
      'levels must contain four comma-separated integers between 0 and 4.',
    );
  }

  return {
    1: levels[0] as 0 | 1 | 2 | 3 | 4,
    2: levels[1] as 0 | 1 | 2 | 3 | 4,
    3: levels[2] as 0 | 1 | 2 | 3 | 4,
    4: levels[3] as 0 | 1 | 2 | 3 | 4,
  };
}

function parsePositiveSafeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new BadRequestException(`${field} must be a positive safe integer.`);
  }
  return parsed;
}
