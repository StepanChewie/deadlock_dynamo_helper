# Подготовка к сабмиту в Overwolf Appstore — 10 PR

Составлено по фактическому состоянию репозитория на 2026-09-16. Каждый пункт проверен по коду; в диffах указаны реальные файлы и строки.

**Главный принцип:** до сабмита не добавляется ни одна новая продуктовая фича. Всё ниже — либо снятие риска отказа, либо снятие live-экспозиции.

**Что здесь есть и чего нет.** Это кодовая часть. За пределами остаются: согласование с DevRel, вопрос по Ads/Subscriptions, покупка production-домена, дизайн store-ассетов, матрица ручных проверок, скриншоты, listing-текст, сборка OPK и сама отправка.

---

## Порядок и зависимости

| # | Тема | Блокирует сабмит | Тип | Зависит от |
|---|---|---|---|---|
| 1 | Hotkey cleanup | да | уборка | — |
| 2 | Overlay auto-show / user control | да | поведение | — |
| 3 | Store-ready manifest + validator | да | конфиг + ассеты | 1 (validator ловит Ctrl+Tab) |
| 4 | Защита admin/debug роутов | нет | **live-риск** | — |
| 5 | Rate limiting + payload limits | нет | **live-риск** | 4 (общий конфиг модуля) |
| 6 | `gep_internal` | да | функциональность | — |
| 7 | Stale recommendation TTL | да | поведение | — |
| 8 | Terms + удаление данных | да | юридическое | — |
| 9 | Settings screen + скрыть nav | да | UI | 2, 7 |
| 10 | Production config cleanup | да | конфиг | 3 |

**Рекомендуемый порядок исполнения: 4 → 5 → 1 → 3 → 6 → 2 → 7 → 9 → 8 → 10.**

PR 4 и 5 идут первыми, потому что это единственные два пункта, которые являются *живой* экспозицией сегодня, а не блокером сабмита. PR 1 идёт до PR 3, потому что validator из PR 3 должен начать падать на `Ctrl+Tab`, и он должен падать уже после того, как строка убрана — иначе PR 3 нельзя смёржить зелёным.

---

## PR 1 — Hotkey cleanup

### Зачем

`Ctrl+Tab` — плохой выбор для игрового оверлея: `Tab` в Deadlock занят таблицей счёта, а `Ctrl+Tab` — системный переключатель вкладок в любом браузерном контексте. Overwolf может счесть такой бинд конфликтующим при ревью.

### Файлы

| Файл | Строка | Что там |
|---|---|---|
| `apps/overwolf-client/public/manifest.json` | 114 | `hotkeys.toggle_overlay.default` |
| `apps/overwolf-client/public/desktop.html` | 730 | подсказка hotkey |
| `apps/overwolf-client/public/desktop.html` | 786 | шаг 1 first-run гайда |
| `apps/overwolf-client/public/in_game.html` | 348 | подпись в оверлее |
| `apps/overwolf-client/public/dist/index.js` | — | артефакт, перегенерируется сборкой |

Новый дефолт: **`Ctrl+Shift+D`** — свободен, консистентен с уже занятыми `Ctrl+Shift+B` (desktop window) и `Ctrl+Shift+Home` (reset position).

### Дифф

```diff
--- a/apps/overwolf-client/public/manifest.json
+++ b/apps/overwolf-client/public/manifest.json
@@ -111,7 +111,7 @@
       "toggle_overlay": {
         "title": "Toggle In-Game Build Overlay",
         "action-name": "toggle_overlay",
-        "default": "Ctrl+Tab"
+        "default": "Ctrl+Shift+D"
       },
```

```diff
--- a/apps/overwolf-client/public/desktop.html
+++ b/apps/overwolf-client/public/desktop.html
@@ -727,7 +727,7 @@
         <div id="hotkey-hint" class="hotkey-hint" role="note">
-          <span>Press <kbd>Ctrl+Tab</kbd> to toggle the in-game overlay. <kbd>Ctrl+Shift+B</kbd> reopens this window.</span>
+          <span>Press <kbd>Ctrl+Shift+D</kbd> to toggle the in-game overlay. <kbd>Ctrl+Shift+B</kbd> reopens this window.</span>
@@ -783,7 +783,7 @@
-            <li>Press <kbd>Ctrl+Tab</kbd> to toggle the in-game overlay.</li>
+            <li>Press <kbd>Ctrl+Shift+D</kbd> to toggle the in-game overlay.</li>
```

```diff
--- a/apps/overwolf-client/public/in_game.html
+++ b/apps/overwolf-client/public/in_game.html
@@ -345,7 +345,7 @@
-        <span><kbd>Ctrl+Tab</kbd> hides this overlay</span>
+        <span><kbd>Ctrl+Shift+D</kbd> hides this overlay</span>
```

Плюс регрессионный тест, который не даст строке вернуться. Jest в клиенте уже настроен на `src/.*\.spec\.ts`, а спека может читать файлы с диска:

```ts
// apps/overwolf-client/src/hotkey-copy.spec.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const publicDir = join(__dirname, '..', 'public');
const sources = ['manifest.json', 'desktop.html', 'in_game.html'];

describe('toggle_overlay hotkey copy', () => {
  it('does not mention the retired Ctrl+Tab binding anywhere', () => {
    for (const name of sources) {
      const content = readFileSync(join(publicDir, name), 'utf8');
      expect(content).not.toMatch(/Ctrl\+Tab/i);
    }
  });

  it('advertises Ctrl+Shift+D as the toggle binding', () => {
    const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.json'), 'utf8'));
    expect(manifest.data.hotkeys.toggle_overlay.default).toBe('Ctrl+Shift+D');
    for (const name of ['desktop.html', 'in_game.html']) {
      expect(readFileSync(join(publicDir, name), 'utf8')).toMatch(/Ctrl\+Shift\+D/);
    }
  });
});
```

### Проверка

```bash
yarn workspace @dynamo-lab/overwolf-client test
yarn workspace @dynamo-lab/overwolf-client build
```

**Риск, который надо знать.** Смена `default` в манифесте **не перебиндит уже установленные копии**: Overwolf хранит пользовательский бинд и не перезаписывает его при обновлении. Для свежего сабмита это неважно, но на тестовой машине бинд придётся сбросить вручную в настройках хоткеев Overwolf. Именно поэтому в PR 9 в Settings нужна ссылка на системные настройки хоткеев, а не собственный редактор.

---

## PR 2 — Overlay auto-show: user control

### Зачем

Сейчас оверлей поднимается сам, как только появился `matchId` — `InGameOverlayLifecycle.sync()` вызывает `restore` безусловно. До ответа DevRel безопасный вариант: **не показывать оверлей автоматически**, только готовить рекомендацию в фоне и открывать по хоткею. Плюс пользовательский выключатель, если auto-show разрешат.

**Важно:** фоновая подготовка рекомендации уже не зависит от оверлея. `scheduleAdaptiveRecommendation()` в `index.ts:217` вызывается из обработчика событий и от жизненного цикла оверлея не зависит. То есть «готовить в фоне и открыть по хоткею» — это **только** гейт на вызове `restore`. Ничего переписывать не нужно.

