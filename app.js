(() => {
  const API = "https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1";
  const RARITIES = ["C", "R", "SR", "UR", "PC", "L"];
  const RARITY_COLORS = {
    C: "#94a3b8",
    R: "#60a5fa",
    SR: "#c084fc",
    UR: "#fbbf24",
    PC: "#fb7185",
    L: "#facc15",
  };
  const $ = (selector) => document.querySelector(selector);
  const search = $("#cardSearch");
  const results = $("#searchResults");
  const searchHelp = $("#searchHelp");
  const workspace = $("#workspace");
  const raritySelect = $("#raritySelect");
  const summary = $("#summary");
  const chartMessage = $("#chartMessage");
  const chartContainer = $("#chartContainer");
  const cache = new Map();
  let selectedCard = null;
  let searchTimer;
  let searchSequence = 0;
  let dataSequence = 0;
  const desktop = Boolean(window.wikiMasters);

  const price = (value) => `${Math.round(value).toLocaleString("fr-FR")} WB`;

  function message(node, text, isError = false) {
    node.textContent = text;
    node.hidden = false;
    node.classList.toggle("is-error", isError);
  }

  function request(path) {
    const key = window.WM_CONFIG?.anonKey;
    if (!key) throw new Error("Configuration du catalogue introuvable. Recharge la page plus tard.");
    return fetch(`${API}/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.message || `Catalogue indisponible (HTTP ${response.status}).`);
        error.status = response.status;
        error.code = String(payload.code || "");
        throw error;
      }
      return response.json();
    });
  }

  async function findCards(query) {
    const normalized = query.trim().toLocaleLowerCase("fr-FR");
    if (cache.has(normalized)) return cache.get(normalized);
    if (desktop) {
      const cards = await window.wikiMasters.searchCards(normalized);
      cache.set(normalized, cards);
      return cards;
    }
    const params = new URLSearchParams({
      select: "id,rarity,wikipedia_title",
      lang: "eq.fr",
      wikipedia_title: `ilike.*${normalized.replace(/[,*()]/g, " ")}*`,
      limit: "12",
      order: "wikipedia_title.asc",
    });
    const cards = await request(`cards?${params}`);
    cache.set(normalized, cards);
    if (cache.size > 40) cache.delete(cache.keys().next().value);
    return cards;
  }

  function renderResults(cards) {
    results.replaceChildren();
    results.classList.remove("is-error");
    if (!cards.length) {
      const empty = document.createElement("div");
      empty.className = "no-results";
      empty.textContent = "Aucune carte trouvée.";
      results.append(empty);
      return;
    }
    for (const card of cards) {
      const rarityCode = RARITIES.includes(card.rarity) ? card.rarity : "C";
      const button = document.createElement("button");
      button.className = "search-result";
      button.type = "button";
      button.setAttribute("role", "option");
      button.dataset.rarity = rarityCode;
      button.style.setProperty("--rarity", RARITY_COLORS[rarityCode]);

      const icon = document.createElement("span");
      icon.className = "result-symbol";
      icon.setAttribute("aria-hidden", "true");
      icon.textContent = "✳";
      const title = document.createElement("span");
      title.className = "result-title";
      title.textContent = card.wikipedia_title;
      const rarity = document.createElement("span");
      rarity.className = "result-rarity";
      rarity.textContent = rarityCode;
      button.append(icon, title, rarity);
      button.addEventListener("click", () => selectCard({ ...card, rarity: rarityCode }));
      results.append(button);
    }
  }

  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = search.value.trim();
    const sequence = ++searchSequence;
    results.replaceChildren();
    workspace.hidden = true;
    selectedCard = null;
    if (query.length < 2) {
      message(searchHelp, "Saisis au moins 2 caractères");
      return;
    }
    message(searchHelp, "Recherche en cours…");
    searchTimer = setTimeout(async () => {
      try {
        const cards = await findCards(query);
        if (sequence !== searchSequence || search.value.trim() !== query) return;
        renderResults(cards);
        message(searchHelp, `${cards.length} résultat${cards.length > 1 ? "s" : ""}`);
      } catch (error) {
        if (sequence === searchSequence) message(searchHelp, error.message || "La recherche a échoué.", true);
      }
    }, 180);
  });

  function selectCard(card) {
    selectedCard = card;
    const rarity = RARITIES.includes(card.rarity) ? card.rarity : "C";
    const accent = RARITY_COLORS[rarity];
    $("#selectedName").textContent = card.wikipedia_title;
    $("#selectedCard").style.setProperty("--rarity", accent);
    $("#selectedRarity").textContent = rarity;
    raritySelect.replaceChildren();
    for (const rarityOption of RARITIES) {
      const option = document.createElement("option");
      option.value = rarityOption;
      option.textContent = rarityOption;
      raritySelect.append(option);
    }
    raritySelect.value = rarity;
    raritySelect.style.setProperty("--rarity", accent);
    summary.replaceChildren();
    chartContainer.replaceChildren();
    chartContainer.hidden = true;
    message(chartMessage, "Chargement de l’historique…");
    workspace.hidden = false;
    loadCardData();
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  raritySelect.addEventListener("change", () => {
    const accent = RARITY_COLORS[raritySelect.value] || RARITY_COLORS.C;
    raritySelect.style.setProperty("--rarity", accent);
    $("#selectedCard").style.setProperty("--rarity", accent);
    $("#selectedRarity").textContent = raritySelect.value;
    loadCardData();
  });

  function metric(label, value) {
    const tile = document.createElement("div");
    tile.className = "metric";
    const caption = document.createElement("span");
    caption.textContent = label;
    const amount = document.createElement("strong");
    amount.textContent = value;
    tile.append(caption, amount);
    summary.append(tile);
  }

  function renderSummary(sales) {
    summary.replaceChildren();
    if (!sales.length) {
      metric("Ventes sur 90 jours", "Aucune vente");
      return;
    }
    const prices = sales.map((sale) => Number(sale.current_bid));
    metric("Moyenne sur 90 jours", price(prices.reduce((sum, value) => sum + value, 0) / prices.length));
    metric("Ventes", String(sales.length));
    metric("Fourchette", `${price(Math.min(...prices))} – ${price(Math.max(...prices))}`);
    metric("Dernière vente", price(prices.at(-1)));
  }

  function renderChart(sales) {
    if (!sales.length) {
      chartContainer.hidden = true;
      message(chartMessage, "Aucune enchère vendue trouvée sur les 90 derniers jours pour cette rareté.");
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
    const width = 760, height = 290, margin = { left: 60, right: 20, top: 40, bottom: 38 };
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
    defs.innerHTML = '<linearGradient id="areaFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="#73e2c0" stop-opacity=".2"/><stop offset="100%" stop-color="#73e2c0" stop-opacity="0"/></linearGradient>';
    svg.append(defs);
    const add = (tag, attrs, parent = svg) => {
      const element = document.createElementNS(svg.namespaceURI, tag);
      for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
      parent.append(element);
      return element;
    };
    [0, 0.5, 1].forEach((fraction) => {
      const yy = margin.top + fraction * plotHeight;
      add("line", { x1: margin.left, x2: width - margin.right, y1: yy, y2: yy, class: "grid-line" });
      const label = add("text", { x: margin.left - 10, y: yy + 4, class: "axis-label", "text-anchor": "end" });
      label.textContent = Math.round(max - fraction * (max - min)).toLocaleString("fr-FR");
    });
    const line = points.map((point, index) => `${index ? "L" : "M"}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join(" ");
    add("path", { d: `${line} L${x(points.at(-1).time)},${height - margin.bottom} L${x(points[0].time)},${height - margin.bottom} Z`, class: "chart-area" });
    add("path", { d: line, class: "chart-line" });
    for (const point of points) {
      const dot = add("circle", { cx: x(point.time), cy: y(point.value), r: 4, class: "chart-dot" });
      const title = add("title", {}, dot);
      title.textContent = `${new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" }).format(new Date(point.time))} : ${price(point.value)} · ${point.count} vente${point.count > 1 ? "s" : ""}`;
    }
    [points[0].time, (points[0].time + points.at(-1).time) / 2, points.at(-1).time].forEach((time, index) => {
      const label = add("text", { x: index === 0 ? margin.left : index === 2 ? width - margin.right : margin.left + plotWidth / 2, y: height - 9, class: "axis-label", "text-anchor": index === 0 ? "start" : index === 2 ? "end" : "middle" });
      label.textContent = new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "short" }).format(new Date(time));
    });
    chartContainer.replaceChildren(svg);
    chartContainer.hidden = false;
    chartMessage.hidden = true;
    chartMessage.classList.remove("is-error");
  }

  async function loadCardData() {
    if (!selectedCard || !raritySelect.value) return;
    const sequence = ++dataSequence;
    const rarity = raritySelect.value;
    summary.replaceChildren();
    chartContainer.replaceChildren();
    chartContainer.hidden = true;
    message(chartMessage, "Chargement des ventes…");
    try {
      const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      const params = new URLSearchParams({
        select: "end_at,current_bid",
        card_id: `eq.${selectedCard.id}`,
        snapshot_rarity: `eq.${rarity}`,
        status: "eq.settled_sold",
        end_at: `gte.${since}`,
        order: "end_at.asc",
        limit: "1000",
      });
      const rows = desktop
        ? await window.wikiMasters.getHistory(selectedCard.id, rarity)
        : await request(`auctions?${params}`);
      if (sequence !== dataSequence) return;
      const sales = rows.filter((sale) => Number.isFinite(Number(sale.current_bid)) && Number(sale.current_bid) > 0 && Number.isFinite(new Date(sale.end_at).getTime()));
      renderSummary(sales);
      renderChart(sales);
    } catch (error) {
      if (sequence !== dataSequence) return;
      if (error.status === 401 && error.code === "42501") {
        message(chartMessage, "Les enchères demandent une session WikiMasters, mais leur API ne permet pas à GitHub Pages de la vérifier ou de la partager. Le propriétaire de WikiMasters doit autoriser cet accès inter-site.", true);
      } else {
        message(chartMessage, error.message || "Impossible de charger les données.", true);
      }
    }
  }

  const connection = $("#connection");
  const connectionText = $("#connectionText");
  async function refreshConnection() {
    if (!desktop) {
      connectionText.textContent = "Catalogue public";
      connection.title = "Le catalogue est public. L’historique nécessite l’application de bureau connectée à WikiMasters.";
      return;
    }
    try {
      const { connected } = await window.wikiMasters.authStatus();
      connectionText.textContent = connected ? "WikiMasters connecté" : "Connecter WikiMasters";
      connection.title = connected ? "Session WikiMasters détectée — cliquer pour revérifier" : "Cliquer pour ouvrir la connexion WikiMasters";
      connection.dataset.connected = String(connected);
    } catch {
      connectionText.textContent = "Connexion indisponible";
    }
  }
  connection.addEventListener("click", async () => {
    if (desktop) {
      await window.wikiMasters.openLogin();
      setTimeout(refreshConnection, 1500);
      setTimeout(refreshConnection, 5000);
    } else {
      window.open("https://www.wiki-masters.com/login", "_blank", "noopener,noreferrer");
    }
  });
  refreshConnection();
  $(".searchbox kbd").textContent = "Ctrl K";
  search.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
    }
  });
})();
