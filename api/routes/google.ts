import { Hono } from "hono";

/**
 * Вход в Google Диск через серверные учётные данные.
 *
 * Client ID и Client secret лежат только на сервере (GOOGLE_CLIENT_ID,
 * GOOGLE_CLIENT_SECRET), пользователю и браузеру секрет не отдаётся. Схема:
 *   1. браузер открывает всплывающее окно /api/google/start (state придумывает он сам);
 *   2. сервер перенаправляет на Google (authorization code flow, scope drive.file);
 *   3. Google возвращает код на /api/google/callback, сервер меняет его на токен
 *      доступа и отдаёт страницу, которая через postMessage передаёт токен окну-родителю;
 *   4. дальше браузер сам загружает и скачивает файлы напрямую в Drive.
 * Refresh-токены не запрашиваются и не хранятся: токен живёт около часа.
 *
 * Redirect URI, который нужно добавить в Google Cloud → OAuth client → Authorized redirect URIs:
 *   GOOGLE_REDIRECT_URI, если задан; иначе https://<хост>/<префикс>/api/google/callback
 *   (хост берётся из заголовков прокси, префикс — из параметра base, который шлёт приложение).
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive.file";

export const googleRoutes = new Hono();

function creds() {
  const id = process.env.GOOGLE_CLIENT_ID ?? "";
  const secret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  return id && secret ? { id, secret } : null;
}

function redirectUri(c: { req: { header: (n: string) => string | undefined; url: string } }, base: string): string {
  const fixed = process.env.GOOGLE_REDIRECT_URI;
  if (fixed) return fixed;
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host") ?? new URL(c.req.url).host;
  const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
  return `${proto}://${host}${base}api/google/callback`;
}

/** Префикс приложения: только безопасные символы, начинается и заканчивается на «/». */
function safeBase(v: string | undefined): string {
  return v && /^\/([\w.-]+\/)*$/.test(v) ? v : "/";
}

function safeState(v: string | undefined): string {
  return v && /^[\w.~-]{8,128}$/.test(v) ? v : "";
}

/** Включён ли вход через сервер (заданы ли GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET). */
googleRoutes.get("/status", (c) => c.json({ enabled: !!creds() }));

googleRoutes.get("/start", (c) => {
  const k = creds();
  const state = safeState(c.req.query("state"));
  if (!k || !state) return c.text("Google Drive is not configured on the server", 400);
  const base = safeBase(c.req.query("base"));
  const url =
    AUTH_URL +
    "?" +
    new URLSearchParams({
      client_id: k.id,
      redirect_uri: redirectUri(c, base),
      response_type: "code",
      scope: SCOPE,
      access_type: "online",
      prompt: "select_account",
      // base нужен на обратном пути, чтобы собрать тот же redirect_uri при обмене кода
      state: `${state}.${encodeURIComponent(base)}`,
    });
  return c.redirect(url, 302);
});

/** Страница, которая передаёт результат окну-родителю и закрывается. */
function relay(state: string, params: Record<string, string>): Response {
  const payload = JSON.stringify({ type: "steno-oauth", state, params }).replace(/</g, "\\u003c");
  const html = `<!doctype html><meta charset="utf-8"><title>STENO</title><body>You can close this window.<script>
try { window.opener && window.opener.postMessage(${payload}, window.location.origin) } catch (e) {}
window.close()
</script>`;
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

googleRoutes.get("/callback", async (c) => {
  const raw = c.req.query("state") ?? "";
  const dot = raw.indexOf(".");
  const state = safeState(dot > 0 ? raw.slice(0, dot) : raw);
  const base = safeBase(dot > 0 ? decodeURIComponent(raw.slice(dot + 1)) : "/");
  if (!state) return c.text("Bad state", 400);

  const err = c.req.query("error");
  if (err) return relay(state, { error: err, error_description: c.req.query("error_description") ?? "" });

  const code = c.req.query("code");
  const k = creds();
  if (!code || !k) return relay(state, { error: "invalid_request" });

  try {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: k.id,
        client_secret: k.secret,
        redirect_uri: redirectUri(c, base),
        grant_type: "authorization_code",
      }),
    });
    const j = (await res.json()) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !j.access_token) {
      return relay(state, { error: j.error ?? "token_error", error_description: j.error_description ?? "" });
    }
    return relay(state, { access_token: j.access_token, expires_in: String(j.expires_in ?? 3600) });
  } catch {
    return relay(state, { error: "network" });
  }
});
