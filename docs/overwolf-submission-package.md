# Пакет для подачи в Overwolf Appstore

Готовые тексты и разбор одного противоречия, которое надо снять **до** подачи.

Источники: <https://dev.overwolf.com/ow-native/getting-started/project-roadmap> и
<https://dev.overwolf.com/ow-native/getting-started/release-your-app/>.

---

## 0. СНАЧАЛА ПРОЧТИ: монетизация может быть обязательной

Ревью от 17 сентября (O5) закрыло вопрос монетизации так: «правило **условное** — „*For apps with
monetization plans*…“, монетизация **не требуется** для апрува».

**На той же странице есть второе утверждение, которое этому прямо противоречит:**

> Overwolf won't approve any app that **doesn't integrate** Overwolf ads or Overwolf subscriptions.

и в разделе про монетизацию:

> Overwolf won't approve any app that doesn't integrate Overwolf ads or Overwolf subscriptions.

Первая фраза условная (касается только тех, у кого **есть** планы). Вторая — **безусловная**.
Они несовместимы, и это ровно то противоречие, о котором предупреждал раздел 6 ревью.

**Что это значит практически.** Сейчас в `desktop.html` есть `#ow-ad-container` — **пустой
контейнер без интеграции**. То есть по строгому чтению мы попадаем в категорию «doesn't
integrate», и v1 могут не одобрить.

**Это не решается кодом, пока не известен ответ.** Поэтому вопрос задаётся **в форме заявки** —
там же, где решается апрув. Текст вопроса готов в разделе 1.

**Два исхода и что делать:**

| если DevRel скажет | что делаем |
|---|---|
| «достаточно не иметь сторонней монетизации» | оставляем как есть, выпиливаем пустой контейнер, чтобы не обещать невыполненное |
| «нужна интеграция ads или subscriptions» | это отдельная работа: интеграция Overwolf ads и приведение размещения к Advertising Policy. **До этого подавать бессмысленно** |

---

## 1. Заявка на идею — ✅ УЖЕ ПОДАНА И ОДОБРЕНА

**Подавать не нужно.** Владелец: без одобренной заявки приложение не добавлялось даже локально —
значит whitelisting пройден, и приложение зарегистрировано под `Dynamo Lab` / `StepanChewbacca`.

**Следствие, которое важно:** UID выведен из этих двух полей, и от UID зависит Origin клиента.
**`meta.name` и `meta.author` менять нельзя** — см. `review-2026-09-20.md`, раздел 4.

Ниже — сохранённый текст заявки, чтобы было видно, что именно было заявлено, и готовая
формулировка вопроса про монетизацию. **Вопрос в заявке задать уже нельзя** — она закрыта.
Каналы для него: <developers@overwolf.com> или форма отправки OPK.

**App name:** Dynamo Lab

**Author:** StepanChewbacca

**Framework:** Overwolf Native (WebApp)

**Game:** Deadlock (game id 24482)

**Public or private:** Public. Есть отдельное desktop-окно, приложение не является фоновым мостом.

**What the app does:**

> Dynamo Lab shows Deadlock players a live, legal item purchase route for the match they are
> currently in. A desktop window and an in-game overlay display one current purchase plus the next
> four legal purchases, derived from community build statistics for the player's hero and the
> enemies actually present in the match. It reads only the officially provided Game Events Provider
> data — no memory reading, no injection, no input automation.

**How it complies with game rules:**

> The app consumes only GEP events that Overwolf sanctions for Deadlock: `game_info` and
> `match_info`. It never reads game memory, never injects into the process, and never sends input.
> It gives no information a player could not obtain by reading community build statistics, and it
> does not act on the player's behalf.

**Monetization — the question to ask:**

> We plan to ship v1 with **no monetization at all**: no third-party monetization, no ads, no
> subscriptions. Our review of your documentation found two statements that appear to conflict —
> the app proposal page says "For apps with monetization plans, Overwolf won't approve any 3rd
> party monetization", while the same page and the monetization section also say "Overwolf won't
> approve any app that doesn't integrate Overwolf ads or Overwolf subscriptions". Could you confirm
> which applies to an app that has no monetization plans for its first release? If integrating
> Overwolf ads or subscriptions is required for approval, we will do that before submitting — we
> would rather build it now than be rejected for its absence.

**Anything else:**

> Data comes from community build statistics published by Statlocker, refreshed every 30 minutes. A
> match-data deletion tool and a published privacy policy and terms are already in place.

---

## 2. Инструкции по окнам — для формы отправки

QA просит описать каждое окно **текстом и скриншотами**, включая расположение рекламного контейнера.
Скриншоты снимаются отдельно (раздел 3); ниже — текст.

### Window 1 — `desktop` (главное окно)

Открывается при запуске. Два экрана, переключаются сайдбаром слева:

- **Live Build** (по умолчанию) — маршрут закупок для текущего матча. Пока матч не определён,
  показывает «Waiting for match data»; когда определён — полный маршрут с подсвеченной следующей
  покупкой.
- **Settings** — переключатель оверлея (opt-in), ссылки поддержки (Discord, политика, условия),
  копирование диагностики, сброс позиции окна.

Управление: **Refresh** справа сверху перезапрашивает маршрут. При первом запуске появляется
подсказка про хоткей, закрывается кнопкой «Got it».

### Window 2 — `in_game` (оверлей)

