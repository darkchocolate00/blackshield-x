/* =========================================
   ELEMENTS
========================================= */

const urlBar =
    document.getElementById(
        "urlBar"
    );

const settingsPanel =
    document.getElementById(
        "settingsPanel"
    );

const tabsContainer =
    document.getElementById(
        "tabsContainer"
    );

/* =========================================
   NAVIGATION
========================================= */

function navigate() {

    const value =
        urlBar.value.trim();

    if (!value) {
        return;
    }

    api.loadURL(value);
}

/* ENTER KEY */

urlBar.addEventListener(

    "keydown",

    (event) => {

        if (
            event.key === "Enter"
        ) {

            navigate();
        }
    }
);

/* =========================================
   SETTINGS PANEL
========================================= */

function toggleSettings() {

    settingsPanel.classList.toggle(
        "open"
    );
}

/* =========================================
   LOAD SETTINGS
========================================= */

async function loadSettings() {

    const cfg =
        await api.getConfig();

    document.getElementById(
        "searchEngine"
    ).value =
        cfg.searchEngine;

    document.getElementById(
        "performance"
    ).value =
        cfg.performance;

    document.getElementById(
        "autoUpdate"
    ).checked =
        cfg.autoUpdate;

    document.getElementById(
        "saveHistory"
    ).checked =
        cfg.saveHistory;
}

/* =========================================
   SAVE SETTINGS
========================================= */

function saveSettings() {

    const cfg = {

        searchEngine:

        document.getElementById(
            "searchEngine"
        ).value,

        performance:

        document.getElementById(
            "performance"
        ).value,

        autoUpdate:

        document.getElementById(
            "autoUpdate"
        ).checked,

        saveHistory:

        document.getElementById(
            "saveHistory"
        ).checked
    };

    api.setConfig(cfg);
}

/* =========================================
   SETTINGS EVENTS
========================================= */

[
    "searchEngine",
    "performance",
    "autoUpdate",
    "saveHistory"
]

    .forEach((id) => {

        const element =
            document.getElementById(id);

        if (!element) {
            return;
        }

        element.addEventListener(
            "change",
            saveSettings
        );
    });

/* =========================================
   CLEAR CACHE
========================================= */

async function clearCache() {

    await api.clearCache();

    alert(
        "Browser cache cleared"
    );
}

/* =========================================
   CLEAR COOKIES
========================================= */

async function clearCookies() {

    await api.clearCookies();

    alert(
        "Cookies cleared"
    );
}

/* =========================================
   BOOKMARKS
========================================= */

async function addBookmark() {

    const currentURL =
        urlBar.value.trim();

    if (!currentURL) {
        return;
    }

    api.addBookmark({

        url: currentURL,

        time:
            Date.now()
    });

    alert(
        "Bookmark added"
    );
}

/* =========================================
   HISTORY PAGE
========================================= */

function openHistory() {

    api.loadURL(

        "file://" +

        location.pathname.replace(
            "index.html",
            "history.html"
        )
    );
}

/* =========================================
   BOOKMARKS PAGE
========================================= */

function openBookmarks() {

    api.loadURL(

        "file://" +

        location.pathname.replace(
            "index.html",
            "bookmarks.html"
        )
    );
}

/* =========================================
   CREATE TAB
========================================= */

function createNewTab() {

    api.newTab();
}

/* =========================================
   RENDER TABS
========================================= */

function renderTabs(data) {

    tabsContainer.innerHTML = "";

    data.tabs.forEach((tab) => {

        const tabEl =
            document.createElement(
                "div"
            );

        tabEl.className = "tab";

        /* ACTIVE */

        if (
            tab.id ===
            data.activeTabId
        ) {

            tabEl.classList.add(
                "activeTab"
            );
        }

        /* TITLE */

        const title =
            document.createElement(
                "div"
            );

        title.className =
            "tabTitle";

        title.innerText =
            tab.title;

        title.onclick = () => {

            api.switchTab(tab.id);
        };

        /* CLOSE */

        const close =
            document.createElement(
                "button"
            );

        close.className =
            "closeTabBtn";

        close.innerText = "✕";

        close.onclick = (event) => {

            event.stopPropagation();

            api.closeTab(tab.id);
        };

        /* APPEND */

        tabEl.appendChild(title);

        tabEl.appendChild(close);

        tabsContainer.appendChild(
            tabEl
        );
    });
}

/* =========================================
   TAB EVENTS
========================================= */

api.onTabsUpdated((data) => {

    renderTabs(data);
});

/* =========================================
   START
========================================= */

loadSettings();