const {
    app,
    BrowserWindow,
    BrowserView,
    ipcMain,
    Menu,
    session,
    shell
} = require("electron");

const fs = require("fs");
const path = require("path");
const updater = require("./updater/updater");
const integrity = require("./security/integrity");
const recovery = require("./security/recovery");

app.setAppUserModelId("com.blackshieldx.app");

/*
 * Main-process architecture:
 * - Owns the native Electron window, BrowserView tabs, persistent profile files,
 *   privileged IPC handlers, update startup, and window controls.
 * - Renderer code never receives Electron primitives directly; it talks through
 *   the preload bridge and these narrow IPC channels.
 */

const APP_ROOT = __dirname;
const VIEWS_DIR = path.join(APP_ROOT, "views");
const PRELOAD_PATH = path.join(APP_ROOT, "preload.js");
const USER_DATA_DIR = path.join(app.getPath("appData"), "BlackShieldX");
app.setPath("userData", USER_DATA_DIR);

const PROFILE_DIR = path.join(USER_DATA_DIR, "profile");
const PARTITION = "persist:blackshieldx";

const TABBAR_HEIGHT = 42;
const TOPBAR_HEIGHT = 70;
const BROWSER_TOP_OFFSET = TABBAR_HEIGHT + TOPBAR_HEIGHT;
const MAX_DRAWER_WIDTH = 420;

const defaultConfig = {
    searchEngine: "duckduckgo",
    performance: "balanced",
    autoUpdate: true,
    saveHistory: true,
    updateChannel: "latest"
};

const profileFiles = {
    config: path.join(PROFILE_DIR, "config.json"),
    history: path.join(PROFILE_DIR, "history.json"),
    bookmarks: path.join(PROFILE_DIR, "bookmarks.json"),
    downloads: path.join(PROFILE_DIR, "downloads.json")
};

let mainWindow = null;
let tabs = [];
let activeTabId = null;
let drawerWidth = 0;
let downloadsListenerAttached = false;
let integrityStatus = null;
let testShutdownScheduled = false;

function ensureProfile() {
    if (!fs.existsSync(PROFILE_DIR)) {
        fs.mkdirSync(PROFILE_DIR, { recursive: true });
    }
}

function migrateLegacyProfile() {
    const legacyProfileDir = path.join(APP_ROOT, "profile");

    if (!fs.existsSync(legacyProfileDir)) {
        return;
    }

    [
        "config.json",
        "history.json",
        "bookmarks.json",
        "downloads.json",
        "session.json",
        "module_versions.json"
    ].forEach((fileName) => {
        const source = path.join(legacyProfileDir, fileName);
        const target = path.join(PROFILE_DIR, fileName);

        if (fs.existsSync(source) && !fs.existsSync(target)) {
            fs.copyFileSync(source, target);
        }
    });
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function readJson(filePath, fallback) {
    ensureProfile();

    try {
        const raw = fs.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        return parsed;
    } catch {
        const value = clone(fallback);
        fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
        return value;
    }
}

function writeJson(filePath, value) {
    ensureProfile();
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadConfig() {
    return {
        ...defaultConfig,
        ...readJson(profileFiles.config, defaultConfig)
    };
}

function saveConfig(config) {
    writeJson(profileFiles.config, {
        ...defaultConfig,
        ...config
    });
}

function loadHistory() {
    return readJson(profileFiles.history, []);
}

function saveHistoryEntries(entries) {
    writeJson(profileFiles.history, entries);
}

function loadBookmarks() {
    return readJson(profileFiles.bookmarks, []);
}

function saveBookmarks(entries) {
    writeJson(profileFiles.bookmarks, entries);
}

function loadDownloads() {
    return readJson(profileFiles.downloads, []);
}

function saveDownloads(entries) {
    writeJson(profileFiles.downloads, entries);
}

function isHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || ""));
}

