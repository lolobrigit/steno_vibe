import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

/**
 * Прокси к облачным ASR/LLM API. Нужен, потому что прямые запросы из браузера
 * к api.openai.com / api.groq.com блокируются CORS (проверено: preflight 403/нет ACAO),
 * а api.deepgram.com CORS разрешает. Ключ приезжает в заголовке x-api-key и
 * используется только для текущего запроса — на сервере не сохраняется.
 */

const PROVIDER_ASR_LIMIT = 25 * 1024 * 1024; // OpenAI / Groq: 25 МБ
const PROXY_BODY_LIMIT = 110 * 1024 * 1024;

const ASR_HOSTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
};

const AI_HOSTS: Record<string, { url: string; model: string }> = {
  groq: {
    url: "https://api.groq.com/openai/v1/chat/completions",
    // llama-3.3-70b-versatile снят Groq 16.08.2026; рекомендованная замена — gpt-oss-120b
    model: "openai/gpt-oss-120b",
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
  },
};

function passthrough(res: globalThis.Response, body: string): Response {
  return new Response(body, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

/** fetch к провайдеру с понятной ошибкой, если сеть до него недоступна */
async function upstream(url: string, init: RequestInit): Promise<globalThis.Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new UpstreamError();
  }
}

class UpstreamError extends Error {}

function upstreamFailed(c: { json: (body: unknown, status: number) => Response }): Response {
  return c.json({ error: "Не удалось связаться с провайдером. Проверьте сеть или попробуйте позже." }, 502);
}

export const proxyRoutes = new Hono();

proxyRoutes.post(
  "/transcribe/:provider",
  bodyLimit({
    maxSize: PROXY_BODY_LIMIT,
    onError: (c) => c.json({ error: "Файл слишком большой (лимит прокси — 110 МБ)" }, 413),
  }),
  async (c) => {
    const provider = c.req.param("provider");
    const apiKey = c.req.header("x-api-key") ?? "";
    if (!apiKey) return c.json({ error: "Нет API-ключа" }, 401);

    const q = c.req.query();
    const fileName = decodeURIComponent(c.req.header("x-file-name") ?? "audio");
    const contentType = c.req.header("content-type") ?? "application/octet-stream";
    const body = await c.req.arrayBuffer();

    if (provider === "deepgram") {
      const params = new URLSearchParams({
        model: q.model ?? "nova-3",
        smart_format: "true",
        paragraphs: "true",
      });
      if (q.diarize === "true") params.set("diarize", "true");
      if (q.language) params.set("language", q.language);
      else params.set("detect_language", "true");
      // справочник терминов → keyterm (по одному на параметр, лимит ~100)
      if (q.prompt) {
        for (const term of q.prompt.split(/[,\n;]/).map((t) => t.trim()).filter(Boolean).slice(0, 100)) {
          params.append("keyterm", term);
        }
      }

      let res: globalThis.Response;
      try {
        res = await upstream(`https://api.deepgram.com/v1/listen?${params}`, {
          method: "POST",
          headers: { Authorization: `Token ${apiKey}`, "Content-Type": contentType },
          body,
        });
      } catch (e) {
        if (e instanceof UpstreamError) return upstreamFailed(c);
        throw e;
      }
      return passthrough(res, await res.text());
    }

    const base = ASR_HOSTS[provider];
    if (!base) return c.json({ error: "Неизвестный провайдер" }, 400);
    if (body.byteLength > PROVIDER_ASR_LIMIT) {
      return c.json({ error: "Файл больше лимита сервиса (25 МБ)" }, 413);
    }

    const translate = q.translate === "true";
    const path = translate ? "/audio/translations" : "/audio/transcriptions";
    const form = new FormData();
    form.append("file", new Blob([body], { type: contentType }), fileName);
    form.append("model", q.model ?? "whisper-1");
    form.append("response_format", "verbose_json");
    if (q.language && !translate) form.append("language", q.language);
    if (!translate) form.append("timestamp_granularities[]", "segment");
    // справочник терминов → prompt (Whisper API использует как словарную подсказку)
    if (q.prompt) form.append("prompt", q.prompt.slice(0, 896));

    let res: globalThis.Response;
    try {
      res = await upstream(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
    } catch (e) {
      if (e instanceof UpstreamError) return upstreamFailed(c);
      throw e;
    }
    return passthrough(res, await res.text());
  },
);

proxyRoutes.post(
  "/ai/:provider",
  bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.body(null, 413) }),
  async (c) => {
    const provider = c.req.param("provider");
    const apiKey = c.req.header("x-api-key") ?? "";
    if (!apiKey) return c.json({ error: "Нет API-ключа" }, 401);

    const cfg = AI_HOSTS[provider];
    if (!cfg) return c.json({ error: "Неизвестный провайдер" }, 400);

    let payload: { prompt?: unknown; text?: unknown; model?: unknown };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Некорректный JSON" }, 400);
    }
    const prompt = String(payload.prompt ?? "").slice(0, 4000);
    const text = String(payload.text ?? "").slice(0, 400_000);
    // модель приходит от клиента, но ограничена белым списком формата
    const model = typeof payload.model === "string" && /^[\w./-]{3,80}$/.test(payload.model)
      ? payload.model
      : cfg.model;
    if (!prompt || !text) return c.json({ error: "Пустой prompt или text" }, 400);

    let res: globalThis.Response;
    try {
      res = await upstream(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: prompt },
            { role: "user", content: text },
          ],
        }),
      });
    } catch (e) {
      if (e instanceof UpstreamError) return upstreamFailed(c);
      throw e;
    }
    return passthrough(res, await res.text());
  },
);
