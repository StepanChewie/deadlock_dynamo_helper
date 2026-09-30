import axios from 'axios';
import { ReferenceDataImportService } from '../src/deadlock-live/reference-data-import.service';

describe('ReferenceDataImportService', () => {
  let previousDeadlockApiKey: string | undefined;

  beforeEach(() => {
    previousDeadlockApiKey = process.env.DEADLOCK_API_KEY;
    delete process.env.DEADLOCK_API_KEY;
    jest.spyOn(axios, 'get').mockResolvedValue({ data: [] });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousDeadlockApiKey === undefined) {
      delete process.env.DEADLOCK_API_KEY;
    } else {
      process.env.DEADLOCK_API_KEY = previousDeadlockApiKey;
    }
  });

  function createService() {
    const heroRepo = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const itemRepo = {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
    };
    const itemComponentRepo = {
      create: jest.fn((value) => value),
      save: jest.fn().mockResolvedValue(undefined),
      createQueryBuilder: jest.fn(() => ({
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      })),
    };
    const catalogContentService = {
      importAssetsSnapshot: jest.fn(),
    };
    const itemCatalogImportService = {
      getAvailableClientVersions: jest.fn().mockResolvedValue([6680, 6686]),
      importCatalogs: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReferenceDataImportService(
      heroRepo as any,
      itemRepo as any,
      itemComponentRepo as any,
      catalogContentService as any,
      itemCatalogImportService as any,
    );
    return {
      service,
      heroRepo,
      itemRepo,
      itemComponentRepo,
      catalogContentService,
      itemCatalogImportService,
    };
  }

  it('imports heroes and items from the embedded seed when tables are empty', async () => {
    const { service, heroRepo, itemRepo } = createService();

    await service.importIfNeeded();

    expect(heroRepo.save).toHaveBeenCalled();
    expect(itemRepo.save).toHaveBeenCalled();
    expect(heroRepo.create).toHaveBeenCalled();
    expect(itemRepo.create).toHaveBeenCalled();
  });

  it('imports reference data even when no local json files exist', async () => {
    const { service, heroRepo, itemRepo } = createService();

    await service.importIfNeeded();

    expect(heroRepo.save).toHaveBeenCalled();
    expect(itemRepo.save).toHaveBeenCalled();
  });

  it('attempts the assets catalog bootstrap when DEADLOCK_API_KEY is not configured', async () => {
    const { service } = createService();

    await service.importIfNeeded();

    expect(axios.get).toHaveBeenCalledWith(
      'https://api.deadlock-api.com/v1/assets/items',
      { params: { client_version: 6686 } },
    );
  });

  it('binds the immutable recommendation catalog to the exact latest client version', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: [{ id: 1, name: 'Item' }] });
    const { service, catalogContentService, itemCatalogImportService } = createService();

    await service.importIfNeeded();

    expect(itemCatalogImportService.importCatalogs).toHaveBeenCalledWith({ clientVersions: [6686] });
    expect(catalogContentService.importAssetsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      clientVersion: '6686',
      rulesetKey: 'client-6686',
    }));
  });

  describe('refreshRecommendationCatalog', () => {
    function reusableCatalog() {
      return {
        created: false,
        catalogVersionId: 'catalog-6686',
        rulesetKey: 'client-6686',
        itemCount: 726,
        recipeCount: 0,
      };
    }

    it('binds the scheduled refresh to the newest upstream client version', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: [{ id: 1, name: 'Item' }] });
      const { service, catalogContentService } = createService();
      catalogContentService.importAssetsSnapshot.mockResolvedValue(reusableCatalog());

      await service.refreshRecommendationCatalog();

      expect(axios.get).toHaveBeenCalledWith(
        'https://api.deadlock-api.com/v1/assets/items',
        { params: { client_version: 6686 } },
      );
      expect(catalogContentService.importAssetsSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        clientVersion: '6686',
        rulesetKey: 'client-6686',
      }));
    });

    // The refresh exists to notice a new payload, not to re-run the legacy item sync.
    // `syncItemsFromAssets` deletes and re-inserts `item_components`, and nothing on the
    // recommendation path reads that table, so a background tick must never touch it.
    it('never runs the destructive legacy item sync on a background tick', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: [{ id: 1, name: 'Item' }] });
      const { service, catalogContentService, itemCatalogImportService, itemComponentRepo } = createService();
      catalogContentService.importAssetsSnapshot.mockResolvedValue(reusableCatalog());

      await service.refreshRecommendationCatalog();

      expect(itemCatalogImportService.importCatalogs).not.toHaveBeenCalled();
      expect(itemComponentRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('does nothing when upstream reports no client versions at all', async () => {
      const { service, catalogContentService, itemCatalogImportService } = createService();
      itemCatalogImportService.getAvailableClientVersions.mockResolvedValue([]);

      await service.refreshRecommendationCatalog();

      expect(axios.get).not.toHaveBeenCalled();
      expect(catalogContentService.importAssetsSnapshot).not.toHaveBeenCalled();
    });

    it('does nothing when the assets endpoint returns no rows', async () => {
      (axios.get as jest.Mock).mockResolvedValue({ data: [] });
      const { service, catalogContentService } = createService();

      await service.refreshRecommendationCatalog();

      expect(catalogContentService.importAssetsSnapshot).not.toHaveBeenCalled();
    });

    it('swallows an upstream failure instead of rejecting the tick', async () => {
      (axios.get as jest.Mock).mockRejectedValue(new Error('502 Bad Gateway'));
      const { service } = createService();

      await expect(service.refreshRecommendationCatalog()).resolves.toBeUndefined();
    });

    it('skips a tick while the previous refresh is still in flight', async () => {
      let reachedAxios: () => void = () => {};
      const axiosReached = new Promise<void>((resolve) => {
        reachedAxios = resolve;
      });
      let releaseAxios: (value: unknown) => void = () => {};
      (axios.get as jest.Mock).mockImplementation(() => {
        reachedAxios();
        return new Promise((resolve) => {
          releaseAxios = resolve;
        });
      });
      const { service, itemCatalogImportService } = createService();

      const first = service.refreshRecommendationCatalog();
      await axiosReached;
      await service.refreshRecommendationCatalog();

      expect(itemCatalogImportService.getAvailableClientVersions).toHaveBeenCalledTimes(1);

      releaseAxios({ data: [] });
      await first;
    });
  });
});
