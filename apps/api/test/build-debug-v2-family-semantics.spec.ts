import { BUILD_DEBUG_V2_CLIENT_JS } from '../src/build-debug-v2/build-debug-v2.client';
import { BUILD_DEBUG_V2_HTML } from '../src/build-debug-v2/build-debug-v2.ui';

const REQUIRED_LABELS = [
  'Family progression',
  'REQUIRED / CHOICE / OPTIONAL / SITUATIONAL',
  'Default terminal',
  'Optional terminal WPA decision',
  'Desired build state',
  'Semantic validation',
  'Anti-churn / family-regression rejection',
] as const;

describe('Build debugger V2 family-first semantics', () => {
  it('exposes explicit family-first labels instead of requiring reason-code reconstruction', () => {
    const debuggerSource = `${BUILD_DEBUG_V2_HTML}\n${BUILD_DEBUG_V2_CLIENT_JS}`;

    for (const label of REQUIRED_LABELS) {
      expect(debuggerSource).toContain(label);
    }
  });
});
