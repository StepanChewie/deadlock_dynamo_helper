import { REQUIRED_FEATURES, setRequiredFeatures } from './set-required-features';

type Callback = (result: any) => void;

function mockOverwolf(impl: (features: string[], callback: Callback) => void): jest.Mock {
  const setRequiredFeaturesMock = jest.fn(impl);
  (globalThis as any).overwolf = {
    games: { events: { setRequiredFeatures: setRequiredFeaturesMock } },
  };
  return setRequiredFeaturesMock;
}

afterEach(() => {
  delete (globalThis as any).overwolf;
});

describe('setRequiredFeatures', () => {
  it('requests gep_internal alongside the core features', () => {
    expect(REQUIRED_FEATURES).toEqual(['game_info', 'match_info', 'gep_internal']);
  });

  it('reports everything as registered when the GEP binds the whole set', async () => {
    const calls: string[][] = [];
    const setRequiredFeaturesMock = mockOverwolf((features, callback) => {
      calls.push(features);
      callback({
        success: true,
        supportedFeatures: ['game_info', 'match_info', 'gep_internal'],
      });
    });

    const result = await setRequiredFeatures();

    expect(setRequiredFeaturesMock).toHaveBeenCalledTimes(1);
    expect(calls[0]).toEqual(['game_info', 'match_info', 'gep_internal']);
    expect(result.requested).toEqual(['game_info', 'match_info', 'gep_internal']);
    expect(result.registered).toEqual(['game_info', 'match_info', 'gep_internal']);
    expect(result.rejected).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.degradedReason).toBeUndefined();
  });

  it('falls back to the core set when the full set is rejected', async () => {
    const calls: string[][] = [];
    mockOverwolf((features, callback) => {
      calls.push(features);
      if (calls.length === 1) {
        callback({ success: false, error: 'gep_internal is not a supported feature' });
        return;
      }
      callback({ success: true, supportedFeatures: ['game_info', 'match_info'] });
    });

    const result = await setRequiredFeatures();

    // The trap this guards: the previous implementation rejected the whole
    // promise on the first failure, so an unsupported optional feature took
    // game_info and match_info — the entire app — down with it.
    expect(calls[0]).toEqual(['game_info', 'match_info', 'gep_internal']);
    expect(calls[1]).toEqual(['game_info', 'match_info']);
    expect(result.registered).toEqual(['game_info', 'match_info']);
    expect(result.rejected).toEqual(['gep_internal']);
    expect(result.degraded).toBe(true);
    expect(result.degradedReason).toContain('gep_internal');
  });

  it('does not retry when the call succeeds but a feature was not bound', async () => {
    const setRequiredFeaturesMock = mockOverwolf((_features, callback) => {
      callback({ success: true, supportedFeatures: ['game_info', 'match_info'] });
    });

    const result = await setRequiredFeatures();

    expect(setRequiredFeaturesMock).toHaveBeenCalledTimes(1);
    expect(result.registered).toEqual(['game_info', 'match_info']);
    expect(result.rejected).toEqual(['gep_internal']);
    expect(result.degraded).toBe(true);
    // No retry happened, so there is no first-attempt failure to explain.
    expect(result.degradedReason).toBeUndefined();
  });

  it('trusts the success flag when the build reports no supportedFeatures', async () => {
    // Normal at app start, before any game is running.
    mockOverwolf((_features, callback) => {
      callback({ success: true });
    });

    const result = await setRequiredFeatures();

    expect(result.registered).toEqual(['game_info', 'match_info', 'gep_internal']);
    expect(result.rejected).toEqual([]);
    expect(result.degraded).toBe(false);
    expect(result.supported).toEqual([]);
  });

  it('rejects when both attempts fail, leaving retries to the caller', async () => {
    const setRequiredFeaturesMock = mockOverwolf((_features, callback) => {
      callback({ success: false, error: 'no game is running' });
    });

    await expect(setRequiredFeatures()).rejects.toThrow('no game is running');
    expect(setRequiredFeaturesMock).toHaveBeenCalledTimes(2);
  });

  it('rejects when the Overwolf API is unavailable', async () => {
    delete (globalThis as any).overwolf;

    await expect(setRequiredFeatures()).rejects.toThrow('Overwolf API is not available');
  });
});
