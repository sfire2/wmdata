(() => {
  const API = "https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1";
  const AUTH = "https://cyrxjeppjqsxxjayfrur.supabase.co/auth/v1";
  const SESSION_KEY = "wm-cotes-refresh-token";
  const RARITIES = ["C", "R", "SR", "UR", "PC", "L"];
  const $ = (selector) => document.querySelector(selector);
  const search = $("#cardSearch");
  const results = $("#searchResults");
  const searchHelp = $("#searchHelp");
  const workspace = $("#workspace");
  const raritySelect = $("#raritySelect");
  const summary = $("#summary");
  const chartMessage = $("#chartMessage");
  const chartContainer = $("#chartContainer");
  const connection = $("#connection");
  const connectionText = $("#connectionText");
  const loginButton = $("#loginButton");
  const logoutButton = $("#logoutButton");
  const loginDialog = $("#loginDialog");
  const loginForm = $("#loginForm");
  const loginMessage = $("#loginMessage");
  const submitLogin = $("#submitLogin");
  const cache = new Map();
  let selectedCard = null;
  let searchTimer;
  let searchSequence = 0;
  let dataSequence = 0;
  let authSession = null;
  let restoreSessionPromise;

  const price = (value) => `${Math.round(value).toLocaleString("fr-FR")} WB`;

  function message(node, text, isError = false) {
    node.textContent = text;
    node.hidden = false;
    node.classList.toggle("is-error", isError);
  }

  function request(path, accessToken) {
    const key = window.WM_CONFIG?.anonKey;
    if (!key) throw new Error("Configuration du catalogue introuvable. Rechargez la page plus tard.");
    return fetch(`${API}/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${accessToken || key}` },
    }).then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload.message || `Catalogue indisponible (HTTP ${response.status}).`);
        error.status = response.status;
        error.code = payload.code;
        throw error;
      }
      return response.json();
    });
  }

  function updateConnection() {
    const connected = Boolean(authSession?.refreshToken && authSession?.accessToken);
    connection.classList.toggle("is-connected", connected);
    connectionText.textContent = connected ? "Session WikiMasters active" : "Session WikiMasters requise";
    loginButton.hidden = connected;
    logoutButton.hidden = !connected;
  }

  function saveRefreshToken(refreshToken) {
    authSession = { ...authSession, refreshToken };
    try { localStorage.setItem(SESSION_KEY, refreshToken); } catch { /* Le jeton reste en mémoire jusqu'à la fermeture. */ }
  }

  function clearSession() {
    authSession = null;
    try { localStorage.removeItem(SESSION_KEY); } catch { /* stockage indisponible */ }
    updateConnection();
  }

  async function requestAuthToken(grant, body) {
    const key = window.WM_CONFIG?.anonKey;
    if (!key) throw new Error("Configuration du catalogue introuvable. Rechargez la page plus tard.");
    const response = await fetch(`${AUTH}/token?grant_type=${grant}`, {
      method: "POST",
      headers: { apikey: key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(response.status === 400 || response.status === 401
        ? "Identifiants incorrects ou session WikiMasters indisponible."
        : `Connexion indisponible (HTTP ${response.status}).`);
      error.status = response.status;
      error.sessionExpired = grant === "refresh_token" && (response.status === 400 || response.status === 401);
      throw error;
    }
    return payload;
  }

  function acceptSession(payload) {
    if (!payload.access_token || !payload.refresh_token) throw new Error("WikiMasters n’a pas renvoyé de session valide.");
    authSession = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresAt: Date.now() + Number(payload.expires_in || 3600) * 1000,
    };
    saveRefreshToken(payload.refresh_token);
    updateConnection();
  }

  async function refreshSession() {
    if (!authSession?.refreshToken) return null;
    const payload = await requestAuthToken("refresh_token", { refresh_token: authSession.refreshToken });
    acceptSession(payload);
    return authSession.accessToken;
  }

  async function getAccessToken() {
    if (!authSession?.refreshToken) return null;
    if (!authSession.accessToken || authSession.expiresAt < Date.now() + 60_000) return refreshSession();
    return authSession.accessToken;
  }

  async function restoreSession() {
    connectionText.textContent = "Vérification de la session…";
    let refreshToken = "";
    try { refreshToken = localStorage.getItem(SESSION_KEY) || ""; } catch { /* stockage indisponible */ }
    if (!refreshToken) {
      updateConnection();
      return;
    }
    authSession = { refreshToken };
    try {
      await refreshSession();
    } catch (error) {
      if (error.status === 400 || error.status === 401) clearSession();
      else {
        updateConnection();
        connectionText.textContent = "Session à vérifier";
      }
    }
  }

  loginButton.addEventListener("click", () => loginDialog.showModal());
  $("#closeLogin").addEventListener("click", () => loginDialog.close());
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    submitLogin.disabled = true;
    submitLogin.textContent = "Connexion…";
    loginMessage.hidden = true;
    try {
      const payload = await requestAuthToken("password", {
        email: $("#loginEmail").value.trim(),
        password: $("#loginPassword").value,
      });
      acceptSession(payload);
      loginForm.reset();
      loginDialog.close();
      if (selectedCard && raritySelect.value) loadCardData();
    } catch (error) {
      message(loginMessage, error.message || "La connexion a échoué.", true);
    } finally {
      submitLogin.disabled = false;
      submitLogin.textContent = "Se connecter";
    }
  });

  logoutButton.addEventListener("click", async () => {
    const token = authSession?.accessToken;
    if (token) {
      try {
        const key = window.WM_CONFIG?.anonKey;
        await fetch(`${AUTH}/logout`, { method: "POST", headers: { apikey: key, Authorization: `Bearer ${token}` } });
      } catch { /* La session locale est effacée même si le serveur est inaccessible. */ }
    }
    clearSession();
    if (selectedCard && raritySelect.value) message(chartMessage, "Connectez-vous à WikiMasters pour consulter les ventes.");
  });

  async function findCards(query) {
    const normalized = query.trim().toLocaleLowerCase("fr-FR");
    if (cache.has(normalized)) return cache.get(normalized);
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
      const button = document.createElement("button");
      button.className = "search-result";
      button.type = "button";
      button.setAttribute("role", "option");
      const icon = document.createElement("span");
      icon.className = "result-symbol";
      icon.textContent = "✳";
      const title = document.createElement("span");
      title.className = "result-title";
      title.textContent = card.wikipedia_title;
      const rarity = document.createElement("span");
      rarity.className = "result-rarity";
      rarity.textContent = card.rarity || "—";
      button.append(icon, title, rarity);
      button.addEventListener("click", () => selectCard(card));
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
      message(searchHelp, "Saisissez au moins 2 caractères");
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
    $("#selectedName").textContent = card.wikipedia_title;
    raritySelect.replaceChildren();
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "Choisir la rareté";
    raritySelect.append(placeholder);
    for (const rarity of RARITIES) {
      const option = document.createElement("option");
      option.value = rarity;
      option.textContent = rarity;
      raritySelect.append(option);
    }
    raritySelect.value = RARITIES.includes(card.rarity) ? card.rarity : "";
    summary.replaceChildren();
    chartContainer.replaceChildren();
    chartContainer.hidden = true;
    message(chartMessage, "Choisissez une rareté pour charger l’historique.");
    workspace.hidden = false;
    if (raritySelect.value) loadCardData();
    workspace.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  raritySelect.addEventListener("change", loadCardData);

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
      await restoreSessionPromise;
      let accessToken = await getAccessToken();
      if (!accessToken) {
        message(chartMessage, "Connectez-vous à WikiMasters pour consulter les ventes.");
        if (!loginDialog.open) loginDialog.showModal();
        return;
      }
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
      let rows;
      try {
        rows = await request(`auctions?${params}`, accessToken);
      } catch (error) {
        if (error.status !== 401 || error.code === "42501") throw error;
        accessToken = await refreshSession();
        if (!accessToken) throw error;
        rows = await request(`auctions?${params}`, accessToken);
      }
      if (sequence !== dataSequence) return;
      const sales = rows.filter((sale) => Number.isFinite(Number(sale.current_bid)) && Number(sale.current_bid) > 0 && Number.isFinite(new Date(sale.end_at).getTime()));
      renderSummary(sales);
      renderChart(sales);
    } catch (error) {
      if (error.sessionExpired || (error.status === 401 && error.code !== "42501")) {
        clearSession();
        if (sequence === dataSequence) {
          message(chartMessage, "Votre session WikiMasters a expiré. Reconnectez-vous pour afficher les ventes.", true);
          if (!loginDialog.open) loginDialog.showModal();
        }
      } else if (sequence === dataSequence) {
        const text = error.code === "42501"
          ? "WikiMasters refuse l’accès à l’historique pour cette session."
          : error.message || "Impossible de charger les données.";
        message(chartMessage, text, true);
      }
    }
  }

  restoreSessionPromise = restoreSession();
  search.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
    }
  });
})();
