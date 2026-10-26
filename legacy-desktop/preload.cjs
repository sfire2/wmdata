const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("wikiMasters", {
  authStatus: () => ipcRenderer.invoke("auth:status"),
  openLogin: () => ipcRenderer.invoke("auth:open-login"),
  searchCards: (query) => ipcRenderer.invoke("cards:search", query),
  getPrices: (cardId) => ipcRenderer.invoke("card:prices", cardId),
  getHistory: (cardId, rarity) => ipcRenderer.invoke("card:history", cardId, rarity),
});
