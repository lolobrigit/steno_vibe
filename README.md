# steno_vibe

Веб-приложение для распознавания речи и работы с расшифровкой: локальный и облачный ASR, диаризация спикеров, LLM-обработка текста, справочники терминов, экспорт и облачная синхронизация проектов. Всё распознавание и обработка выполняются прямо в браузере (WebGPU/WASM) — аудио никуда не отправляется, если вы не выбрали облачный провайдер.

## Возможности

- **Распознавание речи**
  - Локальный Whisper через transformers.js (ONNX, WebGPU/WASM): Tiny, Base, Small, Large v3 Turbo.
  - Облачные провайдеры: Groq, OpenAI (Whisper v2, GPT-4o Transcribe), Deepgram Nova-3.
  - Свои OpenAI-совместимые сервисы (whisper.cpp и прочие): base URL + токен, загрузка `/models`, ручное добавление моделей, серверный прокси для сервисов без CORS.
  - Конвертация входного файла в WAV (ffmpeg.wasm) перед отправкой в сервис.
  - Пословные метки времени для точных субтитров (опционально).
- **Диаризация спикеров** — локально в браузере (pyannote segmentation + WeSpeaker ResNet34, Kaldi-совместимый fbank). У Deepgram — на стороне сервиса.
- **Работа с текстом**
  - Версии расшифровки (asr / llm / edit): каждая попытка — отдельная версия, к любой можно вернуться.
  - Правка текста реплик, ручное переназначение и объединение спикеров, разделение реплик.
  - Поиск и замена, отмена/повтор, закладки и заметки к репликам, чистка слов-паразитов.
  - Сравнение версий с подсветкой различий.
- **LLM-обработка** — локальная (Qwen3 0.6B/1.7B/4B через transformers.js) и облачная (Groq, OpenAI, свои сервисы). Встроенные действия: грамматика, чистка, краткое содержание, восстановление терминов, извлечение задач. Структура разговора (таймкоды и спикеры) сохраняется между запросами.
- **Справочники терминов** — три колонки: термин / замена / пояснение. Уходят в Whisper (initial_prompt) и в промпт LLM markdown-таблицей. Импорт/экспорт CSV.
- **Экспорт** — TXT, SRT, VTT, Markdown, HTML (со скриншотами или без), видео со вшитыми субтитрами (WebM). Предпросмотр перед скачиванием.
- **Хранилище проектов** — оригинал, WAV, версии asr/llm/edit. Облачный экспорт: Google Drive (в т.ч. через серверные креды), Яндекс Диск, Dropbox.
- **i18n** — 13 языков (en, es, de, ja, fr, pt, ru, it, nl, pl, tr, id, zh), выбор в настройках, `?lang=xx`.
- **SEO** — canonical, hreflang, JSON-LD, sitemap.xml, robots.txt при заданном `SITE_URL`.

## Стек

React 19, Vite 7, TypeScript, Tailwind CSS, shadcn/ui (40+ компонентов), TanStack Query, tRPC (клиент и сервер), Hono, Drizzle ORM, MySQL, transformers.js, FFmpeg.wasm, Vitest.

## Быстрый старт

```bash
npm install
cp .env.example .env   # заполнить при необходимости
npm run db:push        # применить схему БД (MySQL)
npm run dev            # фронтенд + dev-сервер Hono
```

Сборка и запуск прод-сервера:

```bash
npm run build          # vite build + esbuild api/boot.ts → dist/
npm start              # NODE_ENV=production node dist/boot.js
```

Проверка типов, линтер и тесты:

```bash
npm run check
npm run lint
npm run test
```

## Переменные окружения

См. [`.env.example`](.env.example). Основные группы:

| Группа | Переменные | Назначение |
| --- | --- | --- |
| Database | `DATABASE_URL` | строка подключения MySQL |
| Frontend | `APP_VERSION` | версия приложения (подставляется в футер) |
| SEO | `SITE_URL` | canonical, hreflang, sitemap, JSON-LD |
| Облачный экспорт | `VITE_GDRIVE_CLIENT_ID`, `VITE_YANDEX_CLIENT_ID`, `VITE_DROPBOX_APP_KEY` | браузерный OAuth (необязательно) |
| Google Drive (сервер) | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI` | вход выполняет сервер, секрет не попадает в браузер |

Облачные ключи ASR/LLM (OpenAI, Groq, Deepgram) вводятся в окне настроек приложения и хранятся в браузере — их не нужно класть в `.env`.

## Архитектура

```
src/
  sections/      UI-секции (SourcePanel, EnginePanel, AiPanel, TranscriptView, SettingsModal, …)
  pages/         Home.tsx — оркестрация распознавания, диаризации и LLM
  lib/           логика: ai, audio, diarize, dsp, transcript, storage, glossaryCsv, exporters, downloads, modelPlan, …
  workers/       Web Workers: whisper.worker, diarize.worker, ai.worker
  i18n/          словари (13 языков, lazy-loaded)
  components/    shadcn/ui + Waveform
api/             tRPC-роутеры, middleware, серверный прокси (/api/proxy/ai, /api/proxy/asr)
db/              Drizzle schema, relations, migrations, seed
contracts/       общие типы и константы фронт/бэк
docs/            NATIVE_APPS.md — нативные клиенты (macOS/Windows/iOS/Android)
```

Пайплайн: источник (файл/запись/папка) → декодирование (нативно или ffmpeg.wasm) → загрузка модели (менеджер загрузок с докачкой и SHA-256) → ASR (локально или облако) → диаризация (параллельно в отдельном worker) → версии расшифровки → LLM-обработка → экспорт.

Справочники: каждая запись — `{ term, replacement?, note? }`. В Whisper `initial_prompt` уходит плоская строка (`term = replacement`), в промпт LLM — markdown-таблица `term | replacement | note`. Старый формат `terms: string[]` мигрирует в `entries` при загрузке.

## Лицензия

См. [LICENSE](LICENSE).
