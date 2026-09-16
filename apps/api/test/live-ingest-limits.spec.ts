import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { OverwolfLiveBatchDto, OverwolfLiveEventDto } from '@dynamo-lab/shared';
import { InventoryShadowReplayService } from '../src/deadlock-live/inventory-shadow-replay.service';
import { LiveIngestController } from '../src/deadlock-live/live-ingest.controller';
import { LiveInventoryEventNormalizerService } from '../src/deadlock-live/live-inventory-event-normalizer.service';
import { LiveMatchStateService } from '../src/deadlock-live/live-match-state.service';
import { RawEventLogService } from '../src/deadlock-live/raw-event-log.service';
import { RecentLiveEventsService } from '../src/deadlock-live/recent-live-events.service';

const MAX_EVENTS_PER_BATCH = 2_000;

function buildEvent(index: number): OverwolfLiveEventDto {
  return {
    receivedAt: index,
    source: 'onInfoUpdates2',
    key: 'match_clock',
    payload: `${index}`,
  };
}

describe('LiveIngestController request limits', () => {
  let controller: LiveIngestController;
  let appendEvents: jest.Mock;

  beforeEach(async () => {
    appendEvents = jest.fn().mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      controllers: [LiveIngestController],
      providers: [
        LiveMatchStateService,
        LiveInventoryEventNormalizerService,
        RecentLiveEventsService,
        { provide: RawEventLogService, useValue: { appendEvents } },
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

    controller = moduleRef.get(LiveIngestController);
  });

  function ingestedEvents(): OverwolfLiveEventDto[] {
    expect(appendEvents).toHaveBeenCalledTimes(1);
    return appendEvents.mock.calls[0][0] as OverwolfLiveEventDto[];
  }

  it('accepts a normal batch unchanged', async () => {
    await controller.ingestEvents({
      clientId: 'client',
      events: [buildEvent(1), buildEvent(2)],
    });

    expect(ingestedEvents()).toHaveLength(2);
  });

  it('answers a body without an events array with 400 instead of 500', async () => {
    // Previously this reached `.length` inside the append call and surfaced as a
    // 500, which told the caller nothing about what was wrong.
    await expect(
      controller.ingestEvents({ clientId: 'client' } as OverwolfLiveBatchDto),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(appendEvents).not.toHaveBeenCalled();
  });

  it('rejects a non-array events field', async () => {
    await expect(
      controller.ingestEvents({
        clientId: 'client',
        events: 'nope',
      } as unknown as OverwolfLiveBatchDto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('truncates an oversized batch instead of rejecting it', async () => {
    // Rejecting would be worse: the shipped client retries a rejected body
    // forever, so a 413 would block ingest entirely rather than lose the tail.
    const events = Array.from({ length: MAX_EVENTS_PER_BATCH + 25 }, (_, index) =>
      buildEvent(index),
    );

    await expect(
      controller.ingestEvents({ clientId: 'client', events }),
    ).resolves.toEqual({ ok: true });

    const ingested = ingestedEvents();
    expect(ingested).toHaveLength(MAX_EVENTS_PER_BATCH);
    expect(ingested[0].receivedAt).toBe(0);
    expect(ingested[ingested.length - 1].receivedAt).toBe(MAX_EVENTS_PER_BATCH - 1);
  });

  it('accepts an empty batch as a no-op rather than failing the client', async () => {
    await expect(
      controller.ingestEvents({ clientId: 'client', events: [] }),
    ).resolves.toEqual({ ok: true });

    expect(ingestedEvents()).toHaveLength(0);
  });
});