### Файлы

- `apps/overwolf-client/src/overwolf/in-game-overlay-lifecycle.ts`
- `apps/overwolf-client/src/player-preferences.ts`
- `apps/overwolf-client/src/index.ts` (строки 181–182)
- `apps/overwolf-client/src/overwolf/in-game-overlay-lifecycle.spec.ts`

### Дифф

`player-preferences.ts` сейчас умеет только булевы «одноразовые» флаги. Его надо обобщить — это же понадобится в PR 9:

```diff
--- a/apps/overwolf-client/src/player-preferences.ts
+++ b/apps/overwolf-client/src/player-preferences.ts
@@
 export function persistDismissed(key: string): void {
   try {
     globalThis.localStorage?.setItem(storageKey(key), 'true');
   } catch {
     // Storage unavailable — the hint stays dismissed for this session only.
   }
 }
+
+/** Reads a stored preference, falling back when storage is unavailable. */
+export function readPreference<T>(key: string, fallback: T): T {
+  try {
+    const raw = globalThis.localStorage?.getItem(storageKey(key));
+    return raw === null || raw === undefined ? fallback : (JSON.parse(raw) as T);
+  } catch {
+    return fallback;
+  }
+}
+
+export function persistPreference<T>(key: string, value: T): void {
+  try {
+    globalThis.localStorage?.setItem(storageKey(key), JSON.stringify(value));
+  } catch {
+    // Storage unavailable — the preference applies for this session only.
+  }
+}
+
+export const PREFERENCE_KEYS = {
+  overlayAutoShow: 'overlay.autoShow',
+  routeLength: 'overlay.routeLength',
+} as const;
```

Гейт в жизненном цикле — инъекцией предиката, чтобы класс остался чистым и тестируемым:

```diff
--- a/apps/overwolf-client/src/overwolf/in-game-overlay-lifecycle.ts
+++ b/apps/overwolf-client/src/overwolf/in-game-overlay-lifecycle.ts
@@
 export class InGameOverlayLifecycle {
   private activeMatchId = '';
   private pendingMatchId = '';
 
-  constructor(private readonly restoreOverlay: RestoreOverlay) {}
+  constructor(
+    private readonly restoreOverlay: RestoreOverlay,
+    /**
+     * Defaults to false: until DevRel confirms otherwise, a new match must not
+     * put the overlay on screen by itself. The recommendation is still built in
+     * the background; the player opens the overlay with the hotkey.
+     */
+    private readonly shouldAutoShow: () => boolean = () => false,
+  ) {}
 
   sync(matchId: string): void {
     const normalizedMatchId = matchId.trim();
@@
     if (
       this.activeMatchId === normalizedMatchId
       || this.pendingMatchId === normalizedMatchId
     ) {
       return;
     }
 
+    if (!this.shouldAutoShow()) {
+      // Remember the match so a later re-enable does not re-fire for it, but
+      // do not touch the window.
+      this.activeMatchId = normalizedMatchId;
+      return;
+    }
+
     this.pendingMatchId = normalizedMatchId;
```

Проводка в `index.ts`:

```diff
--- a/apps/overwolf-client/src/index.ts
+++ b/apps/overwolf-client/src/index.ts
@@
-  const inGameOverlayLifecycle = new InGameOverlayLifecycle(restoreInGameOverlayWindow);
+  const inGameOverlayLifecycle = new InGameOverlayLifecycle(
+    restoreInGameOverlayWindow,
+    () => readPreference(PREFERENCE_KEYS.overlayAutoShow, false),
+  );
```

### Проверка

- Существующий `in-game-overlay-lifecycle.spec.ts` покрывает restore-путь — он должен остаться зелёным, потому что там предикат по умолчанию. Добавить кейсы: `shouldAutoShow: () => false` → `restoreOverlay` не вызывается; включение предиката посреди матча.
- Ручная проверка: зайти в матч → оверлей не появляется → `Ctrl+Shift+D` → появляется.

### Риск

При выключенном auto-show игрок, который не знает про хоткей, не увидит оверлей вообще. Это ровно та причина, по которой нужны first-run гайд (уже есть) и подсказка в desktop-окне (уже есть) — но их текст надо переписать с «нажмите, чтобы скрыть» на «нажмите, чтобы открыть».

---

## PR 3 — Store-ready manifest + validator

### Зачем