function isInternalFileUrl(url) {
    const normalized = String(url || "").replace(/\\/g, "/");
    return normalized.startsWith("file:///") && normalized.includes("/views/");
}

function isNewTabUrl(url) {
    return isInternalFileUrl(url) && String(url).replace(/\\/g, "/").endsWith("/newtab.html");
}

function resolveURL(input) {
    const value = String(input || "").trim();

    if (!value) {
        return null;
    }

    if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) {
        return value;
    }

    const looksLikeDomain =
        /^localhost(?::\d+)?(?:\/.*)?$/i.test(value) ||
        /^(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?(?:\/.*)?$/.test(value) ||
        (!/\s/.test(value) && value.includes("."));

    if (looksLikeDomain) {
        return `https://${value}`;
    }

    const engines = {
        google: "https://www.google.com/search?q=",
        duckduckgo: "https://duckduckgo.com/?q=",
        brave: "https://search.brave.com/search?q=",
        bing: "https://www.bing.com/search?q="
    };

    const config = loadConfig();
    const engine = engines[config.searchEngine] || engines.duckduckgo;
    return engine + encodeURIComponent(value);
}

function getActiveTab() {
    return tabs.find((tab) => tab.id === activeTabId) || null;
}

function getTabUrl(tab) {
    if (!tab || tab.view.webContents.isDestroyed()) {
        return "";
    }

    return tab.view.webContents.getURL();
}

function getActivePagePayload() {
    const active = getActiveTab();

    if (!active) {
        return {
            url: "",
            title: "New Tab",
            isInternal: true
        };
    }

    const url = getTabUrl(active);

    return {
        url,
        title: active.title || "New Tab",
        isInternal: isInternalFileUrl(url)
    };
}

function getTabsPayload() {
    return {
        tabs: tabs.map((tab) => ({
            id: tab.id,
            title: tab.title || "New Tab",
            url: getTabUrl(tab)
        })),
        activeTabId
    };
}

function sendToShell(channel, payload) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    mainWindow.webContents.send(channel, payload);
}

function sendTabsToRenderer() {
    sendToShell("tabs:updated", getTabsPayload());
    sendToShell("navigation:active-page-updated", getActivePagePayload());
}

function getUpdaterOptions({ manual = false } = {}) {
    const config = loadConfig();

    return {
        channel: config.updateChannel || "latest",
        enableElectronUpdater: true,
        enableModuleUpdater: app.isPackaged || manual || Boolean(process.env.BLACKSHIELD_MODULE_MANIFEST_URL)
    };
}

function relayUpdaterState() {
    updater.onStateChange((state) => {
        sendToShell("updates:state", state);
    });

    integrity.onStateChange((state) => {
        sendToShell("integrity:state", state);
    });
}

function scheduleTestShutdown() {
    if (testShutdownScheduled) {
        return;
    }

    const quitAfterArg = process.argv.find((arg) => {
        return String(arg || "").startsWith("--blackshield-test-quit-after=");
    });
    const argDelay = quitAfterArg
        ? quitAfterArg.split("=").slice(1).join("=")
        : "";
    const switchDelay = app.commandLine.getSwitchValue("blackshield-test-quit-after");
    const delay = Number(switchDelay || argDelay || process.env.BLACKSHIELD_TEST_QUIT_AFTER_MS || 0);

    if (!delay || delay < 1000) {
        return;
    }

    testShutdownScheduled = true;

    setTimeout(() => {
        BrowserWindow.getAllWindows().forEach((window) => {
            if (!window.isDestroyed()) {
                window.destroy();
            }
        });
        app.exit(0);
    }, delay);
}

function protectedModePayload() {
    return integrityStatus || integrity.getIntegrityState();
}

function rejectIfProtected() {
    if (integrity.isProtectedMode()) {
        throw integrity.createProtectedServicesError();
    }
}

