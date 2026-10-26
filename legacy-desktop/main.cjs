const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("node:path");
const { createServer } = require("node:http");

const SITE = "https://www.wiki-masters.com";
const SUPABASE = "https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1";
const COMPANION_PORT = 4174;
const ALLOWED_ORIGINS = new Set(["https://sfire2.github.io", "http://localhost:4173", "http://127.0.0.1:4173"]);
const wmSession = session.fromPartition("persist:wikimasters");
let mainWindow;
let loginWindow;
let anonKeyPromise;

function makeWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: "#091311",
    title: "WikiMasters · Cotes",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: wmSession,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "index.html"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SITE)) shell.openExternal(url);
    return { action: "deny" };
  });
}

function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: "Connexion WikiMasters",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, session: wmSession },
  });
  loginWindow.on("closed", () => { loginWindow = null; });
  loginWindow.loadURL(`${SITE}/login`);
}

async function siteCookies() {
  const cookies = await wmSession.cookies.get({ url: SITE });
  return cookies;
}

async function authContext() {
  const cookies = await siteCookies();
  const cookieHeader = cookies.map(({ name, value }) => `${name}=${value}`).join("; ");
  const authChunks = cookies
    .filter(({ name }) => /^sb-[\w-]+-auth-token(?:\.\d+)?$/.test(name))
    .sort((a, b) => Number(a.name.match(/\.(\d+)$/)?.[1] || 0) - Number(b.name.match(/\.(\d+)$/)?.[1] || 0));
  const encoded = authChunks.map(({ value }) => value).join("");
  let accessToken = null;
  try {
    const decodedValue = decodeURIComponent(encoded);
    const decoded = decodedValue.startsWith("base64-")
      ? Buffer.from(decodedValue.slice(7).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
      : decodedValue;
    const parsed = JSON.parse(decoded);
    accessToken = (Array.isArray(parsed) ? parsed[0] : parsed.access_token) || null;
  } catch { /* Une session absente ou expirée ne donne pas de jeton lisible. */ }
  return { cookies, cookieHeader, accessToken };
}

async function getAnonKey() {
  if (!anonKeyPromise) {
    anonKeyPromise = (async () => {
      const { cookieHeader } = await authContext();
      const page = await wmSession.fetch(SITE, { headers: cookieHeader ? { cookie: cookieHeader } : {} });
      if (!page.ok) throw new Error("Impossible de joindre WikiMasters.");
      const html = await page.text();
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']*\/_next\/static\/[^"']+\.js)["']/g)]
        .map((match) => new URL(match[1], SITE).href);
      const keyPattern = /eyJ[\w-]{10,}\.eyJ[\w-]{20,}\.[\w-]{10,}/;
      for (let offset = 0; offset < scripts.length; offset += 8) {
        const sources = await Promise.all(scripts.slice(offset, offset + 8).map(async (url) => {
          try {
            const response = await wmSession.fetch(url);
            return response.ok ? response.text() : "";
          } catch { return ""; }
        }));
        for (const source of sources) {
          const key = source.match(keyPattern)?.[0];
          if (key) return key;
        }
      }
      throw new Error("La clé publique WikiMasters est introuvable.");
    })().catch((error) => {
      anonKeyPromise = null;
      throw error;
    });
  }
  return anonKeyPromise;
}

function validCardId(value) {
  return typeof value === "string" && /^[\w-]{12,}$/.test(value);
}

