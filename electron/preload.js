const { contextBridge, ipcRenderer } = require("electron");

/*
 * Preload architecture:
 * - This is the only renderer-side file allowed to touch Electron IPC.
 * - It exposes a small, typed bridge to BlackShield's own file-based views.
 * - Remote websites loaded inside BrowserViews do not receive this API.
 */

function isInternalView() {
    if (window.location.protocol !== "file:") {
        return false;
    }

    const pathname = decodeURIComponent(window.location.pathname).replace(/\\/g, "/");

    return [
        "/views/index.html",
        "/views/newtab.html",
        "/views/downloads.html",
        "/views/protected-mode.html"
    ].some((suffix) => pathname.endsWith(suffix));
}

function on(channel, callback) {
    if (typeof callback !== "function") {
        return () => {};
    }

    const listener = (_event, payload) => {
        callback(payload);
    };

    ipcRenderer.on(channel, listener);

    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

if (isInternalView()) {
    const bridge = {
        navigation: {
            loadURL: (input) => ipcRenderer.send("navigation:load-url", String(input || "")),
            getActivePage: () => ipcRenderer.invoke("navigation:get-active-page"),
            onActivePageUpdated: (callback) => on("navigation:active-page-updated", callback)
        },

        tabs: {
            newTab: () => ipcRenderer.send("tabs:new"),
            switchTab: (id) => ipcRenderer.send("tabs:switch", String(id || "")),
            closeTab: (id) => ipcRenderer.send("tabs:close", String(id || "")),
            getTabs: () => ipcRenderer.invoke("tabs:get"),
            onUpdated: (callback) => on("tabs:updated", callback)
        },

        ui: {
            setDrawerWidth: (width) => ipcRenderer.send("ui:set-drawer-width", Number(width) || 0)
        },

        settings: {
            get: () => ipcRenderer.invoke("settings:get"),
            set: (config) => ipcRenderer.invoke("settings:set", config || {}),
            clearCache: () => ipcRenderer.invoke("privacy:clear-cache"),
            clearCookies: () => ipcRenderer.invoke("privacy:clear-cookies"),
            checkUpdates: () => ipcRenderer.invoke("updates:check")
        },

        updates: {
            check: () => ipcRenderer.invoke("updates:check"),
            getState: () => ipcRenderer.invoke("updates:get-state"),
            installDownloaded: () => ipcRenderer.send("updates:install-downloaded"),
            onState: (callback) => on("updates:state", callback)
        },

        integrity: {
            getState: () => ipcRenderer.invoke("integrity:get-state"),
            repair: () => ipcRenderer.invoke("integrity:repair"),
            downloadRepair: () => ipcRenderer.invoke("integrity:download-repair"),
            openProfile: () => ipcRenderer.invoke("integrity:open-profile"),
            onState: (callback) => on("integrity:state", callback)
        },

        history: {
            get: () => ipcRenderer.invoke("history:get")
        },

        bookmarks: {
            get: () => ipcRenderer.invoke("bookmarks:get"),
            add: (bookmark) => ipcRenderer.invoke("bookmarks:add", bookmark || {}),
            remove: (url) => ipcRenderer.invoke("bookmarks:remove", String(url || ""))
        },

        downloads: {
            get: () => ipcRenderer.invoke("downloads:get")
        },

        windowControls: {
            minimize: () => ipcRenderer.send("window:minimize"),
            maximize: () => ipcRenderer.send("window:maximize"),
            close: () => ipcRenderer.send("window:close"),
            onMaximized: (callback) => on("window:maximized", callback)
        }
    };

    contextBridge.exposeInMainWorld("blackshield", bridge);

    /*
     * Compatibility aliases for older internal views. They still route through
     * the same secure bridge and do not expose ipcRenderer.
     */
    contextBridge.exposeInMainWorld("api", {
        loadURL: bridge.navigation.loadURL,
        getConfig: bridge.settings.get,
        setConfig: bridge.settings.set,
        clearCache: bridge.settings.clearCache,
        clearCookies: bridge.settings.clearCookies,
        getHistory: bridge.history.get,
        getBookmarks: bridge.bookmarks.get,
        addBookmark: bridge.bookmarks.add,
        getDownloads: bridge.downloads.get,
        newTab: bridge.tabs.newTab,
        switchTab: bridge.tabs.switchTab,
        closeTab: bridge.tabs.closeTab,
        onTabsUpdated: bridge.tabs.onUpdated
    });

    contextBridge.exposeInMainWorld("win", {
        min: bridge.windowControls.minimize,
        max: bridge.windowControls.maximize,
        close: bridge.windowControls.close
    });
}
