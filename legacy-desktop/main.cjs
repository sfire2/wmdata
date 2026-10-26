const { app, BrowserWindow, ipcMain, session, shell } = require("electron");
const path = require("node:path");

const SITE = "https://www.wiki-masters.com";
const SUPABASE = "https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1";
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
  mainWindow.loadFile("index.html");
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(SITE)) shell.openExternal(url);
    return { action: "deny" };
  });
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

ipcMain.handle("auth:status", async () => {
  const { accessToken, cookies } = await authContext();
  return { connected: Boolean(accessToken && cookies.length) };
});

ipcMain.handle("auth:open-login", async () => {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 1000,
    height: 760,
    title: "Connexion WikiMasters",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: wmSession,
    },
  });
  loginWindow.on("closed", () => { loginWindow = null; });
  loginWindow.loadURL(`${SITE}/login`);
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
  if (!validCardId(cardId) || !["C", "R", "SR", "UR", "PC", "L"].includes(rarity)) {
    throw new Error("Carte ou rareté invalide.");
  }
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
});

app.whenReady().then(() => {
  makeWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) makeWindow(); });
});

app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