function addHistoryEntry(url, title) {
    const config = loadConfig();

    if (!config.saveHistory || !isHttpUrl(url)) {
        return;
    }

    const active = getActiveTab();

    if (active && active.lastHistoryUrl === url) {
        return;
    }

    if (active) {
        active.lastHistoryUrl = url;
    }

    const history = loadHistory();
    const entry = {
        url,
        title: title || url,
        time: Date.now()
    };

    const withoutDuplicate = history.filter((item) => item && item.url !== url);
    saveHistoryEntries([entry, ...withoutDuplicate].slice(0, 200));
}

function normalizeBookmark(bookmark) {
    const url = String(bookmark && bookmark.url ? bookmark.url : "").trim();

    if (!isHttpUrl(url)) {
        return null;
    }

    return {
        url,
        title: String(bookmark.title || url).trim() || url,
        time: Number(bookmark.time) || Date.now()
    };
}

function createBrowserView(tab) {
    const view = new BrowserView({
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            partition: PARTITION
        }
    });

    const webContents = view.webContents;

    webContents.setWindowOpenHandler(({ url }) => {
        createTab(url);
        return { action: "deny" };
    });

    webContents.on("did-start-loading", sendTabsToRenderer);
    webContents.on("did-stop-loading", sendTabsToRenderer);

    webContents.on("page-title-updated", (_event, title) => {
        tab.title = title || "New Tab";
        sendTabsToRenderer();
    });

    webContents.on("did-navigate", (_event, url) => {
        tab.title = isNewTabUrl(url) ? "New Tab" : (webContents.getTitle() || tab.title || "New Tab");
        addHistoryEntry(url, tab.title);
        sendTabsToRenderer();
    });

    webContents.on("did-navigate-in-page", (_event, url) => {
        addHistoryEntry(url, webContents.getTitle() || tab.title);
        sendTabsToRenderer();
    });

    webContents.on("did-finish-load", () => {
        const url = webContents.getURL();
        tab.title = isNewTabUrl(url) ? "New Tab" : (webContents.getTitle() || tab.title || "New Tab");
        sendTabsToRenderer();
    });

    webContents.on("render-process-gone", (_event, details) => {
        console.error("[BrowserView] Render process gone:", details.reason);
    });

    return view;
}

function updateBrowserBounds() {
    const active = getActiveTab();

    if (!active || !mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    const [width, height] = mainWindow.getContentSize();
    const usableWidth = Math.max(320, width - drawerWidth);
    const usableHeight = Math.max(240, height - BROWSER_TOP_OFFSET);

    active.view.setBounds({
        x: 0,
        y: BROWSER_TOP_OFFSET,
        width: usableWidth,
        height: usableHeight
    });
}

function attachActiveView(view) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    mainWindow.setBrowserView(view);
    updateBrowserBounds();
}

function createTab(initialUrl = null) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return null;
    }

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const tab = {
        id,
        title: "New Tab",
        view: null,
        lastHistoryUrl: ""
    };

    tab.view = createBrowserView(tab);
    tabs.push(tab);
    activeTabId = id;
    attachActiveView(tab.view);

    const target = resolveURL(initialUrl);

    if (target) {
        tab.view.webContents.loadURL(target);
    } else {
        tab.view.webContents.loadFile(path.join(VIEWS_DIR, "newtab.html"));
    }

    sendTabsToRenderer();
    return id;
}

function switchTab(id) {
    const tab = tabs.find((item) => item.id === id);

    if (!tab) {
        return;
    }

    activeTabId = id;
    attachActiveView(tab.view);
    sendTabsToRenderer();
}

function closeTab(id) {
    const index = tabs.findIndex((tab) => tab.id === id);

    if (index === -1) {
        return;
    }

    const [closed] = tabs.splice(index, 1);

    if (closed.view && !closed.view.webContents.isDestroyed()) {
        closed.view.webContents.destroy();
    }

    if (tabs.length === 0) {
        createTab();
        return;
    }

    if (activeTabId === id) {
        const nextIndex = Math.min(index, tabs.length - 1);
        activeTabId = tabs[nextIndex].id;
        attachActiveView(tabs[nextIndex].view);
    }

    sendTabsToRenderer();
}

