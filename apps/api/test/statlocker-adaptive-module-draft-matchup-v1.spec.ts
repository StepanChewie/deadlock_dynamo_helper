import 'reflect-metadata';
import { DraftMatchupEvidenceV1Service } from '../src/statlocker-adaptive/draft-matchup-evidence-v1.service';
import { EnemyThreatHistoryV1Service } from '../src/statlocker-adaptive/enemy-threat-history-v1.service';
import { StatlockerAdaptiveModule } from '../src/statlocker-adaptive/statlocker-adaptive.module';
import { ThreatWeightedMatchupV1Service } from '../src/statlocker-adaptive/threat-weighted-matchup-v1.service';

describe('StatlockerAdaptiveModule draft matchup wiring', () => {
  it('registers the runtime services required for threat-weighted draft matchup enrichment', () => {
    const providers = Reflect.getMetadata('providers', StatlockerAdaptiveModule) ?? [];

    expect(providers).toEqual(expect.arrayContaining([
      EnemyThreatHistoryV1Service,
      ThreatWeightedMatchupV1Service,
      DraftMatchupEvidenceV1Service,
    ]));
  });
});
