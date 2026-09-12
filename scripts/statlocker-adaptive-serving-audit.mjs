import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const adaptiveRoot = path.join(repoRoot, 'apps/api/src/statlocker-adaptive');
const overwolfClientPath = path.join(
  repoRoot,
  'apps/overwolf-client/src/adaptive-recommendation-client.ts',
);
const overwolfIndexPath = path.join(repoRoot, 'apps/overwolf-client/src/index.ts');
const legacyEnginePath = path.join(
  repoRoot,
  'apps/api/src/deadlock-live/recommendation-engine-v8.service.ts',
);

const forbiddenServingDependencies = [
  'RecommendationBehavioral',
  'RecommendationValue',
  'RecommendationPolicy',
  'RecommendationRealtimeCoordinatorV8',
  'RecommendationEngineV8',
  'RecommendationRealtimeStateV8',
];

const forbiddenSecretPatterns = [
  /cookies\s*\(/i,
  /localStorage/i,
  /X-API-Key/i,
  /authorization/i,
];

function fail(message) {
  console.error(`Statlocker adaptive serving audit: FAIL: ${message}`);
  process.exitCode = 1;
}

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.ts') ? [fullPath] : [];
  });
}

if (!fs.existsSync(adaptiveRoot)) {
  fail(`missing adaptive runtime directory: ${path.relative(repoRoot, adaptiveRoot)}`);
} else {
  for (const filePath of walkFiles(adaptiveRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const relativePath = path.relative(repoRoot, filePath);

    for (const dependency of forbiddenServingDependencies) {
      if (source.includes(dependency)) {
        fail(`${relativePath} references forbidden ML serving dependency ${dependency}`);
      }
    }

    for (const pattern of forbiddenSecretPatterns) {
      if (pattern.test(source)) {
        fail(`${relativePath} contains forbidden secret extraction token ${pattern}`);
      }
    }
  }
}

if (!fs.existsSync(overwolfClientPath)) {
  fail('missing Overwolf adaptive recommendation client');
} else {
  const adaptiveClientSource = fs.readFileSync(overwolfClientPath, 'utf8');
  if (!adaptiveClientSource.includes('/deadlock/adaptive/v2/recommend')) {
    fail('Overwolf adaptive client does not target /deadlock/adaptive/v2/recommend');
  }
  if (adaptiveClientSource.includes('/deadlock/adaptive/v1/recommend')) {
    fail('Overwolf adaptive client still targets the retired V1 recommendation endpoint');
  }
}

if (!fs.existsSync(overwolfIndexPath)) {
  fail('missing Overwolf primary entrypoint');
} else {
  const overwolfIndexSource = fs.readFileSync(overwolfIndexPath, 'utf8');
  if (!overwolfIndexSource.includes('new AdaptiveRecommendationClient')) {
    fail('Overwolf primary entrypoint does not instantiate AdaptiveRecommendationClient');
  }
  const schedulesFromLiveEvent = /if\s*\(\s*!context\.matchEnded\s*&&\s*currentMatchId\s*\)\s*\{\s*scheduleAdaptiveRecommendation\([^;]*\);\s*\}/m.test(overwolfIndexSource);
  if (!schedulesFromLiveEvent) {
    fail('Overwolf primary recommendation trigger does not schedule adaptive recommendations');
  }
  if (overwolfIndexSource.includes('/deadlock/analysis/recommend')) {
    fail('Overwolf primary entrypoint still references the legacy recommendation endpoint');
  }
}

if (!fs.existsSync(legacyEnginePath)) {
  fail('legacy RecommendationEngineV8 source is unexpectedly absent');
}

if (!process.exitCode) {
  console.log('Statlocker adaptive serving audit: PASS');
}
