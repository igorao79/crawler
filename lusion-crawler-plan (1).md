# Lusion Crawler — План проекта и промпт для Claude Code

## Обзор

Веб-приложение для парсинга кейсов (проектов) с сайта lusion.co.
Парсер собирает полный HTML-код страниц проектов, CSS, JS-бандлы, ссылки на ассеты (изображения, видео, 3D-модели), мета-данные — и отображает результаты в удобном UI.

---

## Архитектура

```
lusion-crawler/
├── apps/
│   ├── web/                  # Next.js 14+ (App Router) — фронтенд
│   │   ├── app/
│   │   │   ├── page.tsx              # Главная — дашборд
│   │   │   ├── projects/
│   │   │   │   ├── page.tsx          # Список спарсенных проектов
│   │   │   │   └── [slug]/page.tsx   # Детальная страница проекта
│   │   │   └── crawl/page.tsx        # Управление парсингом
│   │   └── components/               # shadcn/ui компоненты
│   │
│   └── server/               # Fastify — бэкенд + краулер
│       ├── src/
│       │   ├── server.ts             # Fastify app + маршруты
│       │   ├── routes/
│       │   │   ├── crawl.ts          # POST /crawl, GET /crawl/status
│       │   │   └── projects.ts       # GET /projects, GET /projects/:slug
│       │   ├── crawler/
│       │   │   ├── engine.ts         # Ядро краулера (Playwright)
│       │   │   ├── extractor.ts      # Извлечение данных со страницы
│       │   │   ├── asset-collector.ts # Сбор ссылок на ассеты
│       │   │   └── queue.ts          # Очередь URL с контролем глубины
│       │   ├── db/
│       │   │   ├── schema.ts         # Схема SQLite (через Drizzle ORM)
│       │   │   └── client.ts         # Подключение к БД
│       │   └── ws/
│       │       └── progress.ts       # WebSocket — прогресс парсинга
│       └── tsconfig.json
│
├── packages/
│   └── shared/               # Общие типы и утилиты
│       └── types.ts          # Project, CrawlJob, CrawlStatus и т.д.
│
├── package.json              # npm workspaces (монорепо)
├── turbo.json                # Turborepo (опционально)
├── docker-compose.yml        # Для удобного запуска
└── README.md
```

---

## Стек технологий

| Слой       | Технология                              |
|------------|-----------------------------------------|
| Frontend   | Next.js 14+ (App Router), TypeScript    |
| UI         | shadcn/ui + Tailwind CSS                |
| Backend    | Fastify, TypeScript                     |
| Краулер    | Playwright                              |
| БД         | SQLite (через Drizzle ORM)              |
| Реалтайм   | WebSocket (через @fastify/websocket)    |
| Тесты      | Vitest                                  |
| Монорепо   | npm workspaces                          |

---

## Правила кода (ОБЯЗАТЕЛЬНО)

### Strict TypeScript — zero `any`
- В **каждом** tsconfig.json включить `"strict": true` и `"noImplicitAny": true`
- Запрещено использовать `any` — вместо этого: конкретные типы, `unknown` + type guards, дженерики
- Все функции должны иметь явные типы параметров и возвращаемых значений
- Для внешних API ответов (Playwright, Fastify request/reply) — писать свои интерфейсы
- ESLint правило: `"@typescript-eslint/no-explicit-any": "error"`

### Unit-тесты — Vitest
- Тест-фреймворк: **Vitest** (быстрый, нативная поддержка TS, совместим с Jest API)
- Минимальное покрытие:
  - `crawler/queue.ts` — добавление URL, дедупликация, контроль глубины
  - `crawler/extractor.ts` — извлечение данных из HTML (мокать Playwright Page)
  - `crawler/asset-collector.ts` — классификация ассетов по типу
  - `routes/projects.ts` — GET/POST эндпоинты (через `fastify.inject()`)
  - `routes/crawl.ts` — создание и получение crawl job
  - `packages/shared/types.ts` — type guards и валидаторы
- Структура тестов: рядом с модулем (`queue.test.ts` рядом с `queue.ts`)
- Моки: Playwright Page/Browser мокать через `vi.mock()`, БД — in-memory SQLite