Только в игре. **Открывается хоткеем Ctrl+Shift+D и никогда не открывается сам.** Показывает тот же
маршрут компактной полосой: знак, состояние соединения, маршрут из пяти предметов, подсказка про
хоткей. **Не click-through** — принимает клики там, где нарисован.

### Window 3 — `dynamo_warning` (попап)

Только в игре. Небольшая перетаскиваемая карточка 400×150, появляется, когда в билд добавлен
ситуативный предмет. Тянуть за ручку сверху.

### Рекламный контейнер

`#ow-ad-container` — в **левом сайдбаре окна desktop, внизу слева**, под навигацией, зарезервировано
250 px по высоте. Сейчас **пустой и не подключён** — ни одна рекламная сеть к нему не привязана.
Скрыт при ширине меньше 1280 px.

> ⚠️ **Открытый вопрос.** Форма просит указать контейнер — значит ревьюер его увидит. Пустой
> контейнер без интеграции ровно и создаёт противоречие из раздела 0: по строгому чтению
> «doesn't integrate» это отказ. Ответ DevRel нужен **до** отправки.

### ⚠️ Непереведённый текст

`dynamo_warning.html` **полностью на русском** — три строки: `Перетащить окно предупреждения`,
`Внимание от Динамо`, `Ситуативный предмет поднят в билд.` Остальные два окна и листинг — на
английском. Для международного стора это дефект, и ревьюер его увидит. **Исправить до отправки.**

---

## 3. Текст листинга

### Короткое описание (в манифесте, ≤180 символов)

Уже стоит и укладывается:

> Live Deadlock build route: one current purchase plus the next four legal purchases for the running match

### Полное описание (markdown, ≤2000 символов)

```markdown
**Dynamo Lab tells you the whole build — not just the next item.**

Deadlock rewards planning. Between fights you have seconds to decide, and a build that looked right
at ten minutes can be the wrong one at twenty. Dynamo Lab reads the match you are actually in and
lays out the **complete purchase route for your hero**, from the item in your hand to the finished
build.

**What it shows**

- The full build, in the order you will buy it — every purchase, not a five-item window
- The item to buy right now, called out so you never have to work out where you are
- Adjustments for the enemy team you are facing

**Two windows, one job**

The desktop window is your planning view: the full route, the reasoning behind it, and your current
inventory. The in-game overlay is the glance — a compact strip you can read between waves without
leaving the fight. Toggle it with a hotkey and put it where you want.

**What it does not do**

No memory reading. No injection. No input automation. Dynamo Lab uses only the official Game Events
Provider data Overwolf provides for Deadlock, the same channel every approved Deadlock app uses. It
gives no advantage a player could not get from published build statistics — it just saves you the
tab-out.

**Free, and it stays free**

No account, no sign-up, no tracking of who you are. v1 is free.

**Good to know**

- Built for Deadlock (game id 24482)
- Works with the Overwolf client; nothing extra to install
- Build data is refreshed continuously and reflects the current patch
```

*Длина — проверяется командой в разделе 4.*

### Категория и ключевые слова

- **Category:** Games → Deadlock (если доступна), иначе Games → MOBA / Shooter
- **Keywords:** deadlock, build, items, overlay, route, purchase order, counter-build, hero build

---

## 4. Бриф для дизайнера

Четыре картинки. Кладутся **вне** `public/`, иначе уедут в OPK мёртвым весом.

| файл | формат | размер | что на нём |
|---|---|---|---|
| `tile-258x198.jpg` | JPG @72 PPI | **258×198** | плитка приложения в каталоге |
| `store-icon-55x55.png` | PNG | **55×55** | знак; обязан читаться и на тёмном, и на светлом фоне |
| `hero-258x198.jpg` | JPG или WebP | **258×198** | фон шапки страницы приложения |
| `creator-title-400x320.png` | PNG или WebP | **400×320** | фон блока «About the creator» |

**Что рисовать:** тот же знак, что уже собран в иконках — янтарная «D» с кольцом на тёмном фоне
`#041b25`. Мастер лежит в `apps/overwolf-client/public/store/IconMouseOver.png`.

**Скриншоты:** JPG **1200×675**, до 100 КБ каждый, от 1 до 5. Снимать: оверлей поверх матча,
полное desktop-окно, попап. Старый размер 1200×750 больше не поддерживается.

Когда картинки будут — соберу и проверю их так же, как собрал иконки.

---

## 5. Проверка перед отправкой

```bash
# манифест против официальной схемы
yarn workspace @dynamo-lab/overwolf-client check:manifest-schema

# сборка и валидатор
cd apps/overwolf-client
OVERWOLF_API_BASE_URL=https://aboba-telegramovich.duckdns.org yarn build

# описание листинга не длиннее 2000 символов
python3 - <<'PY'
import re
text = open('docs/overwolf-submission-package.md').read()
block = re.search(r'```markdown\n(.*?)\n```', text, re.S).group(1)
print(len(block), 'characters (limit 2000)')
PY

# OPK
python3 apps/overwolf-client/scripts/build-opk.py /tmp/dynamo-lab.opk
```

- [x] Заявка на идею одобрена — **сделано, приложение зарегистрировано**
- [ ] **Ответ DevRel по монетизации получен** (раздел 0) — через <developers@overwolf.com>
- [ ] Четыре ассета нарисованы и загружены
- [ ] Скриншоты сняты
- [ ] Описание вставлено в консоль
- [ ] OPK прогнан через VirusTotal
- [ ] OPK отправлен через форму <https://wkf.ms/3KL8b1m>
