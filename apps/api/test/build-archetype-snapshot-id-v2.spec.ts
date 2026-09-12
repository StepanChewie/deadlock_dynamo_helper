import { buildSnapshotId } from '../src/statlocker-adaptive/build-archetype-refresh-v2.service';

describe('Build archetype V2 snapshot identity', () => {
  it('does not change when only player nicknames change', () => {
    const identity = {
      rulesetVersion: 'r1',
      catalogSha256: 'a'.repeat(64),
      statlockerPatchId: 'p1',
    };
    const first = buildSnapshotId(72, identity, [
      { accountId: 'a', rank: 1, playerName: 'Alpha' },
      { accountId: 'b', rank: 2, playerName: 'Bravo' },
    ], ['archetype-b', 'archetype-a']);
    const second = buildSnapshotId(72, identity, [
      { accountId: 'a', rank: 1, playerName: 'Renamed Alpha' },
      { accountId: 'b', rank: 2, playerName: 'Renamed Bravo' },
    ], ['archetype-a', 'archetype-b']);

    expect(second).toBe(first);
  });
});
