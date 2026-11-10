import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
  return c.json({ error: "Could not reach the provider. Check the network or try again later." }, 502);
}

export const proxyRoutes = new Hono();

proxyRoutes.post(
  "/transcribe/:provider",
  bodyLimit({
    maxSize: PROXY_BODY_LIMIT,
    onError: (c) => c.json({ error: "File is too large (proxy limit is 110 MB)" }, 413),
  }),
  async (c) => {
    const provider = c.req.param("provider");
    const apiKey = c.req.header("x-api-key") ?? "";
    if (!apiKey) return c.json({ error: "Missing API key" }, 401);

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
    if (!base) return c.json({ error: "Unknown provider" }, 400);
    if (body.byteLength > PROVIDER_ASR_LIMIT) {
      return c.json({ error: "File exceeds the provider limit (25 MB)" }, 413);
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
    if (!apiKey) return c.json({ error: "Missing API key" }, 401);

    const cfg = AI_HOSTS[provider];
    if (!cfg) return c.json({ error: "Unknown provider" }, 400);

    let payload: { prompt?: unknown; text?: unknown; model?: unknown };
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const prompt = String(payload.prompt ?? "").slice(0, 4000);
    const text = String(payload.text ?? "").slice(0, 400_000);
    // модель приходит от клиента, но ограничена белым списком формата
    const model = typeof payload.model === "string" && /^[\w./-]{3,80}$/.test(payload.model)
      ? payload.model
      : cfg.model;
    if (!prompt || !text) return c.json({ error: "Empty prompt or text" }, 400);

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

// ── Произвольные OpenAI-совместимые сервисы ─────────────────────────────
//
// Клиент по умолчанию ходит к своему сервису напрямую из браузера. Этот
// маршрут — запасной путь для сервисов без CORS-заголовков. Он превращает
// сервер в ретранслятор на адрес, который прислал клиент, поэтому:
//   • выключен, пока администратор не задаст CUSTOM_ENDPOINT_PROXY=1;
//   • разрешён только https и только публичные адреса (защита от SSRF:
//     localhost, 10/8, 172.16/12, 192.168/16, 169.254/16 и IPv6-аналоги
//     отклоняются после DNS-резолва); редиректы не выполняются;
//   • CUSTOM_ENDPOINT_PROXY_ALLOW_PRIVATE=1 снимает ограничение на адреса и
//     http — для своего Ollama/vLLM в одной docker-сети с приложением.
// Токен приходит в x-api-key и используется только для текущего запроса.

const CUSTOM_PROXY_ENABLED = /^(1|true)$/i.test(process.env.CUSTOM_ENDPOINT_PROXY ?? "");
const CUSTOM_PROXY_ALLOW_PRIVATE = /^(1|true)$/i.test(
  process.env.CUSTOM_ENDPOINT_PROXY_ALLOW_PRIVATE ?? "",
);

const CUSTOM_OPS: Record<string, { method: "GET" | "POST"; path: string }> = {
  models: { method: "GET", path: "/models" },
  chat: { method: "POST", path: "/chat/completions" },
  transcribe: { method: "POST", path: "/audio/transcriptions" },
  translate: { method: "POST", path: "/audio/translations" },
};

export function isPrivateAddress(ip: string): boolean {
  const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const addr = mapped ? mapped[1] : ip.toLowerCase();
  if (isIP(addr) === 4) {
    const [a, b] = addr.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    );
  }
  if (isIP(addr) === 6) {
    return (
      addr === "::" ||
      addr === "::1" ||
      addr.startsWith("fc") ||
      addr.startsWith("fd") ||
      /^fe[89ab]/.test(addr) ||
      addr.startsWith("ff")
    );
  }
  return true; // не IP — не пускаем
}

async function resolveCustomBase(raw: string): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (CUSTOM_PROXY_ALLOW_PRIVATE) {
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  } else {
    if (u.protocol !== "https:") return null;
    try {
      const host = u.hostname.replace(/^\[|\]$/g, "");
      const addrs = await lookup(host, { all: true });
      if (addrs.length === 0 || addrs.some((a) => isPrivateAddress(a.address))) return null;
    } catch {
      return null;
    }
  }
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

proxyRoutes.all(
  "/custom/:op",
  bodyLimit({
    maxSize: PROXY_BODY_LIMIT,
    onError: (c) => c.json({ error: "File is too large (proxy limit is 110 MB)" }, 413),
  }),
  async (c) => {
    if (!CUSTOM_PROXY_ENABLED) {
      return c.json(
        { error: "Custom endpoint proxy is disabled on this server (CUSTOM_ENDPOINT_PROXY=1 enables it)" },
        403,
      );
    }
    const op = CUSTOM_OPS[c.req.param("op")];
    if (!op || c.req.method !== op.method) return c.json({ error: "Unknown operation" }, 400);
    const base = await resolveCustomBase(c.req.header("x-base-url") ?? "");
    if (!base) {
      return c.json({ error: "Endpoint URL is not allowed (public https addresses only)" }, 400);
    }
    const headers: Record<string, string> = {};
    const apiKey = c.req.header("x-api-key");
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    let body: ArrayBuffer | undefined;
    if (op.method === "POST") {
      headers["Content-Type"] = c.req.header("content-type") ?? "application/json";
      body = await c.req.arrayBuffer();
    }
    let res: globalThis.Response;
    try {
      res = await upstream(`${base}${op.path}`, {
        method: op.method,
        headers,
        body,
        redirect: "manual",
      });
    } catch (e) {
      if (e instanceof UpstreamError) return upstreamFailed(c);
      throw e;
    }
    if (res.status >= 300 && res.status < 400) {
      return c.json({ error: "Endpoint answered with a redirect; redirects are not followed" }, 502);
    }
    return passthrough(res, await res.text());
  },
);
