import { Body, Controller, Get, Header, Post, UseGuards } from '@nestjs/common';
import { InternalApiGuard } from '../common/internal-api.guard';
import {
  StatlockerBrowserProbeRequest,
  StatlockerBrowserProbeResult,
  StatlockerBrowserService,
} from './statlocker-browser.service';
import { STATLOCKER_SITE_LIKE_PROBE_CLIENT_JS } from './statlocker-site-like.client';
import {
  StatlockerDiscoveryResult,
  StatlockerProbeRequest,
  StatlockerProbeResponse,
  StatlockerProbeService,
  StatlockerProbeTarget,
} from './statlocker-probe.service';
import { STATLOCKER_SITE_LIKE_PROBE_HTML } from './statlocker-site-like.ui';

/**
 * The UI and its client bundle stay public so the tool can load in a browser
 * and ask for the internal key; the endpoints that do real work are guarded.
 *
 * What this closes: POST /request proxies an outbound call to statlocker.gg
 * (host-restricted to statlocker.gg + /api/*, so it is not an open SSRF, but it
 * is an anonymous request-amplification vector against a third party) and
 * POST /browser-request drives a headless Chromium, which is the most expensive
 * route in the API. GET /discover also performs outbound discovery work.
 */
@Controller('deadlock/tools/statlocker')
export class StatlockerProbeController {
  constructor(
    private readonly statlockerProbeService: StatlockerProbeService,
    private readonly statlockerBrowserService: StatlockerBrowserService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  getUi(): string {
    return injectInternalKeyBootstrap(STATLOCKER_SITE_LIKE_PROBE_HTML);
  }

  @Get('client.js')
  @Header('Content-Type', 'application/javascript; charset=utf-8')
  @Header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  getClient(): string {
    return STATLOCKER_SITE_LIKE_PROBE_CLIENT_JS;
  }

  @Get('presets')
  @UseGuards(InternalApiGuard)
  getPresets(): StatlockerProbeTarget[] {
    return this.statlockerProbeService.getTargets();
  }

  @Get('discover')
  @UseGuards(InternalApiGuard)
  discover(): Promise<StatlockerDiscoveryResult> {
    return this.statlockerProbeService.discoverEndpoints();
  }

  @Post('request')
  @UseGuards(InternalApiGuard)
  request(@Body() body: StatlockerProbeRequest): Promise<StatlockerProbeResponse> {
    return this.statlockerProbeService.request(body);
  }

  @Post('browser-request')
  @UseGuards(InternalApiGuard)
  browserRequest(
    @Body() body: StatlockerBrowserProbeRequest,
  ): Promise<StatlockerBrowserProbeResult> {
    return this.statlockerBrowserService.probe(body);
  }
}

/**
 * The client bundle calls these routes with a relative path from the same
 * origin, so wrapping window.fetch is enough to carry the key without editing
 * that 298-line bundle. Written without backticks or template placeholders on
 * purpose -- it is embedded in a TypeScript template literal.
 *
 * A 401 clears the stored key so the next call re-prompts instead of failing
 * silently forever with a stale value.
 */
const INTERNAL_KEY_BOOTSTRAP_JS = [
  '<script>',
  '(function () {',
  "  var KEY_STORAGE = 'dynamo-internal-key';",
  '  function promptForKey() {',
  "    var entered = window.prompt('Internal API key (x-dynamo-internal-key)');",
  '    if (entered && entered.trim()) sessionStorage.setItem(KEY_STORAGE, entered.trim());',
  "    return sessionStorage.getItem(KEY_STORAGE) || '';",
  '  }',
  '  var originalFetch = window.fetch.bind(window);',
  '  window.fetch = function (input, init) {',
  "    var url = typeof input === 'string' ? input : (input && input.url) || '';",
  "    var sameOrigin = url.indexOf('/') === 0 || url.indexOf(window.location.origin) === 0;",
  '    if (!sameOrigin) return originalFetch(input, init);',
  '    var key = sessionStorage.getItem(KEY_STORAGE) || promptForKey();',
  '    var options = Object.assign({}, init || {});',
  '    var headers = new Headers(options.headers || undefined);',
  "    headers.set('x-dynamo-internal-key', key);",
  '    options.headers = headers;',
  '    return originalFetch(input, options).then(function (response) {',
  '      if (response.status === 401) sessionStorage.removeItem(KEY_STORAGE);',
  '      return response;',
  '    });',
  '  };',
  '})();',
  '</script>',
].join('\n');

function injectInternalKeyBootstrap(html: string): string {
  const marker = '</head>';
  if (html.includes(marker)) {
    return html.replace(marker, `${INTERNAL_KEY_BOOTSTRAP_JS}\n${marker}`);
  }
  return `${INTERNAL_KEY_BOOTSTRAP_JS}\n${html}`;
}
