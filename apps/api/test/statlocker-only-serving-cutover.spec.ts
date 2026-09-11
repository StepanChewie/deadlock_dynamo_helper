import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', '..', relativePath), 'utf8');
}

describe('Statlocker-only recommendation serving cutover', () => {
  test('legacy live build-serving controllers are not mounted by DeadlockLiveModule', () => {
    const moduleSource = readRepoFile('api/src/deadlock-live/deadlock-live.module.ts');
    const controllersBlock = moduleSource.match(/controllers:\s*\[([\s\S]*?)\],\s*providers:/)?.[1] || '';

    expect(controllersBlock).not.toContain('HeroBuildRecommendationController');
    expect(controllersBlock).not.toContain('HeroBuildContextualV3LiveController');
    expect(controllersBlock).not.toContain('SkillBuildAnalysisController');
    expect(controllersBlock).not.toContain('HeroBuildTransitionAggregationController');
    expect(controllersBlock).not.toContain('RecommendationPolicyBuildV1Controller');
  });

  test('live ingest exposes telemetry and diagnostics but no legacy build snapshots', () => {
    const source = readRepoFile('api/src/deadlock-live/live-ingest.controller.ts');

    expect(source).not.toContain("@Get('matches/:matchId/build-recommendation')");
    expect(source).not.toContain("@Get('build-recommendations/status')");
    expect(source).not.toContain("@Get('build-recommendations')");
    expect(source).not.toContain('LiveBuildRecommendationTraversalService');
  });

  test('Recommendation Value V6 live controller is not mounted', () => {
    const source = readRepoFile('api/src/deadlock-live/recommendation-value-v6.module.ts');
    const controllersBlock = source.match(/controllers:\s*\[([\s\S]*?)\],\s*providers:/)?.[1] || '';

    expect(controllersBlock).not.toContain('RecommendationValueV6LiveController');
  });

  test('Overwolf bundle contains only the adaptive recommendation runtime', () => {
    const webpackSource = readRepoFile('overwolf-client/webpack.config.js');

    expect(webpackSource).not.toContain('skill-build-automatic-entry');
    expect(webpackSource).not.toContain('desktop-version');
    expect(webpackSource).not.toContain('live-build-hud-entry');
    expect(webpackSource).not.toContain('live-build-overlay-recovery');
    expect(webpackSource).toContain("'./src/index.ts'");
  });

  test('Overwolf runtime has no legacy recommendation acquisition path', () => {
    const indexSource = readRepoFile('overwolf-client/src/index.ts');
    const uiSource = readRepoFile('overwolf-client/src/ui.ts');

    expect(indexSource).not.toContain('/deadlock/analysis/');
    expect(indexSource).not.toContain('latestRecommendation');
    expect(indexSource).not.toContain('latestSituational');
    expect(indexSource).not.toContain('inGameSituationalUpdate');
    expect(indexSource).not.toContain('inGameUIUpdate');
    expect(indexSource).not.toContain('dynamo_warning');

    expect(uiSource).not.toContain('showHeroGuide');
    expect(uiSource).not.toContain('showSituationalPanel');
    expect(uiSource).not.toContain('legacySkillActions');
    expect(uiSource).not.toContain('renderActiveBuild');
  });

  test('Overwolf build UIs are adaptive-only', () => {
    const inGameHtml = readRepoFile('overwolf-client/public/in_game.html');
    const desktopHtml = readRepoFile('overwolf-client/public/desktop.html');

    for (const html of [inGameHtml, desktopHtml]) {
      expect(html).not.toContain('build-select');
      expect(html).not.toContain('phase-early');
      expect(html).not.toContain('phase-mid');
      expect(html).not.toContain('phase-late');
      expect(html).not.toContain('guide-skills');
      expect(html).not.toContain('PRO FALLBACK');
      expect(html).not.toContain('MODEL V6');
    }

    expect(inGameHtml).toContain('Statlocker Adaptive');
    expect(desktopHtml).toContain('Statlocker Adaptive');
  });

  test('production deploy never promotes or verifies legacy V6 serving', () => {
    const deployWorkflow = readRepoFile('../.github/workflows/deploy.yml');
    const composeSource = readRepoFile('../docker-compose.yml');

    expect(deployWorkflow).not.toContain('promote-recommendation-value-v6-live.sh');
    expect(deployWorkflow).not.toContain('recommendation-value-v6-live/status');
    expect(deployWorkflow).not.toContain('deadlock/live/build-recommendations/status');
    expect(deployWorkflow).toContain('/deadlock/adaptive/v1/status');
    expect(composeSource).not.toContain('recommendation-value-v6-live/status');
    expect(composeSource).toContain('/deadlock/adaptive/v1/status');
  });

  test('adaptive client remains pinned to the V2 recommendation endpoint', () => {
    const adaptiveClientSource = readRepoFile('overwolf-client/src/adaptive-recommendation-client.ts');

    expect(adaptiveClientSource).toContain('/deadlock/adaptive/v2/recommend');
    expect(adaptiveClientSource).not.toContain('/deadlock/adaptive/v1/recommend');
  });
});
