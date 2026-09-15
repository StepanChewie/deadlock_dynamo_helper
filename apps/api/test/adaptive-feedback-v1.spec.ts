import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdaptiveFeedbackV1Entity } from '../src/deadlock-live/entities/adaptive-feedback-v1.entity';
import {
  AdaptiveFeedbackV1Controller,
  ADAPTIVE_FEEDBACK_REASONS_V1,
} from '../src/statlocker-adaptive/adaptive-feedback-v1.controller';

function createController() {
  const inserted: Array<Partial<AdaptiveFeedbackV1Entity>> = [];
  const repository = {
    insert: async (row: Partial<AdaptiveFeedbackV1Entity>) => {
      inserted.push(row);
      return { identifiers: [{ id: '1' }], generatedMaps: [], raw: [] };
    },
  };

  return {
    controller: new AdaptiveFeedbackV1Controller(repository as never),
    inserted,
  };
}

describe('AdaptiveFeedbackV1Controller', () => {
  it('records a useful vote against the match', async () => {
    const { controller, inserted } = createController();

    const response = await controller.submit({
      appVersion: '0.1.15',
      matchId: 'match-1',
      useful: true,
      requestId: 'req-1',
    });

    expect(response).toEqual({ accepted: true });
    expect(inserted).toEqual([
      {
        appVersion: '0.1.15',
        matchId: 'match-1',
        useful: true,
        reason: null,
        requestId: 'req-1',
      },
    ]);
  });

  it('records an allowlisted reason on a negative vote', async () => {
    const { controller, inserted } = createController();

    await controller.submit({
      matchId: 'match-1',
      useful: false,
      reason: 'Bad order',
    });

    expect(inserted[0].reason).toBe('Bad order');
  });

  it('drops a reason outside the allowlist instead of storing it', async () => {
    const { controller, inserted } = createController();

    await controller.submit({
      matchId: 'match-1',
      useful: false,
      reason: 'something the client invented',
    });

    expect(inserted[0].reason).toBeNull();
  });

  it('accepts every reason the client offers', async () => {
    for (const reason of ADAPTIVE_FEEDBACK_REASONS_V1) {
      const { controller, inserted } = createController();

      await controller.submit({ matchId: 'match-1', useful: false, reason });

      expect(inserted[0].reason).toBe(reason);
    }
  });

  it('stores no player identifier', async () => {
    const { controller, inserted } = createController();

    await controller.submit({
      matchId: 'match-1',
      useful: true,
      steamId: '76561198000000000',
      localSteamId: '76561198000000000',
    } as never);

    expect(Object.keys(inserted[0]).sort()).toEqual(
      ['appVersion', 'matchId', 'reason', 'requestId', 'useful'].sort(),
    );
  });

  it('falls back to an unknown version rather than rejecting the vote', async () => {
    const { controller, inserted } = createController();

    await controller.submit({ matchId: 'match-1', useful: true });

    expect(inserted[0].appVersion).toBe('unknown');
  });

  it('rejects a vote without a match id', async () => {
    const { controller, inserted } = createController();

    await expect(controller.submit({ useful: true })).rejects.toThrow(BadRequestException);
    expect(inserted).toHaveLength(0);
  });

  it('rejects a vote whose useful flag is not a boolean', async () => {
    const { controller, inserted } = createController();

    await expect(
      controller.submit({ matchId: 'match-1', useful: 'yes' } as never),
    ).rejects.toThrow(BadRequestException);
    expect(inserted).toHaveLength(0);
  });

  it('offers the client exactly the reasons this endpoint accepts', () => {
    const desktop = readFileSync(
      join(__dirname, '..', '..', 'overwolf-client', 'public', 'desktop.html'),
      'utf8',
    );

    for (const reason of ADAPTIVE_FEEDBACK_REASONS_V1) {
      const asInlineHandlerArgument = `'${reason.replace(/'/g, "\\'")}'`;
      expect(desktop).toContain(asInlineHandlerArgument);
    }
  });
});
