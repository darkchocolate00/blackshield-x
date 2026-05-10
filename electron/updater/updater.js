const fs = require("fs");
const path = require("path");
const https = require("https");
const AdmZip = require("adm-zip");

const {
    autoUpdater
} = require("electron-updater");

/* =========================================
   PATHS
========================================= */

const ROOT_DIR = path.join(
    __dirname,
    ".."
);

const PROFILE_DIR = path.join(
    ROOT_DIR,
    "profile"
);

const UPDATES_DIR = path.join(
    ROOT_DIR,
    "updates"
);

const TEMP_DIR = path.join(
    UPDATES_DIR,
    "temp"
);

const MODULES_DIR = path.join(
    ROOT_DIR,
    "modules"
);

const VERSION_FILE = path.join(
    PROFILE_DIR,
    "module_versions.json"
);

/* =========================================
   ENSURE DIRECTORIES
========================================= */

[
    PROFILE_DIR,
    UPDATES_DIR,
    TEMP_DIR,
    MODULES_DIR
]

    .forEach((dir) => {

        if (!fs.existsSync(dir)) {

            fs.mkdirSync(dir, {
                recursive: true
            });
        }
    });

/* =========================================
   LOCAL MODULE VERSIONS
========================================= */

function loadLocalVersions() {

    try {

        return JSON.parse(

            fs.readFileSync(
                VERSION_FILE,
                "utf8"
            )
        );

    } catch {

        const defaults = {

            browser_core:
                "1.0.0"
        };

        fs.writeFileSync(

            VERSION_FILE,

            JSON.stringify(
                defaults,
                null,
                2
            )
        );

        return defaults;
    }
}

function saveLocalVersions(data) {

    fs.writeFileSync(

        VERSION_FILE,

        JSON.stringify(
            data,
            null,
            2
        )
    );
}

/* =========================================
   FETCH MANIFEST
========================================= */

function fetchManifest(url) {

    return new Promise((resolve, reject) => {

        https.get(url, (response) => {

            let data = "";

            response.on(
                "data",
                chunk => {

                    data += chunk;
                }
            );

            response.on(
                "end",
                () => {

                    try {

                        const json =
                            JSON.parse(data);

                        resolve(json);

                    } catch (err) {

                        reject(err);
                    }
                }
            );

        }).on(
            "error",
            reject
        );
    });
}

/* =========================================
   CHECK MODULE UPDATES
========================================= */

function compareModules(

    remoteManifest,
    localVersions

) {

    const updates = [];

    const remoteModules =
        remoteManifest.modules || {};

    for (

        const moduleName
        in remoteModules

        ) {

        const remote =
            remoteModules[moduleName];

        const remoteVersion =
            remote.version;

        const localVersion =
            localVersions[moduleName];

        if (

            remoteVersion !==
            localVersion

        ) {

            updates.push({

                name:
                moduleName,

                version:
                remoteVersion,

                url:
                remote.url
            });
        }
    }

    return updates;
}

/* =========================================
   DOWNLOAD FILE
========================================= */

function downloadFile(

    url,
    outputPath

) {

    return new Promise((resolve, reject) => {

        const file =
            fs.createWriteStream(
                outputPath
            );

        https.get(url, (response) => {

            response.pipe(file);

            file.on(
                "finish",
                () => {

                    file.close();

                    resolve();
                }
            );

        }).on(
            "error",
            (err) => {

                fs.unlink(
                    outputPath,
                    () => {}
                );

                reject(err);
            }
        );
    });
}

/* =========================================
   APPLY MODULE UPDATE
========================================= */

async function applyModuleUpdate(

    moduleInfo

) {

    const fileName =

        `${moduleInfo.name}.zip`;

    const tempPath = path.join(
        TEMP_DIR,
        fileName
    );

    console.log(

        "[Updater] Downloading:",

        moduleInfo.name
    );

    await downloadFile(

        moduleInfo.url,
        tempPath
    );

    console.log(

        "[Updater] Download Complete:",

        moduleInfo.name
    );

    const modulePath = path.join(
        MODULES_DIR,
        moduleInfo.name
    );

    if (fs.existsSync(modulePath)) {

        fs.rmSync(modulePath, {

            recursive: true,
            force: true
        });
    }

    fs.mkdirSync(modulePath, {
        recursive: true
    });

    const zip = new AdmZip(tempPath);

    zip.extractAllTo(
        modulePath,
        true
    );

    const versions =
        loadLocalVersions();

    versions[moduleInfo.name] =
        moduleInfo.version;

    saveLocalVersions(
        versions
    );

    console.log(

        "[Updater] Installed:",

        moduleInfo.name
    );
}

/* =========================================
   MODULE UPDATE ENGINE
========================================= */

async function checkModuleUpdates() {

    try {

        console.log(
            "[Updater] Checking modules..."
        );

        /*
          CHANGE THIS LATER
          TO YOUR REAL SERVER
        */

        const MANIFEST_URL =
            "https://raw.githubusercontent.com/darkchocolate00/blackshield-x/main/electron/manifest.json";

        const remoteManifest =
            await fetchManifest(
                MANIFEST_URL
            );

        const localVersions =
            loadLocalVersions();

        const updates =
            compareModules(

                remoteManifest,
                localVersions
            );

        if (updates.length === 0) {

            console.log(
                "[Updater] No module updates"
            );

            return;
        }

        console.log(

            "[Updater] Updates Found:",

            updates
        );

        for (const update of updates) {

            await applyModuleUpdate(
                update
            );
        }

        console.log(
            "[Updater] All modules updated"
        );

    } catch (err) {

        console.error(

            "[Updater Error]",

            err
        );
    }
}

/* =========================================
   ELECTRON AUTO UPDATER
========================================= */

function initializeElectronUpdater() {

    autoUpdater.autoDownload =
        true;

    autoUpdater.autoInstallOnAppQuit =
        true;

    autoUpdater.on(

        "checking-for-update",

        () => {

            console.log(
                "[Electron Updater] Checking..."
            );
        }
    );

    autoUpdater.on(

        "update-available",

        (info) => {

            console.log(

                "[Electron Updater] Available:",

                info.version
            );
        }
    );

    autoUpdater.on(

        "update-not-available",

        () => {

            console.log(
                "[Electron Updater] No updates"
            );
        }
    );

    autoUpdater.on(

        "download-progress",

        (progress) => {

            console.log(

                "[Electron Updater] Download:",

                progress.percent
            );
        }
    );

    autoUpdater.on(

        "update-downloaded",

        () => {

            console.log(
                "[Electron Updater] Ready to install"
            );
        }
    );

    autoUpdater.on(

        "error",

        (err) => {

            console.error(

                "[Electron Updater Error]",

                err
            );
        }
    );

    autoUpdater.checkForUpdatesAndNotify();
}

/* =========================================
   START UPDATE SYSTEM
========================================= */

async function startUpdater() {

    console.log(
        "[Updater] Starting..."
    );

    initializeElectronUpdater();

    await checkModuleUpdates();
}

/* =========================================
   EXPORTS
========================================= */

module.exports = {

    startUpdater
};