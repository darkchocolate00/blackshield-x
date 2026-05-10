const {
    app,
    BrowserWindow,
    BrowserView,
    ipcMain,
    Menu,
    session
} = require("electron");

const updater = require(
    "./updater/updater"
);

const path = require("path");
const fs = require("fs");

let mainWindow;

let tabs = [];

let activeTabId = null;

const TABBAR_HEIGHT = 42;
const TOPBAR_HEIGHT = 70;

const TOTAL_TOP_HEIGHT =
    TABBAR_HEIGHT + TOPBAR_HEIGHT;

/* =========================================
   PROFILE DIRECTORY
========================================= */

const profileDir = path.join(
    __dirname,
    "profile"
);

if (!fs.existsSync(profileDir)) {

    fs.mkdirSync(profileDir, {
        recursive: true
    });
}

/* =========================================
   CONFIG
========================================= */

const configPath = path.join(
    profileDir,
    "config.json"
);

const defaultConfig = {

    searchEngine:
        "duckduckgo",

    performance:
        "balanced",

    autoUpdate:
        true,

    saveHistory:
        true
};

function loadConfig() {

    try {

        const raw =
            fs.readFileSync(
                configPath,
                "utf8"
            );

        return JSON.parse(raw);

    } catch {

        fs.writeFileSync(

            configPath,

            JSON.stringify(
                defaultConfig,
                null,
                2
            )
        );

        return defaultConfig;
    }
}

function saveConfig(cfg) {

    fs.writeFileSync(

        configPath,

        JSON.stringify(
            cfg,
            null,
            2
        )
    );
}

/* =========================================
   HISTORY
========================================= */

const historyPath = path.join(
    profileDir,
    "history.json"
);

function loadHistory() {

    try {

        return JSON.parse(

            fs.readFileSync(
                historyPath,
                "utf8"
            )
        );

    } catch {

        fs.writeFileSync(
            historyPath,
            "[]"
        );

        return [];
    }
}

function saveHistory(url) {

    const cfg =
        loadConfig();

    if (!cfg.saveHistory) {
        return;
    }

    let history =
        loadHistory();

    history.unshift({

        url,

        time:
            Date.now()
    });

    history = history.slice(0, 100);

    fs.writeFileSync(

        historyPath,

        JSON.stringify(
            history,
            null,
            2
        )
    );
}

/* =========================================
   BOOKMARKS
========================================= */

const bookmarksPath = path.join(
    profileDir,
    "bookmarks.json"
);

function loadBookmarks() {

    try {

        return JSON.parse(

            fs.readFileSync(
                bookmarksPath,
                "utf8"
            )
        );

    } catch {

        fs.writeFileSync(
            bookmarksPath,
            "[]"
        );

        return [];
    }
}

function saveBookmarks(data) {

    fs.writeFileSync(

        bookmarksPath,

        JSON.stringify(
            data,
            null,
            2
        )
    );
}

/* =========================================
   DOWNLOADS
========================================= */

const downloadsPath = path.join(
    profileDir,
    "downloads.json"
);

function loadDownloads() {

    try {

        return JSON.parse(

            fs.readFileSync(
                downloadsPath,
                "utf8"
            )
        );

    } catch {

        fs.writeFileSync(
            downloadsPath,
            "[]"
        );

        return [];
    }
}

function saveDownloads(data) {

    fs.writeFileSync(

        downloadsPath,

        JSON.stringify(
            data,
            null,
            2
        )
    );
}

/* =========================================
   SEARCH ENGINE
========================================= */

function resolveURL(input) {

    const cfg =
        loadConfig();

    input = input.trim();

    if (!input) {
        return "about:blank";
    }

    const isSearch =

        input.includes(" ") ||

        !input.includes(".");

    if (isSearch) {

        const engines = {

            google:
                "https://www.google.com/search?q=",

            duckduckgo:
                "https://duckduckgo.com/?q=",

            brave:
                "https://search.brave.com/search?q=",

            bing:
                "https://www.bing.com/search?q="
        };

        const engine =

            engines[cfg.searchEngine] ||

            engines.duckduckgo;

        return (
            engine +
            encodeURIComponent(input)
        );
    }

    if (

        !input.startsWith("http://") &&

        !input.startsWith("https://")

    ) {

        return "https://" + input;
    }

    return input;
}

/* =========================================
   ACTIVE TAB
========================================= */

function getActiveTab() {

    return tabs.find(
        tab => tab.id === activeTabId
    );
}

/* =========================================
   WINDOW
========================================= */

function createWindow() {

    mainWindow =
        new BrowserWindow({

            width: 1400,
            height: 900,

            minWidth: 1000,
            minHeight: 700,

            frame: false,

            backgroundColor:
                "#000000",

            icon: path.join(
                __dirname,
                "assets",
                "icon.ico"
            ),

            webPreferences: {

                preload: path.join(
                    __dirname,
                    "preload.js"
                ),

                contextIsolation: true,

                nodeIntegration: false
            }
        });

    Menu.setApplicationMenu(null);

    mainWindow.loadFile(

        path.join(
            __dirname,
            "views",
            "index.html"
        )
    );

    createTab();

    mainWindow.on(
        "resize",
        updateBrowserBounds
    );
}

/* =========================================
   CREATE TAB
========================================= */