function loadInActiveTab(input) {
    const active = getActiveTab();
    const target = resolveURL(input);

    if (!active || !target) {
        return;
    }

    active.view.webContents.loadURL(target);
}

function attachDownloadsListener() {
    if (downloadsListenerAttached) {
        return;
    }

    downloadsListenerAttached = true;

    session.fromPartition(PARTITION).on("will-download", (_event, item) => {
        const startedAt = Date.now();

        item.once("done", (_doneEvent, state) => {
            const downloads = loadDownloads();

            downloads.unshift({
                name: item.getFilename(),
                path: item.getSavePath() || "",
                url: item.getURL(),
                size: item.getTotalBytes(),
                state,
                time: startedAt
            });

            saveDownloads(downloads.slice(0, 200));
        });
    });
}

function configureSecurity() {
    const denyPermission = (_webContents, _permission, callback) => {
        callback(false);
    };

    session.defaultSession.setPermissionRequestHandler(denyPermission);
    session.fromPartition(PARTITION).setPermissionRequestHandler(denyPermission);

    app.on("web-contents-created", (_event, contents) => {
        contents.on("will-attach-webview", (event) => {
            event.preventDefault();
        });
    });
}

async function createWindow() {
    const iconPath = path.join(APP_ROOT, "assets", "icon.ico");

    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        frame: false,
        show: false,
        backgroundColor: "#050505",
        ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: !app.isPackaged
        }
    });

    Menu.setApplicationMenu(null);

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (!isInternalFileUrl(url)) {
            event.preventDefault();
        }
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
    });

    mainWindow.on("resize", updateBrowserBounds);
    mainWindow.on("maximize", () => sendToShell("window:maximized", true));
    mainWindow.on("unmaximize", () => sendToShell("window:maximized", false));
    mainWindow.on("closed", () => {
        mainWindow = null;
        tabs = [];
        activeTabId = null;
    });

    await mainWindow.loadFile(path.join(VIEWS_DIR, "index.html"));
    createTab();
}

async function createProtectedWindow() {
    const iconPath = path.join(APP_ROOT, "assets", "icon.ico");

    mainWindow = new BrowserWindow({
        width: 1200,
        height: 820,
        minWidth: 900,
        minHeight: 680,
        frame: false,
        show: false,
        backgroundColor: "#050505",
        ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
        webPreferences: {
            preload: PRELOAD_PATH,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            devTools: !app.isPackaged
        }
    });

    Menu.setApplicationMenu(null);

    mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (!isInternalFileUrl(url)) {
            event.preventDefault();
        }
    });

    mainWindow.once("ready-to-show", () => {
        mainWindow.show();
        sendToShell("integrity:state", protectedModePayload());
    });

    mainWindow.on("maximize", () => sendToShell("window:maximized", true));
    mainWindow.on("unmaximize", () => sendToShell("window:maximized", false));
    mainWindow.on("closed", () => {
        mainWindow = null;
    });

    await mainWindow.loadFile(path.join(VIEWS_DIR, "protected-mode.html"));
}

