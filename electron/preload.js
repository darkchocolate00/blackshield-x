const {
    contextBridge,
    ipcRenderer
} = require("electron");

/* =========================================
   API
========================================= */

contextBridge.exposeInMainWorld(

    "api",

    {

        /* =========================
           NAVIGATION
        ========================= */

        loadURL: (url) =>

            ipcRenderer.send(
                "load-url",
                url
            ),

        /* =========================
           CONFIG
        ========================= */

        getConfig: () =>

            ipcRenderer.invoke(
                "get-config"
            ),

        setConfig: (cfg) =>

            ipcRenderer.send(
                "set-config",
                cfg
            ),

        /* =========================
           CACHE
        ========================= */

        clearCache: () =>

            ipcRenderer.invoke(
                "clear-cache"
            ),

        /* =========================
           COOKIES
        ========================= */

        clearCookies: () =>

            ipcRenderer.invoke(
                "clear-cookies"
            ),

        /* =========================
           HISTORY
        ========================= */

        getHistory: () =>

            ipcRenderer.invoke(
                "get-history"
            ),

        /* =========================
           BOOKMARKS
        ========================= */

        getBookmarks: () =>

            ipcRenderer.invoke(
                "get-bookmarks"
            ),

        addBookmark: (bookmark) =>

            ipcRenderer.send(
                "add-bookmark",
                bookmark
            ),

        /* =========================
           DOWNLOADS
        ========================= */

        getDownloads: () =>

            ipcRenderer.invoke(
                "get-downloads"
            ),

        /* =========================
           TABS
        ========================= */

        newTab: () =>

            ipcRenderer.send(
                "new-tab"
            ),

        switchTab: (id) =>

            ipcRenderer.send(
                "switch-tab",
                id
            ),

        closeTab: (id) =>

            ipcRenderer.send(
                "close-tab",
                id
            ),

        onTabsUpdated: (callback) =>

            ipcRenderer.on(

                "tabs-updated",

                (event, data) => {

                    callback(data);
                }
            )
    }
);

/* =========================================
   WINDOW CONTROLS
========================================= */

contextBridge.exposeInMainWorld(

    "win",

    {

        min: () =>

            ipcRenderer.send(
                "win-min"
            ),

        max: () =>

            ipcRenderer.send(
                "win-max"
            ),

        close: () =>

            ipcRenderer.send(
                "win-close"
            )
    }
);