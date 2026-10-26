(() => {
  const PREFIX = "wm-cotes-v1:";
  const TTL = 12 * 60 * 60 * 1000;
  const rarities = new Set(["C", "R", "SR", "UR", "PC", "L"]);
  const rarityColors = { C: "#94a3b8", R: "#60a5fa", SR: "#c084fc", UR: "#fbbf24", PC: "#fb7185", L: "#facc15" };
  const pendingIds = new Set();
  const searchCache = new Map();
  const tasks = [];
  let activeTasks = 0;
  let anonKeyPromise;
  let scanTimer;
  let searchTimer;
  let panel;
  let launcher;

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
    const normalized = query.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
    if (searchCache.has(normalized)) return searchCache.get(normalized);

    // A complete shorter result set can be narrowed locally as the user types.
    const reusable = [...searchCache.entries()]
      .filter(([cachedQuery]) => normalized.startsWith(cachedQuery))
      .filter(([, cards]) => cards.length < 12)
      .sort(([a], [b]) => b.length - a.length)[0];
    if (reusable) {
      const cards = reusable[1].filter((card) => card.wikipedia_title.toLocaleLowerCase("fr-FR").includes(normalized));
      searchCache.set(normalized, cards);
      return cards;
    }

    const key = await getAnonKey();
    if (!key) return [];
    const cards = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "search-cards", query: normalized, key }, (result) => resolve(result || []));
    });
    searchCache.set(normalized, cards);
    if (searchCache.size > 40) searchCache.delete(searchCache.keys().next().value);
    return cards;
  }

  function hasReusableSearch(query) {
    const normalized = query.trim().replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
    return searchCache.has(normalized) || [...searchCache].some(([cachedQuery, cards]) =>
      cards.length < 12 && normalized.startsWith(cachedQuery) && normalized.length > cachedQuery.length,
    );
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

  function formatAppPrice(value) {
    return `${Math.round(value).toLocaleString("fr-FR")} WB`;
  }

  function appMetric(label, value) {
    const tile = document.createElement("div");
    tile.className = "wm-cotes-app-metric";
    const caption = document.createElement("span");
    caption.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    tile.append(caption, amount);
    return tile;
  }

  function renderAppChart(sales, chart) {
    if (!sales.length) {
      chart.textContent = "Aucune enchère vendue trouvée sur les 90 derniers jours pour cette rareté.";
      chart.className = "wm-cotes-app-chart-message";
      return;
    }
    const weeks = new Map();
    for (const sale of sales) {
      const monday = new Date(sale.end_at);
      monday.setHours(0, 0, 0, 0);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      const time = monday.getTime();
      const bucket = weeks.get(time) || { total: 0, count: 0 };
      bucket.total += Number(sale.current_bid);
      bucket.count += 1;
      weeks.set(time, bucket);
    }
    const points = [...weeks].map(([time, item]) => ({ time, value: item.total / item.count, count: item.count }));
    const min = Math.min(...points.map((point) => point.value));
    const max = Math.max(...points.map((point) => point.value));
    const spread = max - min || Math.max(1, max * 0.16);
    const width = 760, height = 290, margin = { left: 60, right: 20, top: 35, bottom: 38 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const start = points[0].time, end = Math.max(Date.now(), points.at(-1).time + 1);
    const x = (time) => points.length === 1 ? margin.left + plotWidth / 2 : margin.left + (time - start) / (end - start) * plotWidth;
    const y = (value) => margin.top + plotHeight - (value - min + spread * 0.12) / (spread * 1.24) * plotHeight;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `Évolution hebdomadaire du prix moyen, ${sales.length} ventes`);
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    defs.innerHTML = '<linearGradient id="wmCotesAppArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#73e2c0" stop-opacity=".2"/><stop offset="100%" stop-color="#73e2c0" stop-opacity="0"/></linearGradient>';
    svg.append(defs);
    const add = (tag, attrs, parent = svg) => {
      const element = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      parent.append(element);
      return element;
    };
    [0, 0.5, 1].forEach((fraction) => {
      const yy = margin.top + fraction * plotHeight;
      add("line", { x1: margin.left, x2: width - margin.right, y1: yy, y2: yy, class: "wm-cotes-app-grid" });
      const label = add("text", { x: margin.left - 10, y: yy + 4, class: "wm-cotes-app-axis", "text-anchor": "end" });
      label.textContent = Math.round(max - fraction * (max - min)).toLocaleString("fr-FR");
    });
    const path = points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    add("path", { d: `${path} L${x(points.at(-1).time)},${height - margin.bottom} L${x(points[0].time)},${height - margin.bottom} Z`, class: "wm-cotes-app-area" });
    add("path", { d: path, class: "wm-cotes-app-line" });
    for (const point of points) {
      const dot = add("circle", { cx: x(point.time), cy: y(point.value), r: 4, class: "wm-cotes-app-dot" });
      const title = add("title", {}, dot);
      title.textContent = `${new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(point.time))} : ${formatAppPrice(point.value)} · ${point.count} vente${point.count > 1 ? "s" : ""}`;
      const value = add("text", { x: x(point.time), y: y(point.value) - 11, class: "wm-cotes-app-value-label", "text-anchor": "middle" });
      value.textContent = Math.round(point.value).toLocaleString("fr-FR");
    }
    [points[0].time, (points[0].time + points.at(-1).time) / 2, points.at(-1).time].forEach((time, index) => {
      const label = add("text", { x: index === 0 ? margin.left : index === 2 ? width - margin.right : margin.left + plotWidth / 2, y: height - 8, class: "wm-cotes-app-axis", "text-anchor": index === 0 ? "start" : index === 2 ? "end" : "middle" });
      label.textContent = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(new Date(time));
    });
    chart.replaceChildren(svg);
    chart.className = "wm-cotes-app-chart-container";
  }

  async function loadAppCard(card, rarity, summary, chart, token) {
    summary.replaceChildren();
    chart.textContent = "Chargement de l’historique des enchères…";
    chart.className = "wm-cotes-app-chart-message";
    try {
      const rows = await readAuctionHistory(card.id, rarity);
      if (token.cancelled) return;
      if (!rows) throw new Error("Session WikiMasters indisponible. Connecte-toi au site puis réessaie.");
      const sales = rows
        .filter((sale) => Number.isFinite(Number(sale.current_bid)) && Number(sale.current_bid) > 0 && Number.isFinite(new Date(sale.end_at).getTime()))
        .sort((a, b) => new Date(a.end_at) - new Date(b.end_at));
      if (sales.length) {
        const prices = sales.map((sale) => Number(sale.current_bid));
        summary.append(
          appMetric("Moyenne sur 90 jours", formatAppPrice(prices.reduce((sum, value) => sum + value, 0) / prices.length)),
          appMetric("Ventes", String(sales.length)),
          appMetric("Fourchette", `${formatAppPrice(Math.min(...prices))} – ${formatAppPrice(Math.max(...prices))}`),
          appMetric("Dernière vente", formatAppPrice(prices.at(-1))),
        );
      } else {
        summary.append(appMetric("Ventes sur 90 jours", "Aucune vente"));
      }
      renderAppChart(sales, chart);
    } catch (error) {
      if (token.cancelled) return;
      chart.textContent = error.message || "Impossible de charger l’historique.";
      chart.className = "wm-cotes-app-chart-message is-error";
    }
  }

  function ensureAppPanel() {
    if (panel) return panel;
    panel = document.createElement("div");
    panel.className = "wm-cotes-app-overlay";
    panel.hidden = true;
    panel.innerHTML = `
      <button class="wm-cotes-app-backdrop" type="button" aria-label="Fermer le panneau"></button>
      <section class="wm-cotes-app" role="dialog" aria-modal="true" aria-label="WikiMasters Cotes">
        <header class="wm-cotes-app-topbar">
          <a class="wm-cotes-app-brand" href="#" aria-label="WikiMasters Cotes, accueil"><span class="wm-cotes-app-brand-mark">W</span><span><strong>WikiMasters</strong><small>Observatoire des cotes</small></span></a>
          <span class="wm-cotes-app-connection"><i></i> Session WikiMasters</span>
          <button class="wm-cotes-app-close" type="button" aria-label="Fermer">×</button>
        </header>
        <div class="wm-cotes-app-scroll">
          <section class="wm-cotes-app-hero">
            <div class="wm-cotes-app-eyebrow"><i></i> OBSERVATOIRE DES CARTES</div>
            <h1>La cote de vos cartes,<br><em>en clair.</em></h1>
            <p>Recherchez une carte et explorez l’évolution hebdomadaire de ses enchères conclues.</p>
            <label class="wm-cotes-app-searchbox"><span aria-hidden="true">⌕</span><input type="search" placeholder="Nom de la carte…" autocomplete="off" spellcheck="false" aria-label="Rechercher une carte"></label>
            <div class="wm-cotes-app-search-help">Saisis au moins 2 caractères</div>
            <div class="wm-cotes-app-results" role="listbox" aria-label="Résultats de recherche"></div>
          </section>
          <section class="wm-cotes-app-workspace" hidden>
            <div class="wm-cotes-app-selected">
              <span class="wm-cotes-app-card-icon">✳</span>
              <div class="wm-cotes-app-card-copy"><small>CARTE SÉLECTIONNÉE</small><h2></h2></div>
              <span class="wm-cotes-app-selected-rarity"></span>
              <label class="wm-cotes-app-rarity-control"><small>RARETÉ</small><select aria-label="Choisir la rareté"></select></label>
            </div>
            <div class="wm-cotes-app-summary"></div>
            <section class="wm-cotes-app-chart-card">
              <div class="wm-cotes-app-chart-heading"><div><small>HISTORIQUE DU MARCHÉ</small><h2>Évolution des prix</h2></div><span class="wm-cotes-app-period"><i></i>90 derniers jours</span></div>
              <div class="wm-cotes-app-chart-message">Choisis une rareté pour charger l’historique.</div>
            </section>
          </section>
          <footer class="wm-cotes-app-footer"><span>WIKIMASTERS · COTES</span><span>Application communautaire non officielle</span></footer>
        </div>
      </section>`;
    document.body.append(panel);

    const $panel = (selector) => panel.querySelector(selector);
    const search = $panel('input[type="search"]');
    const searchHelp = $panel(".wm-cotes-app-search-help");
    const results = $panel(".wm-cotes-app-results");
    const workspace = $panel(".wm-cotes-app-workspace");
    const summary = $panel(".wm-cotes-app-summary");
    const chart = $panel(".wm-cotes-app-chart-message");
    const raritySelect = $panel(".wm-cotes-app-rarity-control select");
    let searchSequence = 0;
    let dataToken = { cancelled: true };
    let selectedCard = null;

    const closePanel = () => {
      panel.hidden = true;
      launcher?.setAttribute("aria-expanded", "false");
    };
    $panel(".wm-cotes-app-close").addEventListener("click", closePanel);
    $panel(".wm-cotes-app-backdrop").addEventListener("click", closePanel);
    $panel(".wm-cotes-app-brand").addEventListener("click", (event) => {
      event.preventDefault();
      search.value = "";
      results.replaceChildren();
      workspace.hidden = true;
      search.focus();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePanel();
    });

    const chooseCard = (card) => {
      dataToken.cancelled = true;
      dataToken = { cancelled: false };
      selectedCard = card;
      const rarity = rarities.has(card.rarity) ? card.rarity : "C";
      workspace.style.setProperty("--rarity", rarityColors[rarity]);
      $panel(".wm-cotes-app-card-copy h2").textContent = card.wikipedia_title;
      $panel(".wm-cotes-app-selected-rarity").textContent = rarity;
      raritySelect.replaceChildren();
      ["C", "R", "SR", "UR", "PC", "L"].forEach((code) => {
        const option = document.createElement("option");
        option.value = code;
        option.textContent = code;
        raritySelect.append(option);
      });
      raritySelect.value = rarity;
      workspace.hidden = false;
      loadAppCard(selectedCard, raritySelect.value, summary, chart, dataToken);
      workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    raritySelect.addEventListener("change", () => {
      if (!selectedCard) return;
      dataToken.cancelled = true;
      dataToken = { cancelled: false };
      workspace.style.setProperty("--rarity", rarityColors[raritySelect.value]);
      $panel(".wm-cotes-app-selected-rarity").textContent = raritySelect.value;
      loadAppCard(selectedCard, raritySelect.value, summary, chart, dataToken);
    });

    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const sequence = ++searchSequence;
      const query = search.value.trim();
      const normalizedQuery = query.replace(/\s+/g, " ").toLocaleLowerCase("fr-FR");
      results.replaceChildren();
      workspace.hidden = true;
      selectedCard = null;
      dataToken.cancelled = true;
      if (query.length < 2) {
        searchHelp.textContent = "Saisis au moins 2 caractères";
        return;
      }
      searchHelp.textContent = "Recherche en cours…";
      searchTimer = setTimeout(async () => {
        try {
          const cards = await searchCards(normalizedQuery);
          if (sequence !== searchSequence || search.value.trim() !== query) return;
          results.replaceChildren();
          if (!cards.length) {
            results.textContent = "Aucune carte trouvée.";
            results.classList.add("is-empty");
          } else {
            results.classList.remove("is-empty");
            cards
              .sort((a, b) => {
                const rank = (card) => {
                  const title = card.wikipedia_title.toLocaleLowerCase("fr-FR");
                  if (title === normalizedQuery) return 0;
                  if (title.startsWith(normalizedQuery)) return 1;
                  if (title.includes(` ${normalizedQuery}`)) return 2;
                  return 3;
                };
                return rank(a) - rank(b) || a.wikipedia_title.localeCompare(b.wikipedia_title, "fr");
              })
              .forEach((card) => {
                const rarity = rarities.has(card.rarity) ? card.rarity : "C";
                const button = document.createElement("button");
                button.type = "button";
                button.className = "wm-cotes-app-result";
                button.style.setProperty("--rarity", rarityColors[rarity]);
                button.setAttribute("role", "option");
                const symbol = document.createElement("span");
                symbol.className = "wm-cotes-app-result-symbol";
                symbol.textContent = "✳";
                const title = document.createElement("span");
                title.className = "wm-cotes-app-result-title";
                title.textContent = card.wikipedia_title;
                const badge = document.createElement("span");
                badge.className = "wm-cotes-app-result-rarity";
                badge.textContent = rarity;
                button.append(symbol, title, badge);
                button.addEventListener("click", () => chooseCard({ ...card, rarity }));
                results.append(button);
              });
          }
          searchHelp.textContent = `${cards.length} résultat${cards.length > 1 ? "s" : ""}`;
        } catch (error) {
          if (sequence === searchSequence) searchHelp.textContent = error.message || "La recherche a échoué.";
        }
      }, hasReusableSearch(normalizedQuery) ? 0 : 220);
    });
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
        const searchPanel = ensureAppPanel();
        searchPanel.hidden = !searchPanel.hidden;
        status.setAttribute("aria-expanded", String(!searchPanel.hidden));
        if (!searchPanel.hidden) searchPanel.querySelector("input")?.focus();
      });
      document.body.append(status);
    }
    launcher = status;
    status.title = `${detected} carte(s) détectée(s) sur cette page`;
    status.dataset.count = String(detected);
  }

  scan();
  new MutationObserver(() => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 350);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
