import { BUILD_DEBUG_V2_CLIENT_JS } from '../src/build-debug-v2/build-debug-v2.client';
import { BUILD_DEBUG_V2_HTML } from '../src/build-debug-v2/build-debug-v2.ui';

describe('Build debug V2 item presentation', () => {
  it('loads Deadlock UI item cards from the public web component bundle', () => {
    expect(BUILD_DEBUG_V2_HTML).toContain('https://unpkg.com/@deadlock-api/ui-core/dist/main/main.esm.js');
  });

  it('renders item ids through a compact icon renderer with textual fallback', () => {
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('function renderItemRef');
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('<dl-item-card');
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('variant="icon"');
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('Item ');
  });

  it('renders exact source profiles for a desired-state family', () => {
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('family.sourceProfiles');
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('playerName');
    expect(BUILD_DEBUG_V2_CLIENT_JS).toContain('accountId');
  });
});
