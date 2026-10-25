import { LiveIngestController } from '../src/deadlock-live/live-ingest.controller';

describe('LiveIngestController resilience', () => {
  it('accepts live state when raw event logging fails', async () => {
    const rawEventLogService = {
      appendEvents: jest.fn().mockRejectedValue(
        Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }),
      ),
    };
    const liveMatchStateService = {
      applyBatch: jest.fn().mockReturnValue({ matchId: 'match-1' }),
    };
    const inventoryShadowReplayService = { applyBatch: jest.fn() };
    const recentLiveEventsService = { append: jest.fn() };
    const liveInventoryEventNormalizerService = {
      normalizeBatch: jest.fn((batch) => batch),
    };
    const matchHistoryService = {
      applyBatch: jest.fn().mockResolvedValue(undefined),
    };

    const controller = new LiveIngestController(
      rawEventLogService as any,
      liveMatchStateService as any,
      inventoryShadowReplayService as any,
      recentLiveEventsService as any,
      liveInventoryEventNormalizerService as any,
      matchHistoryService as any,
    );

    const batch = {
      clientId: 'client-1',
      events: [
        {
          receivedAt: 1,
          source: 'onInfoUpdates2' as const,
          key: 'match_id',
          payload: 'match-1',
        },
      ],
    };

    await expect(controller.ingestEvents(batch)).resolves.toEqual({ ok: true });
    expect(recentLiveEventsService.append).toHaveBeenCalledWith(batch.events);
    expect(liveMatchStateService.applyBatch).toHaveBeenCalled();
    expect(inventoryShadowReplayService.applyBatch).toHaveBeenCalled();
  });
});
