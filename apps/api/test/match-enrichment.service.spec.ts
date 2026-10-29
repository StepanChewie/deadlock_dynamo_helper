import axios from 'axios';
import { Brackets } from 'typeorm';
import { MatchEnrichmentService } from '../src/match-history/match-enrichment.service';
import { MatchHistoryV1Entity } from '../src/match-history/entities/match-history-v1.entity';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const METADATA_URL = 'https://api.deadlock-api.com/v1/matches/metadata';

function pendingMatch(over: Partial<MatchHistoryV1Entity> = {}): MatchHistoryV1Entity {
  return {
    matchId: '126485785', localSteamId: '765', players: [], enrichmentStatus: 'PENDING',
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
    update: jest.fn().mockResolvedValue(undefined),
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

  it('fetches one batched metadata request and stores the matched entry as DONE', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    const entry = { match_id: 126485785, winning_team: 'Team1', start_time: 1 };
    mockedAxios.get.mockResolvedValueOnce({ status: 200, data: [entry] });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${METADATA_URL}?match_ids=126485785`,
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(repo.update.mock.calls[0][0]).toBe('126485785');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE', enrichment: entry });
  });

  it('marks ids absent from the metadata array NOT_FOUND without touching attempts', async () => {
    const { service, repo } = makeService();
    // Sanitized GEP ids may contain non-digits: sent as-is, never matched.
    withCandidates(repo, [
      pendingMatch({ matchId: '126485785' }),
      pendingMatch({ matchId: 'sanitized-id', enrichmentAttempts: 3 }),
    ]);
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: [{ match_id: 126485785, winning_team: 'Team1' }],
    });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledWith(`${METADATA_URL}?match_ids=126485785,sanitized-id`, expect.anything());
    expect(repo.update.mock.calls[0][0]).toBe('126485785');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE' });
    expect(repo.update.mock.calls[1][0]).toBe('sanitized-id');
    expect(repo.update.mock.calls[1][1]).toEqual({ enrichmentStatus: 'NOT_FOUND', updatedAt: expect.any(Date) });
  });

  it('marks every candidate NOT_FOUND when the whole request 404s', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch({ matchId: '126485785' }), pendingMatch({ matchId: '126485786' })]);
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 404 } });

    await service.enrichPending();

    expect(repo.update).toHaveBeenCalledTimes(2);
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'NOT_FOUND' });
    expect(repo.update.mock.calls[1][1]).toMatchObject({ enrichmentStatus: 'NOT_FOUND' });
  });

  it('retries keyless once when the configured key is rejected (401)', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch()]);
    process.env.DEADLOCK_API_KEY = 'dead-key';
    mockedAxios.get
      .mockRejectedValueOnce({ response: { status: 401 } })
      .mockResolvedValueOnce({ status: 200, data: [{ match_id: 126485785, winning_team: 'Team1' }] });

    await service.enrichPending();

    expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    expect(mockedAxios.get.mock.calls[0][0]).toBe(`${METADATA_URL}?match_ids=126485785`);
    expect(mockedAxios.get.mock.calls[0][1]).toMatchObject({ headers: { 'X-API-KEY': 'dead-key' } });
    expect(mockedAxios.get.mock.calls[1][0]).toBe(`${METADATA_URL}?match_ids=126485785`);
    expect(mockedAxios.get.mock.calls[1][1]).not.toHaveProperty('headers');
    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'DONE' });
  });

  it('marks every candidate FAILED and counts the attempt on 429', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [
      pendingMatch({ matchId: '126485785', enrichmentAttempts: 2 }),
      pendingMatch({ matchId: '126485786', enrichmentAttempts: 0 }),
    ]);
    mockedAxios.get.mockRejectedValueOnce({ response: { status: 429 } });

    await service.enrichPending();

    expect(repo.update.mock.calls[0][1]).toMatchObject({ enrichmentStatus: 'FAILED', enrichmentAttempts: 3 });
    expect(repo.update.mock.calls[1][1]).toMatchObject({ enrichmentStatus: 'FAILED', enrichmentAttempts: 1 });
  });

  it('does not abort the batch when one candidate update fails', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, [pendingMatch({ matchId: '126485785' }), pendingMatch({ matchId: '126485786' })]);
    mockedAxios.get.mockResolvedValueOnce({
      status: 200,
      data: [{ match_id: 126485785 }, { match_id: 126485786 }],
    });
    repo.update.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(undefined);

    await expect(service.enrichPending()).resolves.toBeUndefined();
    expect(repo.update).toHaveBeenCalledTimes(2);
  });

  it('filters every candidate by min age via a single bracketed where', async () => {
    const { service, repo } = makeService();
    withCandidates(repo, []);

    await service.enrichPending();

    const qb = repo.createQueryBuilder();
    expect(qb.where).toHaveBeenCalledTimes(1);
    expect(qb.where.mock.calls[0][0]).toBeInstanceOf(Brackets);
    expect(qb.andWhere).toHaveBeenCalledTimes(1);
    expect(qb.andWhere.mock.calls[0][1]).toEqual(
      expect.objectContaining({ minAge: expect.any(Date) }),
    );
    expect(mockedAxios.get).not.toHaveBeenCalled();
  });
});
