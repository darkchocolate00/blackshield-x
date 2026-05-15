(() => {
    "use strict";

    /*
     * Renderer architecture:
     * - This file owns all DOM behavior for the app's internal views.
     * - It never imports Electron and never reaches into main-process objects.
     * - Main-process work flows through window.blackshield, which preload creates.
     */

    const bridge = window.blackshield;
    const DRAWER_WIDTH = 400;

    let activePage = {
        url: "",
        title: "New Tab",
        isInternal: true
    };

    let activeDrawer = null;
    let shellElements = null;

    document.addEventListener("DOMContentLoaded", () => {
        const view = document.body.dataset.view || "shell";

        if (!bridge) {
            return;
        }

        if (view === "newtab") {
            initNewTab();
            return;
        }

        if (view === "downloads") {
            runTask(initDownloads);
            return;
        }

        if (view === "protected") {
            runTask(initProtectedMode);
            return;
        }

        runTask(initShell);
    });

    function $(id) {
        return document.getElementById(id);
    }

    function createElement(tagName, className, text) {
        const element = document.createElement(tagName);

        if (className) {
            element.className = className;
        }

        if (text !== undefined) {
            element.textContent = text;
        }

        return element;
    }

    function isHttpUrl(url) {
        return /^https?:\/\//i.test(String(url || ""));
    }

    function isInternalNewTab(url) {
        return String(url || "").replace(/\\/g, "/").endsWith("/views/newtab.html");
    }

    function displayUrl(url) {
        if (!url || isInternalNewTab(url)) {
            return "";
        }

        return url;
    }

    function formatTime(timestamp) {
        if (!timestamp) {
            return "";
        }

        return new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "short"
        }).format(new Date(timestamp));
    }

    function formatBytes(bytes) {
        const size = Number(bytes) || 0;

        if (size <= 0) {
            return "Unknown size";
        }

        const units = ["B", "KB", "MB", "GB"];
        let value = size;
        let unitIndex = 0;

        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }

        return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
    }

    async function runTask(task) {
        try {
            await task();
        } catch (error) {
            reportError(error);
        }
    }

    function reportError(error) {
        const message = error && error.message
            ? error.message
            : "Action failed";

        if (shellElements && shellElements.settingsStatus) {
            setStatus(message);
            return;
        }

        const existing = $("viewError");

        if (existing) {
            existing.textContent = message;
            return;
        }

        const errorBox = createElement("div", "viewError", message);
        errorBox.id = "viewError";
        document.body.appendChild(errorBox);
    }

    async function initShell() {
        shellElements = {
            tabsContainer: $("tabsContainer"),
            newTabBtn: $("newTabBtn"),
            urlBar: $("urlBar"),
            goBtn: $("goBtn"),
            historyBtn: $("historyBtn"),
            bookmarksBtn: $("bookmarksBtn"),
            bookmarkCurrentBtn: $("bookmarkCurrentBtn"),
            settingsBtn: $("settingsBtn"),
            settingsPanel: $("settingsPanel"),
            historyPanel: $("historyPanel"),
            bookmarksPanel: $("bookmarksPanel"),
            historyList: $("historyList"),
            bookmarksList: $("bookmarksList"),
            historyEmpty: $("historyEmpty"),
            bookmarksEmpty: $("bookmarksEmpty"),
            searchEngine: $("searchEngine"),
            performance: $("performance"),
            autoUpdate: $("autoUpdate"),
            saveHistory: $("saveHistory"),
            clearCacheBtn: $("clearCacheBtn"),
            clearCookiesBtn: $("clearCookiesBtn"),
            checkUpdatesBtn: $("checkUpdatesBtn"),
            settingsStatus: $("settingsStatus"),
            historyCloseBtn: $("historyCloseBtn"),
            bookmarksCloseBtn: $("bookmarksCloseBtn"),
            settingsCloseBtn: $("settingsCloseBtn"),
            winMinBtn: $("winMinBtn"),
            winMaxBtn: $("winMaxBtn"),
            winCloseBtn: $("winCloseBtn")
        };

        bindShellEvents();
        await loadSettings();
        await refreshShellState();

        bridge.tabs.onUpdated(renderTabs);
        bridge.navigation.onActivePageUpdated((page) => {
            activePage = {
                ...activePage,
                ...page
            };
            syncUrlBar();
        });

        if (bridge.updates && bridge.updates.onState) {
            bridge.updates.onState(handleUpdateState);
        }
    }

    function bindShellEvents() {
        shellElements.newTabBtn.addEventListener("click", () => {
            bridge.tabs.newTab();
            closeDrawer();
        });

        shellElements.goBtn.addEventListener("click", navigateFromUrlBar);

        shellElements.urlBar.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                navigateFromUrlBar();
            }
        });

        shellElements.settingsBtn.addEventListener("click", () => {
            toggleDrawer("settings");
        });

        shellElements.historyBtn.addEventListener("click", () => {
            runTask(openHistoryDrawer);
        });

        shellElements.bookmarksBtn.addEventListener("click", () => {
            runTask(openBookmarksDrawer);
        });

        shellElements.bookmarkCurrentBtn.addEventListener("click", () => runTask(addCurrentBookmark));
        shellElements.clearCacheBtn.addEventListener("click", () => runTask(clearCache));
        shellElements.clearCookiesBtn.addEventListener("click", () => runTask(clearCookies));
        shellElements.checkUpdatesBtn.addEventListener("click", () => runTask(checkUpdates));

        shellElements.settingsCloseBtn.addEventListener("click", closeDrawer);
        shellElements.historyCloseBtn.addEventListener("click", closeDrawer);
        shellElements.bookmarksCloseBtn.addEventListener("click", closeDrawer);

        shellElements.winMinBtn.addEventListener("click", bridge.windowControls.minimize);
        shellElements.winMaxBtn.addEventListener("click", bridge.windowControls.maximize);
        shellElements.winCloseBtn.addEventListener("click", bridge.windowControls.close);

        [
            shellElements.searchEngine,
            shellElements.performance,
            shellElements.autoUpdate,
            shellElements.saveHistory
        ].forEach((element) => {
            element.addEventListener("change", () => runTask(saveSettings));
        });

        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                closeDrawer();
            }
        });
    }

    async function refreshShellState() {
        const [tabsState, page] = await Promise.all([
            bridge.tabs.getTabs(),
            bridge.navigation.getActivePage()
        ]);

        activePage = {
            ...activePage,
            ...page
        };

        renderTabs(tabsState);
        syncUrlBar();
    }

    function syncUrlBar() {
        if (!shellElements || document.activeElement === shellElements.urlBar) {
            return;
        }

        shellElements.urlBar.value = displayUrl(activePage.url);
    }

    function navigateFromUrlBar() {
        const value = shellElements.urlBar.value.trim();

        if (!value) {
            return;
        }

        bridge.navigation.loadURL(value);
        shellElements.urlBar.blur();
        closeDrawer();
    }

    function renderTabs(data) {
        if (!shellElements || !shellElements.tabsContainer || !data) {
            return;
        }

        shellElements.tabsContainer.replaceChildren();

        data.tabs.forEach((tab) => {
            const tabElement = createElement("div", "tab");

            if (tab.id === data.activeTabId) {
                tabElement.classList.add("activeTab");
            }

            const title = createElement("button", "tabTitle", tab.title || "New Tab");
            title.type = "button";
            title.title = tab.title || "New Tab";
            title.addEventListener("click", () => {
                bridge.tabs.switchTab(tab.id);
            });

            const close = createElement("button", "closeTabBtn", "x");
            close.type = "button";
            close.title = "Close tab";
            close.addEventListener("click", (event) => {
                event.stopPropagation();
                bridge.tabs.closeTab(tab.id);
            });

            tabElement.append(title, close);
            shellElements.tabsContainer.appendChild(tabElement);
        });
    }

    async function loadSettings() {
        const config = await bridge.settings.get();

        shellElements.searchEngine.value = config.searchEngine || "duckduckgo";
        shellElements.performance.value = config.performance || "balanced";
        shellElements.autoUpdate.checked = Boolean(config.autoUpdate);
        shellElements.saveHistory.checked = Boolean(config.saveHistory);
    }

    async function saveSettings() {
        const config = {
            searchEngine: shellElements.searchEngine.value,
            performance: shellElements.performance.value,
            autoUpdate: shellElements.autoUpdate.checked,
            saveHistory: shellElements.saveHistory.checked
        };

        await bridge.settings.set(config);
        setStatus("Settings saved");
    }

    async function clearCache() {
        await bridge.settings.clearCache();
        setStatus("Cache cleared");
    }

    async function clearCookies() {
        await bridge.settings.clearCookies();
        setStatus("Cookies cleared");
    }

    async function checkUpdates() {
        setStatus("Checking for updates...");

        const result = bridge.updates
            ? await bridge.updates.check()
            : await bridge.settings.checkUpdates();

        if (result && result.status === "error") {
            setStatus("Update check finished with errors");
            return;
        }

        setStatus("Update check finished");
    }

    function handleUpdateState(state) {
        if (!state || !shellElements || activeDrawer !== "settings") {
            return;
        }

        if (state.phase === "downloading-app" && state.app && state.app.progress) {
            setStatus(`Downloading update ${Math.round(state.app.progress.percent || 0)}%`);
            return;
        }

        if (state.message) {
            setStatus(state.message);
        }
    }

    function setStatus(message) {
        shellElements.settingsStatus.textContent = message;

        window.clearTimeout(setStatus.timeout);
        setStatus.timeout = window.setTimeout(() => {
            shellElements.settingsStatus.textContent = "";
        }, 3500);
    }

    function toggleDrawer(name) {
        if (activeDrawer === name) {
            closeDrawer();
            return;
        }

        openDrawer(name);
    }

    function openDrawer(name) {
        activeDrawer = name;

        [
            ["settings", shellElements.settingsPanel],
            ["history", shellElements.historyPanel],
            ["bookmarks", shellElements.bookmarksPanel]
        ].forEach(([panelName, panel]) => {
            const isOpen = panelName === name;
            panel.classList.toggle("active", isOpen);
            panel.setAttribute("aria-hidden", String(!isOpen));
        });

        bridge.ui.setDrawerWidth(DRAWER_WIDTH);
    }

    function closeDrawer() {
        activeDrawer = null;

        [
            shellElements.settingsPanel,
            shellElements.historyPanel,
            shellElements.bookmarksPanel
        ].forEach((panel) => {
            panel.classList.remove("active");
            panel.setAttribute("aria-hidden", "true");
        });

        bridge.ui.setDrawerWidth(0);
    }

    async function openHistoryDrawer() {
        openDrawer("history");
        await refreshHistory();
    }

    async function openBookmarksDrawer() {
        openDrawer("bookmarks");
        await refreshBookmarks();
    }

    async function refreshHistory() {
        const history = (await bridge.history.get())
            .filter((entry) => entry && isHttpUrl(entry.url));

        renderLinkList({
            container: shellElements.historyList,
            empty: shellElements.historyEmpty,
            entries: history,
            showRemove: false
        });
    }

    async function refreshBookmarks() {
        const bookmarks = (await bridge.bookmarks.get())
            .filter((entry) => entry && isHttpUrl(entry.url));

        renderLinkList({
            container: shellElements.bookmarksList,
            empty: shellElements.bookmarksEmpty,
            entries: bookmarks,
            showRemove: true
        });
    }

    function renderLinkList({ container, empty, entries, showRemove }) {
        container.replaceChildren();
        empty.hidden = entries.length > 0;

        entries.forEach((entry) => {
            const row = createElement("div", "dataRow");
            const main = createElement("button", "dataRowMain");
            main.type = "button";
            main.addEventListener("click", () => {
                bridge.navigation.loadURL(entry.url);
                closeDrawer();
            });

            const title = createElement("span", "dataRowTitle", entry.title || entry.url);
            const url = createElement("span", "dataRowUrl", entry.url);
            const time = createElement("span", "dataRowMeta", formatTime(entry.time));

            main.append(title, url, time);
            row.appendChild(main);

            if (showRemove) {
                const remove = createElement("button", "dataRowAction", "Remove");
                remove.type = "button";
                remove.addEventListener("click", async () => {
                    await bridge.bookmarks.remove(entry.url);
                    await refreshBookmarks();
                });
                row.appendChild(remove);
            }

            container.appendChild(row);
        });
    }

    async function addCurrentBookmark() {
        const url = isHttpUrl(activePage.url)
            ? activePage.url
            : shellElements.urlBar.value.trim();

        if (!isHttpUrl(url)) {
            setStatus("Open a website before adding a bookmark");
            return;
        }

        await bridge.bookmarks.add({
            url,
            title: activePage.title || url,
            time: Date.now()
        });

        setStatus("Bookmark added");

        if (activeDrawer === "bookmarks") {
            await refreshBookmarks();
        }
    }

    function initNewTab() {
        const input = $("searchInput");
        const searchButton = $("searchBtn");

        const submit = () => {
            const value = input.value.trim();

            if (value) {
                bridge.navigation.loadURL(value);
            }
        };

        searchButton.addEventListener("click", submit);
        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                submit();
            }
        });

        document.querySelectorAll("[data-shortcut-url]").forEach((shortcut) => {
            shortcut.addEventListener("click", () => {
                bridge.navigation.loadURL(shortcut.dataset.shortcutUrl);
            });
        });
    }

    async function initDownloads() {
        const container = $("downloadsList");
        const empty = $("downloadsEmpty");
        const downloads = await bridge.downloads.get();

        container.replaceChildren();
        empty.hidden = downloads.length > 0;

        downloads.forEach((download) => {
            const row = createElement("div", "download");
            const name = createElement("div", "name", download.name || "Downloaded file");
            const path = createElement("div", "meta", download.path || download.url || "");
            const details = createElement(
                "div",
                "meta",
                `${formatBytes(download.size)} - ${download.state || "recorded"} - ${formatTime(download.time)}`
            );

            row.append(name, path, details);
            container.appendChild(row);
        });
    }

    async function initProtectedMode() {
        const buildSignature = $("buildSignature");
        const integrityId = $("integrityId");
        const integrityReason = $("integrityReason");
        const integrityDetails = $("integrityDetails");
        const repairStatus = $("repairStatus");
        const repairInstallBtn = $("repairInstallBtn");
        const downloadRepairBtn = $("downloadRepairBtn");
        const openProfileBtn = $("openProfileBtn");
        const winMinBtn = $("winMinBtn");
        const winCloseBtn = $("winCloseBtn");

        const renderState = (state) => {
            buildSignature.textContent = state.buildSignature || "unverified";
            integrityId.textContent = state.integrityId || "protected-mode";
            integrityReason.textContent = state.reason || "Runtime verification failed.";
            integrityDetails.replaceChildren();

            const details = Array.isArray(state.details) && state.details.length > 0
                ? state.details
                : [{ reason: "Protected services are disabled until repair completes." }];

            details.slice(0, 6).forEach((detail) => {
                const row = createElement(
                    "div",
                    "detailRow",
                    `${detail.path || detail.source || "runtime"} - ${detail.reason || "verification failed"}`
                );
                integrityDetails.appendChild(row);
            });
        };

        const setRepairStatus = (message) => {
            repairStatus.textContent = message;
        };

        renderState(await bridge.integrity.getState());
        bridge.integrity.onState(renderState);

        repairInstallBtn.addEventListener("click", () => runTask(async () => {
            setRepairStatus("Preparing official repair installer...");
            try {
                const result = await bridge.integrity.repair();
                const launchMethod = result && result.launchMethod
                    ? ` (${result.launchMethod})`
                    : "";
                setRepairStatus(`Repair installer opened${launchMethod}. Your profile data remains preserved.`);
            } catch (error) {
                setRepairStatus(error.message || "Repair installer could not be opened.");
                throw error;
            }
        }));

        downloadRepairBtn.addEventListener("click", () => runTask(async () => {
            setRepairStatus("Downloading official repair installer...");
            try {
                const result = await bridge.integrity.downloadRepair();
                setRepairStatus(`Repair installer downloaded: ${result.installerPath}`);
            } catch (error) {
                setRepairStatus(error.message || "Repair installer could not be downloaded.");
                throw error;
            }
        }));

        openProfileBtn.addEventListener("click", () => runTask(async () => {
            await bridge.integrity.openProfile();
            setRepairStatus("Preserved profile folder opened.");
        }));

        winMinBtn.addEventListener("click", bridge.windowControls.minimize);
        winCloseBtn.addEventListener("click", bridge.windowControls.close);
    }
})();