function registerIpc() {
    ipcMain.on("navigation:load-url", (_event, input) => {
        if (integrity.isProtectedMode()) {
            return;
        }

        loadInActiveTab(input);
    });

    ipcMain.handle("navigation:get-active-page", () => getActivePagePayload());

    ipcMain.on("tabs:new", () => {
        if (integrity.isProtectedMode()) {
            return;
        }

        createTab();
    });

    ipcMain.on("tabs:switch", (_event, id) => {
        if (integrity.isProtectedMode()) {
            return;
        }

        switchTab(id);
    });

    ipcMain.on("tabs:close", (_event, id) => {
        if (integrity.isProtectedMode()) {
            return;
        }

        closeTab(id);
    });

    ipcMain.handle("tabs:get", () => getTabsPayload());

    ipcMain.on("ui:set-drawer-width", (_event, width) => {
        const numericWidth = Number(width) || 0;
        drawerWidth = Math.max(0, Math.min(MAX_DRAWER_WIDTH, numericWidth));
        updateBrowserBounds();
    });

    ipcMain.handle("settings:get", () => loadConfig());

    ipcMain.handle("settings:set", (_event, config) => {
        rejectIfProtected();

        const nextConfig = {
            ...loadConfig(),
            ...(config && typeof config === "object" ? config : {})
        };

        saveConfig(nextConfig);
        return nextConfig;
    });

    ipcMain.handle("privacy:clear-cache", async () => {
        rejectIfProtected();

        await session.fromPartition(PARTITION).clearCache();
        return true;
    });

    ipcMain.handle("privacy:clear-cookies", async () => {
        rejectIfProtected();

        await session.fromPartition(PARTITION).clearStorageData({
            storages: ["cookies"]
        });
        return true;
    });

    ipcMain.handle("history:get", () => loadHistory());

    ipcMain.handle("bookmarks:get", () => loadBookmarks());

    ipcMain.handle("bookmarks:add", (_event, bookmark) => {
        rejectIfProtected();

        const normalized = normalizeBookmark(bookmark);

        if (!normalized) {
            return null;
        }

        const existing = loadBookmarks().filter((entry) => entry && entry.url !== normalized.url);
        const next = [normalized, ...existing].slice(0, 200);
        saveBookmarks(next);
        return normalized;
    });

    ipcMain.handle("bookmarks:remove", (_event, url) => {
        rejectIfProtected();

        const next = loadBookmarks().filter((entry) => entry && entry.url !== url);
        saveBookmarks(next);
        return next;
    });

    ipcMain.handle("downloads:get", () => loadDownloads());

    ipcMain.handle("updates:check", async () => {
        rejectIfProtected();

        return updater.startUpdater(getUpdaterOptions({
            manual: true
        }));
    });

    ipcMain.handle("updates:get-state", () => updater.getUpdateState());

    ipcMain.on("updates:install-downloaded", () => {
        if (integrity.isProtectedMode()) {
            return;
        }

        updater.installDownloadedUpdate();
    });

    ipcMain.handle("integrity:get-state", () => protectedModePayload());

    ipcMain.handle("integrity:repair", async () => {
        integrity.quarantineManagedRuntime();
        return recovery.beginRepairInstall();
    });

    ipcMain.handle("integrity:download-repair", async () => {
        integrity.quarantineManagedRuntime();
        return recovery.downloadOfficialInstaller();
    });

    ipcMain.handle("integrity:open-profile", async () => {
        const result = await shell.openPath(app.getPath("userData"));

        if (result) {
            throw new Error(result);
        }

        return true;
    });

    ipcMain.on("window:minimize", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.minimize();
        }
    });

    ipcMain.on("window:maximize", () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
            return;
        }

        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    });

    ipcMain.on("window:close", () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.close();
        }
    });
}

async function start() {
    scheduleTestShutdown();
    ensureProfile();
    migrateLegacyProfile();
    configureSecurity();
    attachDownloadsListener();
    relayUpdaterState();
    registerIpc();

    integrityStatus = await integrity.verifyStartupIntegrity();

    if (integrity.isProtectedMode()) {
        await createProtectedWindow();
        return;
    }

    await createWindow();

    if (loadConfig().autoUpdate) {
        updater.startUpdater(getUpdaterOptions()).catch((error) => {
            console.warn("[Updater] Startup update check failed:", error.message);
        });
    }
}

app.whenReady().then(start).catch((error) => {
    console.error("[Main] Startup failed:", error);
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        const factory = integrity.isProtectedMode()
            ? createProtectedWindow
            : createWindow;

        factory().catch((error) => {
            console.error("[Main] Failed to recreate window:", error);
        });
    }
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});
