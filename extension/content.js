(() => {
  const PREFIX = "wm-cotes-v1:";
  const TTL = 12 * 60 * 60 * 1000;
  const rarities = new Set(["C", "R", "SR", "UR", "PC", "L"]);
  const pendingIds = new Set();
  const searchCache = new Map();
  const tasks = [];
  let activeTasks = 0;
  let anonKeyPromise;
  let scanTimer;
  let searchTimer;
  let panel;

  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("wm-cotes-history-v1:")) localStorage.removeItem(key);
  }

  function enqueue(task) {
    return new Promise((resolve, reject) => {
      tasks.push({ task, resolve, reject });
      runTasks();
    });
  }

  function runTasks() {
    while (activeTasks < 2 && tasks.length) {
      const { task, resolve, reject } = tasks.shift();
      activeTasks += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        activeTasks -= 1;
        runTasks();
      });
    }
  }

  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();

  function cardFromHeading(heading) {
    const title = text(heading);
    if (!title || title.length > 120) return null;

    let node = heading;
    for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
      const labels = [...node.querySelectorAll("div, span, p")].slice(0, 100);
      const rarityLabel = labels.find((item) => item.children.length === 0 && rarities.has(text(item)));
      const rarity = rarityLabel ? text(rarityLabel) : null;
      if (!rarity) continue;

      const idNode = [node, ...node.querySelectorAll("[data-card-id], [data-id], a[href]")]
        .find((item) => {
          const candidate = item.dataset?.cardId || item.dataset?.id || item.getAttribute?.("href") || "";
          return /^[\w-]{12,}$/.test(candidate) || /\/cards?\/([\w-]{12,})/.test(candidate);
        });
      const rawId = idNode?.dataset?.cardId || idNode?.dataset?.id || idNode?.getAttribute?.("href") || "";
      const id = rawId.match(/([\w-]{12,})/)?.[1] || "";
      return { node, title, rarity, id };
    }
    return null;
  }

  function getAnonKey() {
    if (anonKeyPromise) return anonKeyPromise;
    anonKeyPromise = (async () => {
      for (const script of document.querySelectorAll('script[src*="/_next/static/"]')) {
        try {
          const source = await (await fetch(script.src, { credentials: "same-origin" })).text();
          const key = source.match(/eyJ[\w-]{10,}\.eyJ[\w-]{20,}\.[\w-]{10,}/)?.[0];
          if (key) return key;
        } catch { /* Le bundle peut être inaccessible ; les ID présents dans le DOM restent utilisables. */ }
      }
      return null;
    })();
    return anonKeyPromise;
  }

  function getSessionAccessToken() {
    const cookies = document.cookie.split(";").map((part) => part.trim());
    const baseName = cookies.find((part) => /^sb-[\w-]+-auth-token(?:=|\.0=)/.test(part))?.split("=")[0].replace(/\.0$/, "");
    if (!baseName) return null;
    const value = cookies
      .filter((part) => part.startsWith(`${baseName}=`) || new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.\\d+=`).test(part))
      .sort((a, b) => Number(a.match(/\.(\d+)=/)?.[1] || 0) - Number(b.match(/\.(\d+)=/)?.[1] || 0))
      .map((part) => part.slice(part.indexOf("=") + 1))
      .join("");
    try {
      const decoded = decodeURIComponent(value);
      const json = decoded.startsWith("base64-")
        ? atob(decoded.slice(7).replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(decoded.slice(7).length / 4) * 4, "="))
        : decoded;
      return JSON.parse(json)?.access_token || null;
    } catch { return null; }
  }

  async function resolveCard(title) {
    const key = await getAnonKey();
    if (!key) return null;
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "resolve-card", title, key }, (result) => resolve(result || null));
    });
  }

  async function searchCards(query) {
    const normalized = query.trim().toLocaleLowerCase("fr-FR");
    if (searchCache.has(normalized)) return searchCache.get(normalized);
    const key = await getAnonKey();
    if (!key) return [];
    const cards = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "search-cards", query: normalized, key }, (result) => resolve(result || []));
    });
    searchCache.set(normalized, cards);
    if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value);
    return cards;
  }

  function calculate(sales, rarity) {
    const matched = sales
      .filter((sale) => typeof sale.final_price === "number" && sale.rarity === rarity)
      .sort((a, b) => new Date(a.settled_at) - new Date(b.settled_at));
    if (!matched.length) return null;
    const values = matched.map((sale) => sale.final_price);
    return {
      last: values.at(-1),
      average: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
      min: Math.min(...values),
      max: Math.max(...values),
      count: matched.length,
      date: matched.at(-1).settled_at,
      recent: matched.slice(-10).reverse().map((sale) => ({ price: sale.final_price, date: sale.settled_at })),
    };
  }

  async function readAllPrices(id) {
    const cacheKey = PREFIX + id;
    try {
      const saved = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (saved && Date.now() - saved.time < TTL) {
        return saved.stats;
      }
    } catch { /* Cache local illisible : on recharge les données. */ }

    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetch(`/api/marketplace/cards/${encodeURIComponent(id)}/sales?scope=summary`, {
        credentials: "same-origin",
      });
      if (response.status !== 429 && response.status !== 503) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (attempt + 1)));
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.summary && typeof payload.summary === "object") {
      const summaryStats = Object.fromEntries(Object.entries(payload.summary)
        .filter(([, item]) => typeof item?.average === "number")
        .map(([rarity, item]) => [rarity, {
          average: Math.round(item.average),
          count: Number.isFinite(item.count) ? item.count : null,
          min: Number.isFinite(item.min) ? item.min : null,
          max: Number.isFinite(item.max) ? item.max : null,
          last: Number.isFinite(item.last) ? item.last : null,
          recent: [],
        }]));
      localStorage.setItem(cacheKey, JSON.stringify({ time: Date.now(), stats: summaryStats }));
      return summaryStats;
    }
    const { sales = [] } = payload;
    const stats = {};
    for (const sale of sales) {
      if (sale?.rarity && typeof sale.final_price === "number") (stats[sale.rarity] ||= []).push(sale);
    }
    const result = Object.fromEntries(Object.entries(stats).map(([key, values]) => [key, calculate(values, key)]));
    localStorage.setItem(cacheKey, JSON.stringify({ time: Date.now(), stats: result }));
    return result;
  }

  async function readPrices(id, rarity) {
    const stats = await readAllPrices(id);
    return stats[rarity] || null;
  }

  async function readAuctionHistory(id, rarity) {
    const key = await getAnonKey();
    if (!key) return null;
    const accessToken = getSessionAccessToken();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "auction-history", cardId: id, rarity, key, accessToken }, (rows) => resolve(rows ?? null));
    });
  }

  function buildAverageChart(sales) {
    const valid = (Array.isArray(sales) ? sales : [])
      .filter((sale) => Number.isFinite(sale.current_bid) && sale.current_bid > 0 && Number.isFinite(new Date(sale.end_at).getTime()))
      .sort((a, b) => new Date(a.end_at) - new Date(b.end_at));
    if (!valid.length) return null;

    const weekly = new Map();
    valid.forEach((sale) => {
      const date = new Date(sale.end_at);
      const monday = new Date(date);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const key = monday.getTime();
      const bucket = weekly.get(key) || { sum: 0, count: 0 };
      bucket.sum += sale.current_bid;
      bucket.count += 1;
      weekly.set(key, bucket);
    });

    const points = [...weekly.entries()].map(([time, bucket]) => ({
      time,
      average: bucket.sum / bucket.count,
      count: bucket.count,
    }));
    const min = Math.min(...points.map((point) => point.average));
    const max = Math.max(...points.map((point) => point.average));
    const span = max - min || Math.max(max * 0.2, 1);
    const start = points[0].time;
    const end = Math.max(Date.now(), points.at(-1).time + 1);
    const width = 340;
    const height = 154;
    const left = 38;
    const right = 326;
    const top = 14;
    const bottom = 119;
    const x = (time) => points.length === 1 ? (left + right) / 2 : left + ((time - start) / (end - start)) * (right - left);
    const y = (value) => bottom - ((value - min + span * 0.12) / (span * 1.24)) * (bottom - top);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Évolution de la moyenne hebdomadaire des enchères vendues sur les 90 derniers jours");
    svg.classList.add("wm-cotes-chart");

    const line = (tag, attrs) => {
      const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
      Object.entries(attrs).forEach(([key, value]) => element.setAttribute(key, String(value)));
      svg.append(element);
      return element;
    };
    [0, 0.5, 1].forEach((fraction) => {
      const yy = top + fraction * (bottom - top);
      line("line", { x1: left, y1: yy, x2: right, y2: yy, class: "wm-cotes-chart-grid" });
      const label = line("text", { x: left - 5, y: yy + 3, "text-anchor": "end", class: "wm-cotes-chart-label" });
      label.textContent = `${Math.round(max - fraction * (max - min))}`;
    });
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.average).toFixed(1)}`).join(" ");
    line("path", { d: path, fill: "none", class: "wm-cotes-chart-line" });
    points.forEach((point) => {
      const dot = line("circle", { cx: x(point.time), cy: y(point.average), r: 3.5, class: "wm-cotes-chart-dot" });
      const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
      title.textContent = `${new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(point.time))} : ${Math.round(point.average)} WB (${point.count} vente${point.count > 1 ? "s" : ""})`;
      dot.append(title);
      const value = line("text", {
        x: x(point.time),
        y: y(point.average) - 8,
        "text-anchor": "middle",
        class: "wm-cotes-chart-value",
      });
      value.textContent = `${Math.round(point.average)} WB`;
    });
    [points[0].time, (points[0].time + points.at(-1).time) / 2, points.at(-1).time].forEach((time, index) => {
      const label = line("text", { x: index === 0 ? left : index === 2 ? right : (left + right) / 2, y: 140, "text-anchor": index === 0 ? "start" : index === 2 ? "end" : "middle", class: "wm-cotes-chart-label" });
      label.textContent = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit" }).format(new Date(time));
    });

    const section = document.createElement("div");
    section.className = "wm-cotes-chart-section";
    const title = document.createElement("strong");
    title.textContent = "Moyenne des ventes par semaine";
    const note = document.createElement("p");
    note.className = "wm-cotes-muted";
    const days = Math.max(1, Math.ceil((Date.now() - new Date(valid[0].end_at).getTime()) / (24 * 60 * 60 * 1000)));
    note.textContent = `${valid.length} enchère${valid.length > 1 ? "s" : ""} vendue${valid.length > 1 ? "s" : ""} · ${Math.min(days, 90)} jour${Math.min(days, 90) > 1 ? "s" : ""} de données disponibles`;
    section.append(title, svg, note);
    return section;
  }

  function openSelectedCard(card, output, raritySelect) {
    raritySelect.value = "";
    const historyByRarity = new Map();
    output.replaceChildren();
    const loading = document.createElement("p");
    loading.className = "wm-cotes-muted";
    loading.textContent = "Chargement de la cote…";
    output.append(loading);

    readAllPrices(card.id).then((stats) => {
      const render = () => {
        output.replaceChildren();
        const rarity = raritySelect.value.trim().toUpperCase();
        if (!rarity) {
          const prompt = document.createElement("p");
          prompt.className = "wm-cotes-muted";
          prompt.textContent = "Saisissez le code de rareté : C, R, SR, UR, PC ou L.";
          output.append(prompt);
          return;
        }
        if (!["C", "R", "SR", "UR", "PC", "L"].includes(rarity)) {
          const invalid = document.createElement("p");
          invalid.className = "wm-cotes-muted";
          invalid.textContent = "Code inconnu. Utilisez C, R, SR, UR, PC ou L.";
          output.append(invalid);
          return;
        }
        const stat = stats[rarity];
        if (!stat) {
          const empty = document.createElement("p");
          empty.className = "wm-cotes-muted";
          empty.textContent = `Aucune cote disponible pour cette carte en rareté ${rarity}.`;
          output.append(empty);
        } else {
        const metrics = document.createElement("div");
        metrics.className = "wm-cotes-metrics";
        const shownMetrics = [["Prix moyen", `${stat.average} WB`]];
        if (Number.isFinite(stat.last)) shownMetrics.unshift(["Dernière vente", `${stat.last} WB`]);
        if (Number.isFinite(stat.min) && Number.isFinite(stat.max)) shownMetrics.push(["Fourchette", `${stat.min}–${stat.max} WB`]);
        if (Number.isFinite(stat.count)) shownMetrics.push(["Ventes", String(stat.count)]);
        shownMetrics.forEach(([label, value]) => {
          const metric = document.createElement("div");
          metric.className = "wm-cotes-metric";
          const caption = document.createElement("span");
          caption.textContent = label;
          const amount = document.createElement("strong");
          amount.textContent = value;
          metric.append(caption, amount);
          metrics.append(metric);
        });
        output.append(metrics);
        }
        if (!historyByRarity.has(rarity)) {
          const historyLoading = document.createElement("p");
          historyLoading.className = "wm-cotes-muted";
          historyLoading.textContent = "Chargement de l’historique des enchères…";
          output.append(historyLoading);
          const request = readAuctionHistory(card.id, rarity).catch(() => null);
          historyByRarity.set(rarity, request);
          request.then((history) => {
            historyByRarity.set(rarity, history);
            if (raritySelect.value.trim().toUpperCase() === rarity) render();
          });
          return;
        }
        const history = historyByRarity.get(rarity);
        if (history instanceof Promise) {
          const historyLoading = document.createElement("p");
          historyLoading.className = "wm-cotes-muted";
          historyLoading.textContent = "Chargement de l’historique des enchères…";
          output.append(historyLoading);
          return;
        }
        const chart = buildAverageChart(history);
        if (chart) output.append(chart);
        else {
          const historyNote = document.createElement("p");
          historyNote.className = "wm-cotes-muted";
          historyNote.textContent = history === null
            ? "L’historique des enchères n’est pas accessible pour cette carte. La moyenne actuelle reste disponible."
            : "Aucune enchère vendue trouvée sur les 90 derniers jours pour cette rareté.";
          output.append(historyNote);
        }

        if (stat.recent?.length) {
          const historyTitle = document.createElement("h3");
          historyTitle.className = "wm-cotes-history-title";
          historyTitle.textContent = "Dernières enchères conclues";
          output.append(historyTitle);
          const history = document.createElement("ul");
          history.className = "wm-cotes-history";
          stat.recent.forEach((sale) => {
            const item = document.createElement("li");
            const amount = document.createElement("strong");
            amount.textContent = `${sale.price} WB`;
            const date = document.createElement("time");
            date.dateTime = sale.date;
            date.textContent = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(sale.date));
            item.append(amount, date);
            history.append(item);
          });
          output.append(history);
        }
      };
      raritySelect.onchange = render;
      render();
    }).catch((cause) => {
      output.replaceChildren();
      const error = document.createElement("p");
      error.className = "wm-cotes-muted";
      error.textContent = `Impossible de charger la cote (${cause.message}). Vérifiez votre connexion à WikiMasters.`;
      output.append(error);
    });
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("section");
    panel.className = "wm-cotes-panel";
    panel.hidden = true;
    const header = document.createElement("header");
    const heading = document.createElement("strong");
    heading.textContent = "Cotes des cartes";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wm-cotes-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Fermer");
    close.addEventListener("click", () => { panel.hidden = true; });
    header.append(heading, close);

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Rechercher une carte…";
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Rechercher une carte WikiMasters");
    const results = document.createElement("div");
    results.className = "wm-cotes-results";
    const rarityLabel = document.createElement("label");
    rarityLabel.className = "wm-cotes-rarity-label";
    rarityLabel.textContent = "Raret\u00e9";
    const raritySelect = document.createElement("select");
    raritySelect.setAttribute("aria-label", "Raret\u00e9 de la carte");
    raritySelect.hidden = true;
    const rarityPlaceholder = document.createElement("option");
    rarityPlaceholder.value = "";
    rarityPlaceholder.textContent = "Choisir une raret?";
    raritySelect.append(rarityPlaceholder);
    ["C", "R", "SR", "UR", "PC", "L"].forEach((rarity) => {
      const option = document.createElement("option");
      option.value = rarity;
      option.textContent = rarity;
      raritySelect.append(option);
    });
    rarityLabel.hidden = true;
    rarityLabel.append(raritySelect);
    const output = document.createElement("div");
    output.className = "wm-cotes-detail";

    let searchSequence = 0;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const sequence = ++searchSequence;
      const query = search.value.trim().toLocaleLowerCase("fr-FR");
      rarityLabel.hidden = true;
      output.replaceChildren();
      if (query.length < 2) {
        results.textContent = "Saisissez au moins 2 caractères.";
        results.classList.add("wm-cotes-muted");
        return;
      }
      results.textContent = "Recherche…";
      results.classList.add("wm-cotes-muted");
      searchTimer = setTimeout(async () => {
        const cards = await searchCards(query);
        if (sequence !== searchSequence || search.value.trim().toLocaleLowerCase("fr-FR") !== query) return;
        results.replaceChildren();
        results.classList.toggle("wm-cotes-muted", cards.length === 0);
        if (!cards.length) {
          results.textContent = "Aucune carte trouvée.";
          return;
        }
        cards.forEach((card) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "wm-cotes-result";
          button.textContent = `${card.wikipedia_title} · ${card.rarity}`;
          button.addEventListener("click", () => {
            [...results.querySelectorAll(".wm-cotes-result")].forEach((item) => item.classList.remove("is-selected"));
            button.classList.add("is-selected");
            rarityLabel.hidden = false;
            raritySelect.hidden = false;
            openSelectedCard(card, output, raritySelect);
          });
          results.append(button);
        });
      }, 100);
    });

    panel.append(header, search, results, rarityLabel, output);
    document.body.append(panel);
    return panel;
  }

  function show(card, stats, unavailable = false) {
    const badge = document.createElement("div");
    badge.className = "wm-cotes-badge";
    badge.textContent = stats ? `◈ ${stats.last}  ·  moy. ${stats.average}` : unavailable ? "◈ Cote indisponible" : "◈ Aucune vente";
    badge.title = unavailable
      ? "Impossible de charger la cote. Vérifiez que vous êtes connecté à WikiMasters, puis rechargez la page."
      : stats
      ? `Dernière vente : ${stats.last} WikiCoins\nMoyenne : ${stats.average}\nFourchette : ${stats.min}–${stats.max}\n${stats.count} vente${stats.count > 1 ? "s" : ""} · rareté ${card.rarity}\nCliquez pour ouvrir les ventes WikiMasters.`
      : `Aucune vente enregistrée pour la rareté ${card.rarity}.`;
    if (stats) badge.addEventListener("click", () => window.open(`/marketplace?card=${encodeURIComponent(card.id)}`, "_blank", "noopener"));
    card.node.append(badge);
  }

  async function enhance(card) {
    if (!card || pendingIds.has(card.title)) return;
    pendingIds.add(card.title);
    try {
      await enqueue(async () => {
        const resolved = card.id ? { id: card.id } : await resolveCard(card.title);
        if (!resolved?.id) return;
        card.id = resolved.id;
        const stats = await readPrices(card.id, card.rarity);
        if (card.node.isConnected) show(card, stats);
      });
    } catch (error) {
      if (card.node.isConnected) show(card, null, true);
      console.info("WikiMasters Cotes : prix indisponibles", error);
    } finally {
      pendingIds.delete(card.title);
    }
  }

  function scan() {
    const headings = document.querySelectorAll("h2, h3, h4");
    let detected = 0;
    [...headings].forEach((heading) => {
      const card = cardFromHeading(heading);
      if (card) {
        detected += 1;
        if (!card.node.querySelector(":scope > .wm-cotes-badge")) enhance(card);
      }
    });
    let status = document.querySelector(".wm-cotes-status");
    if (!status) {
      status = document.createElement("button");
      status.type = "button";
      status.className = "wm-cotes-status";
      status.textContent = "Cotes";
      status.setAttribute("aria-label", "Rechercher les cotes d’une carte WikiMasters");
      status.setAttribute("aria-expanded", "false");
      status.addEventListener("click", () => {
        const searchPanel = ensurePanel();
        searchPanel.hidden = !searchPanel.hidden;
        status.setAttribute("aria-expanded", String(!searchPanel.hidden));
        if (!searchPanel.hidden) searchPanel.querySelector("input")?.focus();
      });
      document.body.append(status);
    }
    status.title = `${detected} carte(s) détectée(s) sur cette page`;
    status.dataset.count = String(detected);
  }

  scan();
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