function createTab(url = null) {

    const id =
        Date.now().toString();

    const view =
        new BrowserView({

            webPreferences: {

                partition:
                    "persist:blackshieldx",

                contextIsolation:
                    true,

                nodeIntegration:
                    false
            }
        });

    const tab = {

        id,

        title:
            "New Tab",

        view
    };

    tabs.push(tab);

    activeTabId = id;

    mainWindow.setBrowserView(
        view
    );

    updateBrowserBounds();

    if (url) {

        view.webContents.loadURL(url);

    } else {

        view.webContents.loadFile(

            path.join(
                __dirname,
                "views",
                "newtab.html"
            )
        );
    }

    /* HISTORY */

    view.webContents.on(

        "did-navigate",

        (event, url) => {

            saveHistory(url);
        }
    );

    /* DOWNLOADS */

    view.webContents.session.on(

        "will-download",

        (event, item) => {

            const file = {

                name:
                    item.getFilename(),

                path:
                    item.getSavePath(),

                url:
                    item.getURL(),

                size:
                    item.getTotalBytes(),

                time:
                    Date.now()
            };

            const downloads =
                loadDownloads();

            downloads.unshift(file);

            saveDownloads(downloads);
        }
    );

    /* TITLE */

    view.webContents.on(

        "page-title-updated",

        (event, title) => {

            tab.title = title;

            sendTabsToRenderer();
        }
    );

    sendTabsToRenderer();
}

/* =========================================
   SWITCH TAB
========================================= */

function switchTab(id) {

    const tab =
        tabs.find(
            t => t.id === id
        );

    if (!tab) {
        return;
    }

    activeTabId = id;

    mainWindow.setBrowserView(
        tab.view
    );

    updateBrowserBounds();

    sendTabsToRenderer();
}

/* =========================================
   CLOSE TAB
========================================= */

function closeTab(id) {

    const index =
        tabs.findIndex(
            t => t.id === id
        );

    if (index === -1) {
        return;
    }

    const tab =
        tabs[index];

    tab.view.webContents.destroy();

    tabs.splice(index, 1);

    if (tabs.length === 0) {

        createTab();

        return;
    }

    activeTabId =
        tabs[0].id;

    mainWindow.setBrowserView(
        tabs[0].view
    );

    updateBrowserBounds();

    sendTabsToRenderer();
}

/* =========================================
   SEND TABS
========================================= */

function sendTabsToRenderer() {

    const cleanTabs =
        tabs.map(tab => ({

            id: tab.id,

            title: tab.title
        }));

    mainWindow.webContents.send(

        "tabs-updated",

        {

            tabs: cleanTabs,

            activeTabId
        }
    );
}

/* =========================================
   RESIZE
========================================= */

function updateBrowserBounds() {

    const active =
        getActiveTab();

    if (!active) {
        return;
    }

    const bounds =
        mainWindow.getBounds();

    active.view.setBounds({

        x: 0,

        y: TOTAL_TOP_HEIGHT,

        width:
        bounds.width,

        height:
            bounds.height -
            TOTAL_TOP_HEIGHT
    });
}

/* =========================================
   NAVIGATION
========================================= */

ipcMain.on(

    "load-url",

    (event, input) => {

        const active =
            getActiveTab();

        if (!active) {
            return;
        }

        const url =
            resolveURL(input);

        active.view.webContents.loadURL(
            url
        );
    }
);

/* =========================================
   TABS IPC
========================================= */

ipcMain.on(
    "new-tab",
    () => {

        createTab();
    }
);

ipcMain.on(
    "switch-tab",
    (event, id) => {

        switchTab(id);
    }
);

ipcMain.on(
    "close-tab",
    (event, id) => {

        closeTab(id);
    }
);

/* =========================================
   SETTINGS
========================================= */

ipcMain.handle(

    "get-config",

    () => {

        return loadConfig();
    }
);

ipcMain.on(

    "set-config",

    (event, cfg) => {

        const updated = {

            ...loadConfig(),

            ...cfg
        };

        saveConfig(updated);
    }
);

/* =========================================
   HISTORY IPC
========================================= */

ipcMain.handle(

    "get-history",

    () => {

        return loadHistory();
    }
);

/* =========================================
   BOOKMARKS IPC
========================================= */

ipcMain.handle(

    "get-bookmarks",

    () => {

        return loadBookmarks();
    }
);

ipcMain.on(

    "add-bookmark",

    (event, bookmark) => {

        const data =
            loadBookmarks();

        data.unshift(bookmark);

        saveBookmarks(data);
    }
);

/* =========================================
   DOWNLOADS IPC
========================================= */

ipcMain.handle(

    "get-downloads",

    () => {

        return loadDownloads();
    }
);

/* =========================================
   CACHE
========================================= */

ipcMain.handle(

    "clear-cache",

    async () => {

        const ses =
            session.fromPartition(
                "persist:blackshieldx"
            );

        await ses.clearCache();

        return true;
    }
);

/* =========================================
   COOKIES
========================================= */

ipcMain.handle(

    "clear-cookies",

    async () => {

        const ses =
            session.fromPartition(
                "persist:blackshieldx"
            );

        await ses.clearStorageData({

            storages: [
                "cookies"
            ]
        });

        return true;
    }
);

/* =========================================
   WINDOW CONTROLS
========================================= */

ipcMain.on(

    "win-min",

    () => {

        mainWindow.minimize();
    }
);

ipcMain.on(

    "win-max",

    () => {

        if (
            mainWindow.isMaximized()
        ) {

            mainWindow.unmaximize();

        } else {

            mainWindow.maximize();
        }
    }
);

ipcMain.on(

    "win-close",

    () => {

        mainWindow.close();
    }
);

/* =========================================
   START
========================================= */

app.whenReady().then(() => {

    updater.startUpdater();

    createWindow();

    app.on(

        "activate",

        () => {

            if (
                BrowserWindow
                    .getAllWindows()
                    .length === 0
            ) {

                createWindow();
            }
        }
    );
});

app.on(

    "window-all-closed",

    () => {

        if (
            process.platform !==
            "darwin"
        ) {

            app.quit();
        }
    }
);