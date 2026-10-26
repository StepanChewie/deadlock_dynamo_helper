import axios from 'axios';
import { MatchEnrichmentService } from '../src/match-history/match-enrichment.service';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function pendingMatch(over: Partial<MatchHistoryV1Entity> = {}): MatchHistoryV1Entity {
  return {
    matchId: 'm1', localSteamId: '765', players: [], enrichmentStatus: 'PENDING',
    enrichmentAttempts: 0, startedAt: new Date(), lastEventAt: new Date(Date.now() - 3600_000),
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as MatchHistoryV1Entity;
}

function makeService() {
  const repo = {
    createQueryBuilder: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockResolvedValue(undefined),
    }),
  };
  const service = new MatchEnrichmentService(repo as never);
  return { service, repo };
}

function withCandidates(repo: ReturnType<typeof makeService>['repo'], matches: MatchHistoryV1Entity[]) {
  (repo.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(matches);
}

describe('MatchEnrichmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DEADLOCK_API_KEY = '';
  });

  it('stores the payload and marks DONE on 200', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: { match_id: 'm1', start_time: 1 } });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledWith(
      'https://api.deadlock-api.com/v1/matches/m1',
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(repo.update.mock.calls[0][0]).toBe('m1');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE' });
  });

  it('marks NOT_FOUND on 404', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });

    await service.enrichPending();

    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'NOT_FOUND' });
  });

  it('retries keyless once when the configured key is rejected (401)', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    process.env.DEADLOCK_API_KEY = 'dead-key';
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true } });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({ headers: { 'X-API-KEY': 'dead-key' } });
    expect(mockedAxios.get.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE' });
  });

  it('marks FAILED and counts the attempt on 429', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch({ enrichmentAttempts: 2 })]);
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 429 } });

    await service.enrichPending();

    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'FAILED', enrichmentAttempts: 3 });
  });

  it('never throws across matches when one fetch explodes', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch({ matchId: 'a' }), pendingMatch({ matchId: 'b' })]);
    mockedAxios.get
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ status: 200, data: {} });

    await expect(service.enrichPending()).resolves.toBeUndefined();
    expect(repo.update).toHaveBeenCalledTimes(2);
  });
});