---

## Модель данных (SQLite)

```sql
-- Сессии парсинга
CREATE TABLE crawl_jobs (
  id           TEXT PRIMARY KEY,
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | error
  started_at   TEXT,
  finished_at  TEXT,
  total_pages  INTEGER DEFAULT 0,
  parsed_pages INTEGER DEFAULT 0,
  max_depth    INTEGER DEFAULT 5,
  error        TEXT
);

-- Спарсенные проекты
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  crawl_job_id TEXT REFERENCES crawl_jobs(id),
  slug         TEXT NOT NULL,
  url          TEXT NOT NULL,
  title        TEXT,
  description  TEXT,
  tags         TEXT,           -- JSON array: ["web", "3d", "design"]
  full_html    TEXT,           -- полный HTML страницы
  scripts      TEXT,           -- JSON array ссылок на JS
  stylesheets  TEXT,           -- JSON array ссылок на CSS
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Ассеты (изображения, видео, 3D-модели, шрифты)
CREATE TABLE assets (
  id           TEXT PRIMARY KEY,
  project_id   TEXT REFERENCES projects(id),
  url          TEXT NOT NULL,
  type         TEXT NOT NULL,  -- image | video | model3d | font | script | stylesheet
  file_path    TEXT,           -- локальный путь если скачан
  size_bytes   INTEGER,
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Вложенные страницы (для глубины > 1)
CREATE TABLE pages (
  id           TEXT PRIMARY KEY,
  crawl_job_id TEXT REFERENCES crawl_jobs(id),
  project_id   TEXT REFERENCES projects(id),
  url          TEXT NOT NULL,
  depth        INTEGER NOT NULL,
  parent_url   TEXT,
  full_html    TEXT,
  title        TEXT,
  status       TEXT DEFAULT 'pending',
  created_at   TEXT DEFAULT (datetime('now'))
);
```

---

## API эндпоинты (Fastify)

| Метод  | Путь                  | Описание                           |
|--------|-----------------------|------------------------------------|
| POST   | /api/crawl            | Запустить парсинг (max_depth в body) |
| GET    | /api/crawl/:id        | Статус конкретного задания          |
| GET    | /api/crawl/:id/logs   | Логи парсинга                      |
| DELETE | /api/crawl/:id        | Отменить/удалить задание            |
| GET    | /api/projects         | Список спарсенных проектов          |
| GET    | /api/projects/:slug   | Детали проекта + ассеты             |
| WS     | /ws/crawl/:id         | Реалтайм прогресс                  |

---

## UI страницы (Next.js)

### 1. Дашборд (`/`)
- Статистика: всего проектов, последний парсинг, кол-во ассетов
- Кнопка «Запустить парсинг»
- Список последних сессий парсинга

### 2. Управление парсингом (`/crawl`)
- Настройки: макс. глубина (1–5), таймауты
- Прогресс-бар в реальном времени (WebSocket)
- Лог парсинга: какие URL обрабатываются прямо сейчас

### 3. Список проектов (`/projects`)
- Карточки проектов с превью
- Фильтрация по тегам (web, 3d, design...)
- Поиск по названию

### 4. Детали проекта (`/projects/[slug]`)
- Мета-информация (название, описание, теги)
- Превью HTML (iframe или скриншот)
- Список ассетов с типами и размерами
- Дерево вложенных страниц (до глубины 5)
- Возможность скачать HTML/ассеты

---

## Логика краулера (ключевая часть)

```
1. Запуск: POST /api/crawl → создаётся crawl_job

2. Этап 1 — Сбор списка проектов:
   → Playwright идёт на https://lusion.co/projects
   → Ждёт рендеринг JS (networkidle)
   → Собирает все ссылки /projects/*

3. Этап 2 — Парсинг каждого проекта:
   Для каждого /projects/{slug}:
   → Открывает страницу в Playwright
   → Ждёт полный рендеринг
   → Сохраняет: полный HTML (page.content())
   → Извлекает: title, description, теги
   → Собирает ассеты: img src, video src, .glb/.gltf, .js, .css
   → Ищет внутренние ссылки → добавляет в очередь

4. Этап 3 — Обход вглубь (BFS):
   → Для каждой найденной внутренней ссылки
   → Если depth < max_depth → парсить
   → Контроль: visited set, domain filter (*.lusion.co)
   → Сохранение в таблицу pages

5. На каждом шаге → WebSocket отправляет прогресс клиенту
```