async function supabaseFetch(url) {
  const [{ accessToken }, key] = await Promise.all([authContext(), getAnonKey()]);
  const bearer = accessToken || key;
  const response = await wmSession.fetch(url, { headers: { apikey: key, Authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`Réponse WikiMasters indisponible (HTTP ${response.status}).`);
  return response.json();
}

async function cardHistory(cardId, rarity) {
  if (!validCardId(cardId) || !["C", "R", "SR", "UR", "PC", "L"].includes(rarity)) {
    throw new Error("Carte ou rareté invalide.");
  }
  const { accessToken } = await authContext();
  if (!accessToken) throw new Error("Connecte-toi à WikiMasters dans la fenêtre ouverte par le compagnon.");
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const url = new URL(`${SUPABASE}/auctions`);
  url.searchParams.set("select", "end_at,current_bid");
  url.searchParams.set("card_id", `eq.${cardId}`);
  url.searchParams.set("snapshot_rarity", `eq.${rarity}`);
  url.searchParams.set("status", "eq.settled_sold");
  url.searchParams.set("end_at", `gte.${since}`);
  url.searchParams.set("order", "end_at.asc");
  url.searchParams.set("limit", "1000");
  return supabaseFetch(url);
}

function startCompanionServer() {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const host = String(req.headers.host || "").toLowerCase();
    if (!ALLOWED_ORIGINS.has(origin) || !["127.0.0.1:4174", "localhost:4174"].includes(host)) {
      res.writeHead(403, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ error: "Origine refusée." }));
      return;
    }
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type",
      "Access-Control-Allow-Private-Network": "true",
      "Cache-Control": "no-store",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }
    const url = new URL(req.url || "/", `http://127.0.0.1:${COMPANION_PORT}`);
    try {
      if (req.method === "GET" && url.pathname === "/api/status") {
        const { accessToken } = await authContext();
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify({ available: true, connected: Boolean(accessToken) }));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/login") {
        openLoginWindow();
        res.writeHead(202, cors).end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/history") {
        const rows = await cardHistory(url.searchParams.get("cardId"), url.searchParams.get("rarity"));
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify(rows));
        return;
      }
      res.writeHead(404, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Route introuvable." }));
    } catch (error) {
      res.writeHead(error.status || 502, { ...cors, "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message || "Erreur du compagnon." }));
    }
  });
  server.listen(COMPANION_PORT, "127.0.0.1");
  server.on("listening", () => console.log(`Compagnon WikiMasters prêt sur http://127.0.0.1:${COMPANION_PORT}`));
  server.on("error", (error) => console.error("Compagnon local :", error.message));
}

ipcMain.handle("auth:status", async () => {
  const { accessToken, cookies } = await authContext();
  return { connected: Boolean(accessToken && cookies.length) };
});

ipcMain.handle("auth:open-login", async () => {
  openLoginWindow();
});

ipcMain.handle("cards:search", async (_event, query) => {
  if (typeof query !== "string" || query.trim().length < 2 || query.length > 100) return [];
  const url = new URL(`${SUPABASE}/cards`);
  url.searchParams.set("select", "id,rarity,wikipedia_title");
  url.searchParams.set("lang", "eq.fr");
  url.searchParams.set("wikipedia_title", `ilike.*${query.trim()}*`);
  url.searchParams.set("limit", "12");
  url.searchParams.set("order", "wikipedia_title.asc");
  return supabaseFetch(url);
});

ipcMain.handle("card:prices", async (_event, cardId) => {
  if (!validCardId(cardId)) throw new Error("Identifiant de carte invalide.");
  const { cookieHeader } = await authContext();
  const response = await wmSession.fetch(`${SITE}/api/marketplace/cards/${encodeURIComponent(cardId)}/sales?scope=summary`, {
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      origin: SITE,
      referer: `${SITE}/marketplace`,
    },
  });
  if (!response.ok) throw new Error(`La cote est indisponible (HTTP ${response.status}).`);
  return response.json();
});

ipcMain.handle("card:history", async (_event, cardId, rarity) => {
  return cardHistory(cardId, rarity);
});

app.whenReady().then(() => {
  if (process.argv.includes("--companion")) startCompanionServer();
  else makeWindow();
  app.on("activate", () => {
    if (!process.argv.includes("--companion") && BrowserWindow.getAllWindows().length === 0) makeWindow();
  });
});

app.on("window-all-closed", () => {
  if (!process.argv.includes("--companion") && process.platform !== "darwin") app.quit();
});