Для Appstore нужны четыре поля в `meta`, которых сейчас нет. По [документации Overwolf](https://dev.overwolf.com/ow-native/reference/manifest/manifest-json/) все они живут в `meta` и обязательны для сабмита.

**Существенно:** текущая иконка уже нарушает спеку. `dynamo.png` — **447×447, 236 KB**, а требуется 256×256. То есть новый dimension-check упадёт в первый же прогон. Это не «немного пересекается с ассетами» — это блокер, который надо закрыть в этом же PR.

### Файлы

- `apps/overwolf-client/public/manifest.json`
- `apps/overwolf-client/public/` — новые ассеты
- `apps/overwolf-client/scripts/validate-release.js`

### Дифф — манифест

```diff
--- a/apps/overwolf-client/public/manifest.json
+++ b/apps/overwolf-client/public/manifest.json
@@
   "meta": {
     "name": "Dynamo Lab",
     "version": "0.1.15",
     "minimum-overwolf-version": "0.197.0",
     "minimum-gep-version": "305.0",
     "author": "StepanChewbacca",
     "description": "Live Deadlock build route: one current purchase plus the next four legal purchases for the running match",
-    "icon": "dynamo.png"
+    "icon": "store/icon-256.png",
+    "icon_gray": "store/icon-gray-256.png",
+    "launcher_icon": "store/launcher.ico",
+    "window_icon": "store/window-icon-256.png",
+    "dock_button_title": "Dynamo Lab"
   },
```

Ограничения, которые надо соблюсти при подготовке ассетов:

| Поле | Формат | Требование |
|---|---|---|
| `icon` | PNG | 256×256 @72 PPI, ~до 30 KB |
| `icon_gray` | PNG | 256×256, grayscale, дефолтное (не hover) состояние |
| `window_icon` | PNG | 256×256 |
| `launcher_icon` | **ICO** | цветная иконка для ярлыка Windows |
| `dock_button_title` | string | до 18 символов |

В репозитории **нет ни одного `.ico`** — это надо создать. Также `public/icon.png` (565 KB) сейчас неотреференсован ниоткуда: либо использовать его как основу, либо удалить из пакета, чтобы не тащить мусор в OPK.

### Дифф — validator

Сейчас `validate-release.js` проверяет `manifest.meta.icon` на «существование + PNG + квадратность», но не проверяет размеры, не знает про store-поля, и его проверка `externally_connectable` пропускает DuckDNS (она требует лишь «какой-нибудь https-origin»).

```diff
--- a/apps/overwolf-client/scripts/validate-release.js
+++ b/apps/overwolf-client/scripts/validate-release.js
@@
 const OVERWOLF_TEST_SCREEN_HEIGHT = 720;
+const STORE_ICON_SIZE = 256;
+const STORE_ICON_MAX_BYTES = 40 * 1024;
+const RETIRED_API_HOSTS = [/duckdns\.org$/i, /^localhost$/i, /^127\.0\.0\.1$/];
+const RETIRED_HOTKEYS = [/Ctrl\+Tab/i];
@@
 for (const permission of ['GameInfo', 'Hotkeys']) {
@@
 }
+
+// Appstore submission requires these four meta fields on top of `icon`.
+for (const field of ['dock_button_title', 'icon_gray', 'launcher_icon', 'window_icon']) {
+  assert(
+    typeof manifest.meta?.[field] === 'string' && manifest.meta[field].trim().length > 0,
+    `manifest.meta.${field} is required for Appstore submission.`,
+  );
+}
+
+assert(
+  (manifest.meta?.dock_button_title || '').length <= 18,
+  'manifest.meta.dock_button_title must be at most 18 characters.',
+);
+
+for (const field of ['icon', 'icon_gray', 'window_icon']) {
+  const value = manifest.meta?.[field];
+  if (typeof value !== 'string' || value.trim().length === 0) continue;
+  const filePath = path.join(publicDir, value);
+  assert(fs.existsSync(filePath), `manifest.meta.${field} references a missing file: ${value}`);
+  if (!fs.existsSync(filePath)) continue;
+  assertPng(filePath, `meta.${field}`);
+  assertSquareSize(filePath, `meta.${field}`, STORE_ICON_SIZE);
+  assert(
+    fs.statSync(filePath).size <= STORE_ICON_MAX_BYTES,
+    `meta.${field} exceeds ${Math.round(STORE_ICON_MAX_BYTES / 1024)}KB.`,
+  );
+}
+
+if (typeof manifest.meta?.launcher_icon === 'string') {
+  const icoPath = path.join(publicDir, manifest.meta.launcher_icon);
+  assert(fs.existsSync(icoPath), 'manifest.meta.launcher_icon is missing.');
+  if (fs.existsSync(icoPath)) {
+    const head = fs.readFileSync(icoPath).subarray(0, 4).toString('hex');
+    assert(head === '00000100', 'manifest.meta.launcher_icon must be a real ICO file.');
+  }
+}
+
+// A store build must not ship the development origin.
+for (const value of externalMatches || []) {
+  const host = safeHost(value);
+  assert(
+    !host || !RETIRED_API_HOSTS.some((pattern) => pattern.test(host)),
+    `externally_connectable still contains a development origin: ${value}`,
+  );
+}
+
+const hotkeys = manifest.data?.hotkeys || {};
+for (const [name, config] of Object.entries(hotkeys)) {
+  assert(
+    !RETIRED_HOTKEYS.some((pattern) => pattern.test(config?.default || '')),
+    `hotkey ${name} still uses a retired default binding: ${config?.default}`,
+  );
+}
+
+// The client reads gep_internal.version_info for diagnostics, so the feature
+// must actually be requested at registration time.
+const requiredFeaturesSource = fs.readFileSync(
+  path.join(appRoot, 'src', 'overwolf', 'set-required-features.ts'),
+  'utf8',
+);
+assert(
+  /REQUIRED_FEATURES[\s\S]*?'gep_internal'/.test(requiredFeaturesSource),
+  "set-required-features.ts must request 'gep_internal'.",
+);
+
+// Legal links must point at published documents, never at a dev or local host.
+const desktopHtml = fs.readFileSync(path.join(publicDir, 'desktop.html'), 'utf8');
+for (const match of desktopHtml.matchAll(/openExternal\?\.\('([^']+)'\)/g)) {
+  const host = safeHost(match[1]);
+  assert(
+    Boolean(host) && !RETIRED_API_HOSTS.some((pattern) => pattern.test(host)),
+    `desktop.html links to a non-production URL: ${match[1]}`,
+  );
+}
```

И две новые хелпер-функции рядом с `assertPng`:

```js
function assertSquareSize(filePath, label, expected) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    return;
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert(
    width === expected && height === expected,
    `${label} must be ${expected}x${expected}, got ${width}x${height}.`,
  );
}

function safeHost(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}
```

Также поменять формулировки, которые сейчас прямо говорят «sideload»:

```diff
-  throw new Error(`Overwolf sideload validation failed:\n- ${errors.join('\n- ')}`);
+  throw new Error(`Overwolf release validation failed:\n- ${errors.join('\n- ')}`);
@@
-console.log(
-  `Overwolf sideload ${manifest.meta.version} validated for Deadlock ${DEADLOCK_GAME_ID}.`,
-);
+console.log(
+  `Overwolf store-ready ${manifest.meta.version} validated for Deadlock ${DEADLOCK_GAME_ID}.`,
+);
```

### Проверка

```bash
yarn workspace @dynamo-lab/overwolf-client validate:release
```

Ожидание: падает до PR 1 и до подготовки ассетов, зелёный после. Проверить, что падение действительно происходит — временно вернуть `Ctrl+Tab` и убедиться.

### Риск

Валидатор читает `src/overwolf/set-required-features.ts`, то есть завязан на путь к исходнику. Это осознанный компромисс: проверка исходника дешевле, чем сборка бандла ради одной строки. Если путь переедет — тест упадёт явно, а не молча.

---

## PR 4 — Защита admin/debug роутов

### Зачем

На весь API сейчас **один** guard — `BuildDebugAuthV2Guard`, и он висит только на `debug/build-v2`. Открыты наружу:

| Роут | Контроллер |
|---|---|
| `GET /deadlock/reference-data/**` | `reference-data.controller.ts` |
| `POST /deadlock/reference-data/catalogs/import` | там же |
| `POST|PUT /deadlock/reference-data/rulesets/**` | там же (мутации правил) |
| `GET /deadlock/live/states` | `live-ingest.controller.ts:40` |
| `GET /deadlock/live/matches/:matchId/state` | `:45` |
| `GET /deadlock/live/matches/:matchId/inventory-shadow[/:steamId]` | `:50`, `:55` |
| `GET /deadlock/live/events/recent` | `:63` |
| `GET /deadlock/live/debug` | `debug-page.controller.ts:5` |
| `GET /deadlock-live/recommendation-souls-evidence/v2/**` | `souls-affordability-evidence-v2.controller.ts` |

### Про Nginx

В репозитории **нет конфига Nginx для API** — в `ops/nginx/` лежит единственный файл `statlocker-probe.location.conf`, и это сниппет `location` для проксирования исследовательского UI, а не описание периметра. При этом `docker-compose.yml` публикует порт на хост:

```yaml
ports:
  - '3000:3000'
```

Вывод: **опираться на «это уже закрыто на краю» нельзя**, потому что из репозитория это не подтверждается. Делаем guard в коде — он всё равно нужен как defense in depth, даже если край настроен.

### Файлы

- `apps/api/src/common/internal-api.guard.ts` (новый)
- `apps/api/src/deadlock-live/live-ingest.controller.ts`
- `apps/api/src/deadlock-live/reference-data.controller.ts`
- `apps/api/src/deadlock-live/debug-page.controller.ts`
- `apps/api/src/deadlock-live/souls-affordability-evidence-v2.controller.ts`
- `apps/api/src/main.ts`
- `docker-compose.yml`

### Дифф — guard

```ts
// apps/api/src/common/internal-api.guard.ts
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';

export const INTERNAL_API_KEY_HEADER = 'x-dynamo-internal-key';

/**
 * Guards operator-only routes: reference data imports, ruleset mutations,
 * live match inspection and the debug page. The public ingest, recommend,
 * feedback and status routes must never carry this guard.
 */
@Injectable()
export class InternalApiGuard implements CanActivate {
  private readonly expected = process.env.INTERNAL_API_KEY?.trim() ?? '';

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) {
      // Fail closed. An unset key must not silently expose the route.
      throw new UnauthorizedException('Internal API key is not configured');
    }

    const request = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | undefined> }>();
    const provided = request.headers?.[INTERNAL_API_KEY_HEADER]?.trim() ?? '';

    if (!provided || !constantTimeEquals(provided, this.expected)) {
      throw new UnauthorizedException('Internal API authentication required');
    }
    return true;
  }
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
```

### Дифф — применение

На уровне класса — там, где весь контроллер приватный:

```diff
--- a/apps/api/src/deadlock-live/reference-data.controller.ts
+++ b/apps/api/src/deadlock-live/reference-data.controller.ts
@@
-import { Body, Controller, Get, Param, ParseIntPipe, Post, Put } from '@nestjs/common';
+import { Body, Controller, Get, Param, ParseIntPipe, Post, Put, UseGuards } from '@nestjs/common';
+import { InternalApiGuard } from '../common/internal-api.guard';
@@
 @Controller('deadlock/reference-data')
+@UseGuards(InternalApiGuard)
 export class ReferenceDataController {
```

То же самое для `DebugPageController` и `SoulsAffordabilityEvidenceV2Controller`.

`LiveIngestController` смешивает публичный POST с приватными GET, поэтому guard вешается **по методам**, а не на класс:

```diff
--- a/apps/api/src/deadlock-live/live-ingest.controller.ts
+++ b/apps/api/src/deadlock-live/live-ingest.controller.ts
@@
-import { Body, Controller, Get, Logger, Param, Post } from '@nestjs/common';
+import { Body, Controller, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
+import { InternalApiGuard } from '../common/internal-api.guard';
@@
+  // Public: the Overwolf client posts here and has no internal key.
   @Post('events')
   async ingestEvents(@Body() batch: OverwolfLiveBatchDto): Promise<{ ok: true }> {
@@
   @Get('states')
+  @UseGuards(InternalApiGuard)
   getStates() {
@@
   @Get('matches/:matchId/state')
+  @UseGuards(InternalApiGuard)
   getState(@Param('matchId') matchId: string) {
@@
   @Get('matches/:matchId/inventory-shadow')
+  @UseGuards(InternalApiGuard)
   getInventoryShadow(@Param('matchId') matchId: string) {
@@
   @Get('matches/:matchId/inventory-shadow/:steamId')
+  @UseGuards(InternalApiGuard)
   getPlayerInventoryShadow(
@@
   @Get('events/recent')
+  @UseGuards(InternalApiGuard)
   getRecentEvents() {
```

### Дифф — CORS и порт

```diff
--- a/apps/api/src/main.ts
+++ b/apps/api/src/main.ts
@@
   const app = await NestFactory.create(AppModule, { bodyParser: false });
   app.use(json({ limit: '10mb' }));
-  app.enableCors();
+  app.enableCors({
+    origin: readCorsOrigins(),
+    methods: ['GET', 'POST'],
+    allowedHeaders: ['content-type', INTERNAL_API_KEY_HEADER],
+  });
   await app.listen(3000);
 }
+
+function readCorsOrigins(): string[] | boolean {
+  const configured = (process.env.CORS_ALLOWED_ORIGINS ?? '')
+    .split(',')
+    .map((value) => value.trim())
+    .filter(Boolean);
+
+  // No allowlist configured means a local or test run; keep it permissive there
+  // rather than silently breaking the client.
+  return configured.length > 0 ? configured : true;
+}
```

```diff
--- a/docker-compose.yml
+++ b/docker-compose.yml
@@
     ports:
-      - '3000:3000'
+      - '127.0.0.1:3000:3000'
     environment:
@@
       - DEADLOCK_API_KEY=${DEADLOCK_API_KEY}
+      - INTERNAL_API_KEY=${INTERNAL_API_KEY}
+      - CORS_ALLOWED_ORIGINS=${CORS_ALLOWED_ORIGINS:-}
```

**Перед тем как включать allowlist, определите реальный `Origin`.** Окна Overwolf-приложения обращаются к HTTPS-хосту, и какой именно заголовок они шлют, из кода не видно. Снимите его на живом билде (`ui.logConsole` временно или через логи nginx) и только потом заносите в `CORS_ALLOWED_ORIGINS`. Если окажется `null` — разрешите `null` явно и напишите об этом комментарий, иначе через месяц кто-то «почистит» эту строку.

### Чего делать НЕ надо

- **Не вешать guard глобально через `APP_GUARD`.** `/deadlock/adaptive/v1/status` — цель healthcheck в `docker-compose.yml:33` и в `deploy.yml:258,268` (проверяется ещё и через публичный origin). Он обязан остаться публичным. Плюс `deploy.yml:98` ассертит, что отставленные роуты `/deadlock/analysis/*` возвращают **404**; глобальный guard вернул бы 401 и уронил бы деплой.
- Не закрывать `POST /deadlock/live/events`, `POST /deadlock/adaptive/v2/recommend`, `POST /deadlock/adaptive/v1/feedback`.

### Проверка

```bash
# внутри контейнера, без ключа — ожидаем 401
docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/deadlock/live/states').then(r=>console.log(r.status))"
# с ключом — 200
docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/deadlock/live/states',{headers:{'x-dynamo-internal-key':process.env.INTERNAL_API_KEY}}).then(r=>console.log(r.status))"
# публичные — 200 без ключа
docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/deadlock/adaptive/v1/status').then(r=>console.log(r.status))"
```

### Риск

Смена биндинга порта на `127.0.0.1` ломает доступ, если Nginx проксирует **не** с этого хоста. Если Nginx живёт в том же docker-сети `aboba-telegramovich_default`, правильнее вообще убрать секцию `ports` и ходить по имени контейнера — но это надо подтвердить по конфигу Nginx, которого в репозитории нет.

---

## PR 5 — Rate limiting + payload limits

### Зачем

Сейчас нет ничего: ни `ThrottlerModule` в `app.module.ts`, ни одного вхождения `throttle` в `apps/api`. Лимит тела — `10mb` глобально (`main.ts:18`), включая feedback. Незащищённый `POST /deadlock/live/events` ещё и пишет на диск (см. PR 8).

### Дифф — rate limit

```diff
--- a/apps/api/src/app.module.ts
+++ b/apps/api/src/app.module.ts
@@
 import { Module } from '@nestjs/common';
 import { ScheduleModule } from '@nestjs/schedule';
+import { ThrottlerModule } from '@nestjs/throttler';
@@
   imports: [
     ScheduleModule.forRoot(),
+    ThrottlerModule.forRoot({
+      throttlers: [{ name: 'public', ttl: 60_000, limit: 120 }],
+    }),
     TypeOrmModule.forRoot({
```

Точечно на три публичных роута — **не** глобальным guard, чтобы не задеть внутренние:

```diff
--- a/apps/api/src/deadlock-live/live-ingest.controller.ts
+++ b/apps/api/src/deadlock-live/live-ingest.controller.ts
@@
-import { Body, Controller, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
+import { Body, Controller, Get, Logger, Param, Post, UseGuards } from '@nestjs/common';
+import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
@@
   // Public: the Overwolf client posts here and has no internal key.
   @Post('events')
+  @UseGuards(ThrottlerGuard)
+  @Throttle({ public: { limit: 60, ttl: 60_000 } })
   async ingestEvents(@Body() batch: OverwolfLiveBatchDto): Promise<{ ok: true }> {
```

Аналогично: `recommend` — `limit: 60`, `feedback` — `limit: 10`.

### Дифф — лимиты тела, размер батча, таймаут

Порядок регистрации middleware важен: сначала специфичный роут, потом общий.

```diff
--- a/apps/api/src/main.ts
+++ b/apps/api/src/main.ts
@@
   const app = await NestFactory.create(AppModule, { bodyParser: false });
-  app.use(json({ limit: '10mb' }));
+  // Ingest is the only route that legitimately carries a large reconnect batch.
+  app.use('/deadlock/live/events', json({ limit: '4mb' }));
+  // Everything else — recommend, feedback, status — stays small on purpose.
+  app.use(json({ limit: '256kb' }));
```

Жёсткий кап на размер батча — в контроллере, до любой обработки:

```diff
--- a/apps/api/src/deadlock-live/live-ingest.controller.ts
+++ b/apps/api/src/deadlock-live/live-ingest.controller.ts
@@
+const MAX_EVENTS_PER_BATCH = 500;
+
 @Controller('deadlock/live')
 export class LiveIngestController {
@@
   @Post('events')
   @UseGuards(ThrottlerGuard)
   @Throttle({ public: { limit: 60, ttl: 60_000 } })
   async ingestEvents(@Body() batch: OverwolfLiveBatchDto): Promise<{ ok: true }> {
+    if (!Array.isArray(batch?.events) || batch.events.length === 0) {
+      throw new BadRequestException('events must be a non-empty array');
+    }
+    if (batch.events.length > MAX_EVENTS_PER_BATCH) {
+      throw new PayloadTooLargeException(
+        `events batch exceeds the ${MAX_EVENTS_PER_BATCH} event limit`,
+      );
+    }
+    if (typeof batch.clientId !== 'string' || batch.clientId.trim().length > 64) {
+      throw new BadRequestException('clientId must be a string of at most 64 characters');
+    }
     this.recentLiveEventsService.append(batch.events);
```

Таймаут — интерсептором, только на публичных роутах:

```ts
// apps/api/src/common/request-timeout.interceptor.ts
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  RequestTimeoutException,
} from '@nestjs/common';
import { Observable, throwError, timeout, catchError } from 'rxjs';

@Injectable()
export class RequestTimeoutInterceptor implements NestInterceptor {
  constructor(private readonly timeoutMs: number) {}

  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      timeout(this.timeoutMs),
      catchError((error) =>
        throwError(() =>
          error?.name === 'TimeoutError'
            ? new RequestTimeoutException(`Request exceeded ${this.timeoutMs}ms`)
            : error,
        ),
      ),
    );
  }
}
```

Вешать через `@UseInterceptors(new RequestTimeoutInterceptor(10_000))` на `events` и `feedback`. **На `recommend` не вешать** — этот роут по своей природе может считаться секундами, и таймаут там превратит нормальную работу в 408.

### Про «DTO validation» — тут предыдущая оценка была неверной

DTO в этом проекте — **не классы, а интерфейсы**: `OverwolfLiveBatchDto` объявлен как `export interface` в `packages/shared/src/live-events.ts`. В репозитории **нет ни `class-validator`, ни `class-transformer`** ни в одном `package.json`.

Практическое следствие: `app.useGlobalPipes(new ValidationPipe(...))` **не сделает ничего** — валидировать нечего, метаданных нет. Это не «включить пайп», это отдельный объём работы:

1. поставить `class-validator` + `class-transformer` в `apps/api`;
2. превратить нужные DTO в классы с декораторами, оставив интерфейсы как compile-time контракт;
3. либо — предпочтительнее для этого проекта — написать явную проверку формы батча руками, как в диffе выше, и не тащить две зависимости.

Второй вариант лучше подходит именно здесь, потому что `payload` в событии объявлен как `unknown` и намеренно открыт, а `forbidNonWhitelisted: true` начал бы отбивать 400 любые лишние поля в этом `payload`. То есть строгий whitelist здесь не просто бесполезен, а вреден.

**Вывод:** пункт «DTO validation» из исходного чеклиста заменяется на явную проверку формы и размеров в контроллере (показана выше) плюс кап на батч. Это дешевле, безопаснее и не требует новых зависимостей.

### Проверка

```bash
# батч сверх лимита — 413
# частые запросы — 429
# тело 1mb на /feedback — 413
```

### Риск

`ThrottlerGuard` использует IP. За Nginx без `X-Forwarded-For` все клиенты могут схлопнуться в один IP и получить 429 на нормальной нагрузке. Проверить `trust proxy` в Express до включения.

---

## PR 6 — `gep_internal`

### Зачем

Код уже читает `gep_internal.version_info` (`listen-overwolf-events.ts:104`, используется в диагностике через `readGepVersion()`), но фича не запрашивается: `set-required-features.ts:1` содержит только `['game_info', 'match_info']`. Налицо рассогласование.

### Ловушка, которую надо обойти

Нельзя просто дописать строку в массив. Текущая реализация отклоняет **весь промис**, если `result.success === false`:

```ts
overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, (result) => {
  if (!result.success) {
    reject(new Error(result.error ?? 'Failed to set required features'));
    return;
  }
  resolve();
});
```

Если GEP игры не поддерживает `gep_internal`, регистрация упадёт целиком — и мы потеряем `game_info`/`match_info`, то есть всю функциональность, ради строчки в диагностике. Нужна деградация, а не однострочный аппенд.

### Дифф

```diff
--- a/apps/overwolf-client/src/overwolf/set-required-features.ts
+++ b/apps/overwolf-client/src/overwolf/set-required-features.ts
@@
-const REQUIRED_FEATURES = ['game_info', 'match_info'];
+/** Features the recommendation pipeline cannot run without. */
+const CORE_FEATURES = ['game_info', 'match_info'];
 
-export function setRequiredFeatures(): Promise<void> {
+/**
+ * `gep_internal` is diagnostics-only: it feeds `readGepVersion()` in the
+ * diagnostics block. It is requested alongside the core features, but a GEP
+ * that does not expose it must not cost us the core features — the previous
+ * implementation rejected the whole promise on any failure.
+ */
+const OPTIONAL_FEATURES = ['gep_internal'];
+
+export const REQUIRED_FEATURES = [...CORE_FEATURES, ...OPTIONAL_FEATURES];
+
+export interface RequiredFeaturesResult {
+  registered: string[];
+  rejected: string[];
+}
+
+export function setRequiredFeatures(): Promise<RequiredFeaturesResult> {
+  return registerFeatures(REQUIRED_FEATURES).catch(async (error) => {
+    // Retry with the core set only, so a missing optional feature degrades the
+    // diagnostics block instead of disabling the app.
+    const fallback = await registerFeatures(CORE_FEATURES);
+    return { ...fallback, rejected: [...fallback.rejected, ...OPTIONAL_FEATURES], error } as never;
+  });
+}
+
+function registerFeatures(features: string[]): Promise<RequiredFeaturesResult> {
   return new Promise((resolve, reject) => {
     if (typeof overwolf === 'undefined' || !overwolf.games || !overwolf.games.events) {
       reject(new Error('Overwolf API is not available in this environment'));
       return;
     }
 
-    overwolf.games.events.setRequiredFeatures(REQUIRED_FEATURES, (result) => {
+    overwolf.games.events.setRequiredFeatures(features, (result) => {
       if (!result.success) {
         reject(new Error(result.error ?? 'Failed to set required features'));
         return;
       }
 
-      resolve();
+      resolve({ registered: features, rejected: [] });
     });
   });
 }
```

Приведённый фолбэк стоит уточнить под фактический вид ответа `setRequiredFeatures` в вашей сборке Overwolf — там может быть `supportedFeatures`, и тогда `registered`/`rejected` заполняются точно, без догадок. Проверьте форму `result` на живом вызове перед мержем.

Проводка в `index.ts` — обновить и захардкоженную строку лога, которая сейчас врёт:

```diff
--- a/apps/overwolf-client/src/index.ts
+++ b/apps/overwolf-client/src/index.ts
@@
-      await setRequiredFeatures();
+      const features = await setRequiredFeatures();
@@
-      ui.logConsole('Successfully registered GEP required features: game_info, match_info');
+      ui.logConsole(
+        `Successfully registered GEP required features: ${features.registered.join(', ')}`,
+      );
+      ui.updateDiagnosticContext({ gepFeatures: features.registered.join(',') });
```

### Проверка

- Юнит-тест: первый вызов реджектится → второй проходит → промис резолвится с core-набором.
- Живая проверка: диагностический блок показывает `gepVersion` (сейчас он может быть пустым именно потому, что фича не запрашивалась).

---

## PR 7 — Stale recommendation TTL

### Зачем

Сейчас `ui.ts:265` при ошибке оставляет прошлую рекомендацию на экране с текстом «Connection interrupted - showing the last safe recommendation.» и без ограничения по времени. Роут может висеть на экране сколько угодно.

### Дизайн

Отсчёт — **от времени последнего успешного ответа**, а не от момента ошибки. Клиент уже ретраит: `AdaptiveRecommendationClient` имеет debounce 1500 мс и retry 3000 мс, так что «свежесть» надо мерить от `lastSuccessAt`.

| Возраст | Поведение |
|---|---|
| < 10 с | показывать как есть |
| 10–30 с | показывать с пометкой «potentially outdated» |
| > 30 с | скрыть роут, ждать свежую рекомендацию |

### Файлы

- `apps/overwolf-client/src/ui.ts` (функция `showAdaptiveError`, строки 265–280)
- `apps/overwolf-client/src/index.ts` (`publishAdaptiveRecommendation` / `publishAdaptiveError`)
- `apps/overwolf-client/src/ui.spec.ts`

### Дифф

```diff
--- a/apps/overwolf-client/src/ui.ts
+++ b/apps/overwolf-client/src/ui.ts
@@
+export type RecommendationFreshness = 'FRESH' | 'STALE' | 'EXPIRED';
+
+export const STALE_AFTER_MS = 10_000;
+export const EXPIRED_AFTER_MS = 30_000;
+
+let lastSuccessAt = 0;
+
+export function markRecommendationFresh(at: number = Date.now()): void {
+  lastSuccessAt = at;
+}
+
+export function readRecommendationFreshness(now: number = Date.now()): RecommendationFreshness {
+  const age = now - lastSuccessAt;
+  if (age < STALE_AFTER_MS) return 'FRESH';
+  if (age < EXPIRED_AFTER_MS) return 'STALE';
+  return 'EXPIRED';
+}
+
 export function showAdaptiveError(message = 'Recommendation is updating'): void {
+  const freshness = readRecommendationFreshness();
+
+  if (freshness === 'EXPIRED') {
+    // Past the expiry window the route is more dangerous than no route: the
+    // player would buy against a build the match has already moved past.
+    hideSituationalPanel();
+    return;
+  }
+
   const note = document.getElementById('rec-update-note');
   if (hasAdaptiveRecommendation) {
     if (note) {
-      note.textContent = 'Connection interrupted - showing the last safe recommendation.';
+      note.textContent = freshness === 'STALE'
+        ? 'Connection interrupted - this route may be outdated.'
+        : 'Connection interrupted - showing the last safe recommendation.';
       note.style.display = 'flex';
       note.title = message;
     }
     return;
   }
```

В `index.ts` — отметка свежести в успешном пути и периодическая переоценка, чтобы экран не «застывал» в устаревшем состоянии без нового события:

```diff
@@ publishAdaptiveRecommendation
   const publishAdaptiveRecommendation = (data: any): void => {
     ui.setRefreshPending(false);
     mainWindow.latestAdaptiveRecommendation = data;
     mainWindow.latestAdaptiveError = null;
 
     if (data) {
+      ui.markRecommendationFresh();
       ui.showAdaptiveRecommendation(data);
     } else {
       ui.hideSituationalPanel();
     }
```

и переоценка раз в 5 с, пока есть ошибка:

```ts
setInterval(() => {
  if (!mainWindow.latestAdaptiveError) return;
  ui.showAdaptiveError(mainWindow.latestAdaptiveError);
}, 5_000);
```

### Инвалидация по инвентарю

Вторая половина задачи — «если рекомендованный item уже куплен, stale route сразу инвалидировать». Клиент получает события категории `items` (`STATE_SAFETY_CATEGORIES` в `listen-overwolf-events.ts:12`), поэтому технически может вести локальный набор купленных item id и сравнивать с `nextAction.buyItemId` текущей рекомендации.

Это отдельная, не тривиальная работа: нужно разобрать форму `items`-событий, собрать множество owned id и решить, что делать при расхождении (перезапросить принудительно — `scheduleAdaptiveRecommendation(true)` уже есть). **Рекомендую вынести в отдельный PR после сабмита**, а в этом PR закрыть только TTL. Иначе PR 7 перестаёт быть PR-sized.

### Проверка

- Юнит-тесты на `readRecommendationFreshness` с инъекцией `now`.
- Кейс «ошибка на 31-й секунде → `hideSituationalPanel` вызван».
- Существующий тест `ui.spec.ts:265` («keeps the last safe purchase route visible during a transient failure») должен остаться зелёным — он проверяет окно < 10 с.

### Риск

Скрывать роут на >30 с посреди матча — агрессивно. Альтернатива, если ручная проверка покажет, что это раздражает: на >30 с показывать только следующий шаг без полного плана. Но по умолчанию лучше скрыть: пустой экран честнее, чем устаревший роут.

---

## PR 8 — Terms + удаление данных

### 8a. Формулировка

Сейчас в `docs/terms.md:17`:

> It is **not** affiliated with, endorsed by, sponsored by, **or approved by** Valve Corporation or Overwolf Ltd.

А в `docs/privacy.md:75` уже чистый вариант:

> Dynamo Lab is not affiliated with, endorsed by, or sponsored by Valve Corporation or Overwolf Ltd.

То есть дефект — **рассинхрон двух документов**, а не «UI/repository». Привести к формулировке без «approved by» (формулировка «approved by» подразумевает существование процесса одобрения, которого нет):

```diff
--- a/docs/terms.md
+++ b/docs/terms.md
@@
-Dynamo Lab is an independent project. It is **not** affiliated with, endorsed by, sponsored by, or approved by Valve Corporation or Overwolf Ltd. *Deadlock* is a trademark of Valve Corporation, and Overwolf is a trademark of Overwolf Ltd. Both names are used only to describe what the app works with.
+Dynamo Lab is an independent project. It is **not** affiliated with, endorsed by, or sponsored by Valve Corporation or Overwolf Ltd. *Deadlock* is a trademark of Valve Corporation, and Overwolf is a trademark of Overwolf Ltd. Both names are used only to describe what the app works with.
```

### 8b. Deletion tooling

`docs/privacy.md` обещает: «Ask us to delete your match data… tell us the match id… We will delete the records for that match». Инструмента нет — поиск по `delete-match-data` даёт ноль вхождений.

**Хорошая новость: обещание реализуемо ровно как написано.** Я проверил все сущности с колонкой `matchId` — их три, плюс файловый лог, который уже разложен по matchId:

| Хранилище | Где | Как удалять |
|---|---|---|
| `adaptive_feedback_v1` | `entities/adaptive-feedback-v1.entity.ts:21` | `DELETE WHERE matchId = $1` |
| `adaptive_build_iterations_v1` | `entities/adaptive-build-iteration-v1.entity.ts:15` | `DELETE WHERE matchId = $1` |
| `build_archetype_match_locks_v2` | `entities/build-archetype-match-lock-v2.entity.ts` | `DELETE WHERE matchId = $1` |
| raw event log | `RawEventLogService`, `storage/deadlock-live/<matchId>.ndjson` | `unlink` одного файла |

Последний пункт снимает вопрос «а можно ли вообще удалить по matchId»: файл называется по matchId (`raw-event-log.service.ts:69`), так что удаление точечное. Ротация «32 файла» этому не мешает — если файл уже вытеснен, удалять нечего.

**Файлы:** `apps/api/src/scripts/delete-match-data.ts` (новый), `apps/api/package.json`, `package.json` в корне.

```ts
// apps/api/src/scripts/delete-match-data.ts
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createDataSource } from '../database/data-source';
import { AdaptiveBuildIterationV1Entity } from '../deadlock-live/entities/adaptive-build-iteration-v1.entity';
import { AdaptiveFeedbackV1Entity } from '../deadlock-live/entities/adaptive-feedback-v1.entity';
import { BuildArchetypeMatchLockV2Entity } from '../deadlock-live/entities/build-archetype-match-lock-v2.entity';

async function main(): Promise<void> {
  const matchId = (process.argv[2] ?? '').trim();
  if (!matchId) {
    console.error('Usage: yarn delete-match-data <matchId>');
    process.exit(1);
  }

  const dataSource = await createDataSource().initialize();
  const report: Record<string, number | string> = {};

  for (const [label, entity] of [
    ['adaptive_feedback_v1', AdaptiveFeedbackV1Entity],
    ['adaptive_build_iterations_v1', AdaptiveBuildIterationV1Entity],
    ['build_archetype_match_locks_v2', BuildArchetypeMatchLockV2Entity],
  ] as const) {
    const result = await dataSource.getRepository(entity).delete({ matchId });
    report[label] = result.affected ?? 0;
  }

  const logDir = process.env.DEADLOCK_LIVE_RAW_LOG_DIR?.trim()
    || join(process.cwd(), 'storage', 'deadlock-live');
  const safeId = matchId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  try {
    await unlink(join(logDir, `${safeId}.ndjson`));
    report['raw_event_log'] = 'deleted';
  } catch (error) {
    report['raw_event_log'] = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'not found'
      : 'failed';
  }

  await dataSource.destroy();
  console.log(JSON.stringify({ matchId, deleted: report }, null, 2));
}

void main();
```

**Важно:** `sanitizeMatchId` из `RawEventLogService` надо переиспользовать, а не дублировать — экспортировать его оттуда, чтобы имена файлов гарантированно совпадали.

Скрипты:

```diff
--- a/apps/api/package.json
+++ b/apps/api/package.json
@@
     "build:v2:capture-fixture": "ts-node src/scripts/capture-statlocker-build-v2-fixture.ts"
+    ,"delete-match-data": "ts-node src/scripts/delete-match-data.ts"
```

```diff
--- a/package.json
+++ b/package.json
@@
     "db:generate": "yarn workspace @dynamo-lab/api migration:generate"
+    ,"delete-match-data": "yarn workspace @dynamo-lab/api delete-match-data"
```

### Проверка

Прогнать на тестовом matchId, у которого есть данные во всех четырёх хранилищах, и убедиться, что после запуска запросы `GET /deadlock/live/matches/:matchId/*` возвращают пустоту, а файл исчез.

### Риск

Скрипт удаляет необратимо. Стоит добавить `--dry-run` по умолчанию и требовать `--yes` для фактического удаления. И обязательно — отдельная запись в runbook (`docs/dynamo-lab-runbook.md`) о том, что запрос на удаление из Discord отрабатывается именно этим.

---

## PR 9 — Settings screen + скрыть nav

### Зачем

В `desktop.html:711-715` пять пунктов навигации, четыре из них — `disabled` «Coming soon». Перед сабмитом в меню не должно быть выключенных разделов: это читается как недоделанное приложение.

### Дифф — nav

```diff
--- a/apps/overwolf-client/public/desktop.html
+++ b/apps/overwolf-client/public/desktop.html
@@
         <nav aria-label="Dynamo Lab navigation">
-          <button type="button" class="nav-item" aria-disabled="true" disabled aria-label="Overview, coming soon"><span>Overview</span><small>Coming soon</small></button>
           <button type="button" class="nav-item is-active" aria-current="page"><span>Live Build</span><small>Active</small></button>
-          <button type="button" class="nav-item" aria-disabled="true" disabled aria-label="Matches, coming soon"><span>Matches</span><small>Coming soon</small></button>
-          <button type="button" class="nav-item" aria-disabled="true" disabled aria-label="Match Analysis, coming soon"><span>Match Analysis</span><small>Coming soon</small></button>
-          <button type="button" class="nav-item" aria-disabled="true" disabled aria-label="Settings, coming soon"><span>Settings</span><small>Coming soon</small></button>
+          <button type="button" class="nav-item" id="nav-settings"><span>Settings</span><small>Overlay, support, status</small></button>
         </nav>
```

Убрать надо именно `Overview`, `Matches`, `Match Analysis` — они не будут реализованы до сабмита. `Settings` остаётся и получает содержимое.

### Содержимое Settings

Три секции, ничего лишнего:

**Overlay**
- `Auto show overlay` — чекбокс, читает/пишет `PREFERENCE_KEYS.overlayAutoShow` (из PR 2). По умолчанию **выключен** до ответа DevRel.
- Строка про хоткей с кнопкой, открывающей системные настройки хоткеев Overwolf. Свой редактор бинда не делать — Overwolf уже даёт его, а свой придётся синхронизировать с `manifest.json`.
- `Reset overlay position` — существующий бинд `reset_desktop_build` уже это делает; в Settings достаточно кнопки, вызывающей ту же функцию.
- `Route length` — 1 / 3 / 5, пишет `PREFERENCE_KEYS.routeLength`. Требует поддержки на сервере или обрезки на клиенте при отрисовке — уточнить перед реализацией; если серверной поддержки нет, в этом PR лучше не добавлять вовсе, чем добавить нерабочий контрол.

**Support**
- Privacy Policy, Terms — уже есть в `desktop.html:770,772`, переиспользовать существующие `openExternal`-ссылки на GitHub blob.
- Join Discord — `https://discord.gg/yR4TNN2GDH`, уже есть на `:759`.
- Copy diagnostics — `mainWindow.copyDiagnostics` уже проброшен (`index.ts:123`).

**Status**
- App version — `APP_VERSION` из `app-version.ts` (инжектится webpack DefinePlugin из `package.json`).
- GEP status — `gepStatus` (`REGISTERED` / degraded) + `gepVersion` из PR 6 + `gepSnapshot`.
- Backend status — уже собирается в `customFetch` (`index.ts:162,166,172`): `HTTP 200` / `HTTP 5xx` / `unreachable`.
- Recommendation freshness age — новое, из PR 7: `readRecommendationFreshness()` плюс возраст в секундах.

Всё это уже пишется в диагностический контекст через `ui.updateDiagnosticContext(...)` — Settings просто рендерит те же значения в читаемом виде, ничего нового собирать не нужно.

### Риск

Единственная действительно **новая** поверхность в этом списке. Всё остальное — уборка. Если время поджимает, Settings можно урезать до Status + Support, а `Auto show overlay` вынести в него позже: до ответа DevRel поведение всё равно зафиксировано на «не показывать автоматически».

---

## PR 10 — Production config cleanup

### Зачем

DuckDNS зашит в **три** места, а не в одно:

| Файл | Строка | Роль |
|---|---|---|
| `apps/overwolf-client/src/index.ts` | 21 | runtime-константа |
| `apps/overwolf-client/scripts/configure-api-base-url.js` | 4 | `DEFAULT_API_BASE_URL` |
| `apps/overwolf-client/public/manifest.json` | 26 | текущий `externally_connectable` |

При этом `configure-api-base-url.js` молча берёт дефолт, если `OVERWOLF_API_BASE_URL` не задан. Забыли переменную при сборке релиза — уехал DuckDNS, и ничего не упало.

### Дифф

Заменить дефолт на заведомо нерабочий placeholder, чтобы забытая переменная падала громко:

```diff
--- a/apps/overwolf-client/scripts/configure-api-base-url.js
+++ b/apps/overwolf-client/scripts/configure-api-base-url.js
@@
-const DEFAULT_API_BASE_URL = 'https://aboba-telegramovich.duckdns.org';
+// Deliberately unusable: a release build must supply OVERWOLF_API_BASE_URL.
+// A placeholder that resolves would let a misconfigured build ship silently.
+const DEFAULT_API_BASE_URL = 'https://api.invalid';
```

и явная проверка на релизную сборку:

```diff
@@
 const apiBaseUrl = normalizeApiBaseUrl(
   process.env.OVERWOLF_API_BASE_URL || DEFAULT_API_BASE_URL,
 );
+
+const isReleaseBuild =
+  process.env.OVERWOLF_RELEASE_BUILD === 'true'
+  || process.env.NODE_ENV === 'production';
+
+if (isReleaseBuild && !process.env.OVERWOLF_API_BASE_URL) {
+  throw new Error(
+    'OVERWOLF_API_BASE_URL must be set for a release build. '
+    + 'The placeholder origin is not shippable.',
+  );
+}
```

Плюс проверить `sync-public-to-windows.js` — если он тоже что-то подставляет, добавить такую же проверку.

Валидатор из PR 3 уже ловит остаточный DuckDNS в `externally_connectable` и в ссылках `desktop.html`. Добавить туда же проверку, что origin манифеста — не `api.invalid`:

```js
assert(
  !/^https:\/\/api\.invalid$/i.test(externalMatches?.[0] || ''),
  'Release build still points at the build-time placeholder origin.',
);
```

### Проверка

```bash
# без переменной — должно упасть
yarn workspace @dynamo-lab/overwolf-client build

# с переменной — должно пройти
OVERWOLF_API_BASE_URL=https://<production-host> \
OVERWOLF_RELEASE_BUILD=true \
yarn workspace @dynamo-lab/overwolf-client build
```

### Риск

`src/index.ts:21` содержит литерал `https://aboba-telegramovich.duckdns.org`, и именно его заменяет `configure-api-base-url.js` строковой подстановкой по `dist`. Если placeholder в `src` и `DEFAULT_API_BASE_URL` в скрипте разойдутся, скрипт выбросит `The compiled Overwolf bundle did not contain the expected API URL` — это уже предусмотрено (`configure-api-base-url.js:31`), так что менять надо **оба** значения в одном коммите.

---

## Что осталось за пределами кода

Не входит в эти 10 PR и не должно:

- согласование с DevRel по auto-show и по Ads/Subscriptions;
- покупка и настройка production-домена;
- дизайн store-ассетов (иконки из PR 3 — механическая подготовка под спеку, а не финальный дизайн);
- матрица ручных проверок и скриншоты;
- listing-текст;
- сборка OPK и отправка.

## После мержа

```bash
graphify update .
yarn test
yarn workspace @dynamo-lab/overwolf-client build
bash deploy.sh
```

Проверить, что `deploy.yml` не сломался на новых 401: он обращается к `/deadlock/adaptive/v1/status` (публичный, не тронут) и ассертит 404 на отставленных `/deadlock/analysis/*` (роутов нет в коде, guard на них не висит — 404 сохранится).
