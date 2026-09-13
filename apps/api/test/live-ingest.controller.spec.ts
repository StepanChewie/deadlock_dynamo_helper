import { Test } from '@nestjs/testing';
import { InventoryShadowReplayService } from '../src/deadlock-live/inventory-shadow-replay.service';
import { LiveIngestController } from '../src/deadlock-live/live-ingest.controller';
import { LiveInventoryEventNormalizerService } from '../src/deadlock-live/live-inventory-event-normalizer.service';
import { LiveMatchStateService } from '../src/deadlock-live/live-match-state.service';
import { RawEventLogService } from '../src/deadlock-live/raw-event-log.service';
import { RecentLiveEventsService } from '../src/deadlock-live/recent-live-events.service';

describe('LiveIngestController', () => {
  it('ingests events and exposes state and recent events', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LiveIngestController],
      providers: [
        LiveMatchStateService,
        LiveInventoryEventNormalizerService,
        RecentLiveEventsService,
        {
          provide: RawEventLogService,
          useValue: { appendEvents: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: InventoryShadowReplayService,
          useValue: {
            applyBatch: jest.fn(),
            getMatchTimelines: jest.fn().mockReturnValue([]),
            getPlayerTimeline: jest.fn().mockReturnValue(undefined),
          },
        },
      ],
    }).compile();

    const controller = moduleRef.get(LiveIngestController);

    await controller.ingestEvents({
      clientId: 'client',
      events: [{ receivedAt: 1, source: 'onInfoUpdates2', key: 'match_id', payload: 'm1' }],
    });

    expect(controller.getStates()).toHaveLength(1);
    expect(controller.getRecentEvents()).toHaveLength(1);
  });
});
