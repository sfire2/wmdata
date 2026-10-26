chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["resolve-card", "search-cards", "auction-history"].includes(message?.type) || typeof message.key !== "string") return;
  if (message.type === "resolve-card" && typeof message.title !== "string") return;
  if (message.type === "search-cards" && (typeof message.query !== "string" || message.query.length < 2)) return;
  if (message.type === "auction-history" && (!/^[\w-]{12,}$/.test(message.cardId || "") || !/^(C|R|SR|UR|PC|L)$/.test(message.rarity || ""))) return;

  if (message.type === "auction-history") {
    const url = new URL("https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1/auctions");
    url.searchParams.set("select", "end_at,current_bid");
    url.searchParams.set("card_id", `eq.${message.cardId}`);
    url.searchParams.set("snapshot_rarity", `eq.${message.rarity}`);
    url.searchParams.set("status", "eq.settled_sold");
    url.searchParams.set("end_at", `gte.${new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()}`);
    url.searchParams.set("order", "end_at.asc");
    url.searchParams.set("limit", "1000");

    const bearer = typeof message.accessToken === "string" && message.accessToken.split(".").length === 3
      ? message.accessToken
      : message.key;
    fetch(url, { headers: { apikey: message.key, Authorization: `Bearer ${bearer}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((rows) => sendResponse(Array.isArray(rows) ? rows : []))
      .catch(() => sendResponse(null));
    return true;
  }

  const url = new URL("https://cyrxjeppjqsxxjayfrur.supabase.co/rest/v1/cards");
  url.searchParams.set("select", "id,rarity,wikipedia_title");
  url.searchParams.set("lang", "eq.fr");
  if (message.type === "resolve-card") {
    url.searchParams.set("wikipedia_title", `eq.${message.title}`);
  } else {
    url.searchParams.set("wikipedia_title", `ilike.*${message.query}*`);
    url.searchParams.set("limit", "12");
    url.searchParams.set("order", "wikipedia_title.asc");
  }

  fetch(url, {
    headers: { apikey: message.key, Authorization: `Bearer ${message.key}` },
  })
    .then((response) => (response.ok ? response.json() : []))
    .then((rows) => sendResponse(message.type === "resolve-card" ? rows[0] || null : rows))
    .catch(() => sendResponse(message.type === "resolve-card" ? null : []));

  return true;
});