---

## План работы по дням

### День 1: Скаффолдинг
- [ ] Инициализация монорепо (npm workspaces)
- [ ] Настройка Next.js + TypeScript + Tailwind + shadcn/ui
- [ ] Настройка Fastify + TypeScript
- [ ] Настройка SQLite + Drizzle ORM, миграции
- [ ] Общие типы в packages/shared
- [ ] Git repo: https://github.com/igorao79/crawler.git

### День 2–3: Ядро краулера
- [ ] Playwright: открытие страницы, ожидание рендеринга
- [ ] Сбор списка проектов с /projects
- [ ] Парсинг одного проекта: HTML, мета, теги
- [ ] Сбор ассетов (img, video, 3D, js, css)
- [ ] BFS-очередь с контролем глубины до 5
- [ ] Сохранение в SQLite

### День 4: API + WebSocket
- [ ] Все REST-эндпоинты
- [ ] WebSocket для прогресса
- [ ] Обработка ошибок, retry (3 попытки на страницу)

### День 5: Фронтенд
- [ ] Дашборд
- [ ] Страница парсинга с прогрессом
- [ ] Список проектов с фильтрами
- [ ] Детальная страница проекта

### День 6: Полировка
- [ ] Edge-кейсы: таймауты, битые ссылки, редиректы
- [ ] Rate limiting (не DDoS'ить lusion.co — задержка между запросами)
- [ ] Красивый UI, анимации загрузки
- [ ] Валидация входных данных

### День 7: Финализация
- [ ] README с инструкцией запуска
- [ ] Docker-compose для one-click запуска
- [ ] Базовые тесты (хотя бы для краулера)
- [ ] Финальный push в GitHub

---

## Промпт для Claude Code

Ниже — промпт, который можно скормить Claude Code поэтапно.
**Не давай всё сразу — разбей на шаги.**

### Шаг 1: Инициализация

```
Создай монорепо для проекта "Lusion Crawler" с npm workspaces:

Структура:
- apps/web — Next.js 14 (App Router) + TypeScript + Tailwind CSS + shadcn/ui
- apps/server — Fastify + TypeScript + Playwright + Drizzle ORM + SQLite
- packages/shared — общие TypeScript-типы

Настрой:
- tsconfig.json с path aliases, strict: true, noImplicitAny: true
- ESLint + Prettier + правило "@typescript-eslint/no-explicit-any": "error"
- Vitest для тестов (конфиг в каждом app)
- .gitignore
- package.json скрипты: dev, build, lint, test для каждого пакета

СТРОГОЕ ПРАВИЛО: нигде в проекте не использовать тип `any`. Вместо any — конкретные интерфейсы, unknown + type guards, дженерики. Это правило действует для ВСЕХ шагов.

Используй context7 для актуальной документации Next.js, Fastify, Drizzle и Vitest.
```

### Шаг 2: База данных

```
В apps/server настрой SQLite через Drizzle ORM.

Таблицы:
- crawl_jobs (id, status, started_at, finished_at, total_pages, parsed_pages, max_depth, error)
- projects (id, crawl_job_id, slug, url, title, description, tags JSON, full_html, scripts JSON, stylesheets JSON)
- assets (id, project_id, url, type, file_path, size_bytes)
- pages (id, crawl_job_id, project_id, url, depth, parent_url, full_html, title, status)

Создай миграции и seed-скрипт.

Напиши unit-тесты (Vitest):
- Тест создания/чтения crawl_job
- Тест вставки и выборки project с JSON-полями (tags, scripts)
- Тест связей: project → assets, crawl_job → pages
- Использовать in-memory SQLite для тестов
```

### Шаг 3: Краулер

```
Создай модуль краулера в apps/server/src/crawler/:

1. engine.ts — основной класс Crawler:
   - Принимает max_depth (до 5) и crawl_job_id
   - Запускает Playwright browser
   - BFS-обход: начинает с https://lusion.co/projects
   - Для каждого /projects/{slug} — парсит страницу
   - Следует по внутренним ссылкам до max_depth
   - Контролирует: visited URLs, domain filter (*.lusion.co), delay между запросами (1-2 сек)

2. extractor.ts — извлечение данных:
   - page.content() для полного HTML
   - title, meta description
   - теги проекта (из DOM)
   - все ссылки на ассеты: img, video, source, link[rel=stylesheet], script[src]
   - ссылки на 3D-модели (.glb, .gltf, .obj)

3. queue.ts — очередь URL:
   - BFS с приоритетом по глубине
   - Дедупликация URL (normalize trailing slash, query params)

4. asset-collector.ts — каталогизация ассетов по типу

Сохраняй всё в SQLite через Drizzle. Отправляй прогресс через callback.

Напиши unit-тесты (Vitest) для каждого модуля:
- queue.test.ts: добавление URL, дедупликация, нормализация (trailing slash), контроль max depth, domain filter
- extractor.test.ts: мокнуть Playwright Page (vi.mock), проверить извлечение title/description/tags/assets из тестового HTML
- asset-collector.test.ts: классификация URL по типам (image/video/model3d/font/script/stylesheet)
- engine.test.ts: проверить BFS-обход на моковых данных, проверить что visited set работает

Все типы — строгие интерфейсы, никаких `any`. Для Playwright Page использовать свой интерфейс-обёртку.
```

### Шаг 4: API

```
Создай Fastify-маршруты в apps/server/src/routes/:

REST:
- POST /api/crawl — запускает парсинг, возвращает job_id
- GET /api/crawl/:id — статус задания
- DELETE /api/crawl/:id — отмена
- GET /api/projects — список проектов (с пагинацией, фильтрами по тегам)
- GET /api/projects/:slug — детали проекта + ассеты + вложенные страницы

WebSocket через @fastify/websocket:
- /ws/crawl/:id — стримит прогресс: { parsed, total, currentUrl, status }

Добавь CORS для Next.js (localhost:3000).
Используй context7 для документации Fastify.

Напиши unit-тесты (Vitest) для каждого маршрута через fastify.inject():
- POST /api/crawl — создаёт job, возвращает id и status
- GET /api/crawl/:id — возвращает корректный статус
- GET /api/projects — пагинация, фильтр по тегам
- GET /api/projects/:slug — возвращает проект + ассеты + pages
- DELETE /api/crawl/:id — отмена задания
- Тестировать валидацию входных данных (невалидный max_depth, несуществующий id)

Все request/response body — типизированы через интерфейсы из packages/shared. Никаких `any`.
```

### Шаг 5: Фронтенд

```
Создай UI в apps/web на Next.js App Router + shadcn/ui:

Страницы:
1. / — дашборд: статистика + кнопка "Начать парсинг" + история заданий
2. /crawl — настройки парсинга + реалтайм прогресс (WebSocket)
3. /projects — карточки проектов с фильтрацией по тегам и поиском
4. /projects/[slug] — детали: мета, превью HTML, дерево страниц, список ассетов

shadcn/ui компоненты: Card, Table, Badge, Progress, Button, Input, Dialog, Tabs, ScrollArea

Дизайн: тёмная тема, минималистичный, в стиле dev-tools.
Используй context7 для документации shadcn/ui.

Напиши unit-тесты (Vitest + React Testing Library):
- Компонент списка проектов: рендеринг карточек, фильтрация по тегам
- Компонент прогресса: отображение статуса, обновление прогресс-бара
- Хуки: useCrawlStatus (WebSocket), useProjects (fetch + кэш)

Все пропсы компонентов и ответы API — строго типизированы. Никаких `any` или `as any` в тестах.
```

---

## Что произведёт впечатление на ревьюера

1. **Типизация** — строгие интерфейсы, никаких `any`
2. **Архитектура** — чёткое разделение: краулер / API / UI
3. **Реалтайм** — WebSocket прогресс, а не polling
4. **Robustness** — retry, таймауты, rate limiting, graceful shutdown
5. **README** — одна команда для запуска, скриншоты, описание архитектуры
6. **Docker** — `docker-compose up` и всё работает
