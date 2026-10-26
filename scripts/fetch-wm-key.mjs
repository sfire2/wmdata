import { writeFile } from "node:fs/promises";

const site = "https://www.wiki-masters.com";
const keyPattern = /eyJ[\w-]{10,}\.eyJ[\w-]{20,}\.[\w-]{10,}/;

const home = await fetch(site);
if (!home.ok) throw new Error(`WikiMasters a répondu HTTP ${home.status}.`);
const html = await home.text();
const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']*\/_next\/static\/[^"']+\.js)["']/g)]
  .map((match) => new URL(match[1], site).href);

let anonKey;
for (let offset = 0; offset < scripts.length && !anonKey; offset += 8) {
  const sources = await Promise.all(scripts.slice(offset, offset + 8).map(async (url) => {
    try {
      const response = await fetch(url);
      return response.ok ? response.text() : "";
    } catch {
      return "";
    }
  }));
  for (const source of sources) {
    anonKey = source.match(keyPattern)?.[0];
    if (anonKey) break;
  }
}

if (!anonKey) throw new Error("Impossible de trouver la clé publique du catalogue WikiMasters.");
await writeFile("wm-config.js", `window.WM_CONFIG = Object.freeze({ anonKey: ${JSON.stringify(anonKey)} });\n`, "utf8");
console.log("Configuration publique WikiMasters générée.");
