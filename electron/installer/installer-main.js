const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const AdmZip = require("adm-zip");

const INSTALL_ROOT = "C:\\Program Files\\BlackShieldX";
const USER_DATA_DIR = path.join(app.getPath("appData"), "BlackShieldX");
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");

app.setAppUserModelId("com.blackshieldx.installer");

let installerWindow = null;

function ensureInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    const relative = path.relative(parentPath, childPath);

    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return childPath;
    }

    throw new Error(`Unsafe installer path: ${child}`);
}

function validateInstallPath(installPath) {
    const resolved = path.resolve(installPath || INSTALL_ROOT);
    const driveRoot = path.parse(resolved).root;

    if (resolved === driveRoot || resolved.length < 8) {
        throw new Error("Install path is too broad.");
    }

    if (!/blackshieldx$/i.test(resolved.replace(/\\/g, "/"))) {
        throw new Error("Install path must end in BlackShieldX.");
    }

    if (path.resolve(USER_DATA_DIR).toLowerCase().startsWith(resolved.toLowerCase())) {
        throw new Error("Install path cannot contain the user profile directory.");
    }

    return resolved;
}

function runtimeSource() {
    const configured = process.env.BLACKSHIELD_RUNTIME_PATH || process.env.BLACKSHIELD_RUNTIME_ZIP || "";

    if (configured) {
        return path.resolve(configured);
    }

    const base = app.isPackaged
        ? process.resourcesPath
        : __dirname;

    const runtimeDir = path.join(base, "runtime");
    const runtimeZip = path.join(runtimeDir, "blackshield-runtime.zip");

    return fs.existsSync(runtimeDir) && fs.statSync(runtimeDir).isDirectory() && !fs.existsSync(runtimeZip)
        ? runtimeDir
        : runtimeZip;
}

function validateZipEntry(entry, destinationDir) {
    const entryName = String(entry.entryName || "").replace(/\\/g, "/");

    if (!entryName || entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName) || entryName.split("/").includes("..")) {
        throw new Error(`Unsafe runtime ZIP entry: ${entry.entryName}`);
    }

    return ensureInside(destinationDir, path.join(destinationDir, entryName));
}

function extractRuntime(zipPath, installPath, sendProgress) {
    if (!fs.existsSync(zipPath)) {
        throw new Error(`Official runtime package not found: ${zipPath}`);
    }

    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();

    entries.forEach((entry, index) => {
        const target = validateZipEntry(entry, installPath);

        if (entry.isDirectory) {
            fs.mkdirSync(target, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, entry.getData());
        }

        sendProgress(Math.round(((index + 1) / entries.length) * 100));
    });
}

function walkFiles(directory) {
    const results = [];

    fs.readdirSync(directory, {
        withFileTypes: true
    }).forEach((entry) => {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            results.push(...walkFiles(fullPath));
            return;
        }

        if (entry.isFile()) {
            results.push(fullPath);
        }
    });

    return results;
}

function copyRuntimeDirectory(sourceDir, installPath, sendProgress) {
    if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
        throw new Error(`Official runtime directory not found: ${sourceDir}`);
    }

    const files = walkFiles(sourceDir);

    files.forEach((filePath, index) => {
        const relative = path.relative(sourceDir, filePath).replace(/\\/g, "/");
        const target = ensureInside(installPath, path.join(installPath, relative));

        fs.mkdirSync(path.dirname(target), {
            recursive: true
        });
        fs.copyFileSync(filePath, target);

        sendProgress(Math.round(((index + 1) / files.length) * 100));
    });
}

function installRuntimePayload(sourcePath, installPath, sendProgress) {
    if (!fs.existsSync(sourcePath)) {
        throw new Error(
            `Official runtime package not found. Run npm run app:dist first. Missing: ${sourcePath}`
        );
    }

    if (fs.statSync(sourcePath).isDirectory()) {
        copyRuntimeDirectory(sourcePath, installPath, sendProgress);
        return;
    }

    extractRuntime(sourcePath, installPath, sendProgress);
}

function backupExistingRuntime(installPath) {
    if (!fs.existsSync(installPath)) {
        return "";
    }

    const marker = path.join(installPath, "resources");
    const hasRuntimeShape = fs.existsSync(marker) || fs.existsSync(path.join(installPath, "BlackShield X.exe"));

    if (!hasRuntimeShape) {
        throw new Error("Existing folder does not look like a BlackShield X runtime.");
    }

    const backupPath = `${installPath}.quarantine.${Date.now()}`;
    fs.renameSync(installPath, backupPath);
    return backupPath;
}

function inspectRuntime(installPath) {
    const target = validateInstallPath(installPath || INSTALL_ROOT);
    const exists = fs.existsSync(target);
    const executable = path.join(target, "BlackShield X.exe");
    const sourcePath = runtimeSource();

    return {
        installPath: target,
        userDataPath: USER_DATA_DIR,
        exists,
        executableExists: fs.existsSync(executable),
        mode: exists ? "repair" : "install",
        runtimePackagePath: sourcePath,
        runtimePackageReady: fs.existsSync(sourcePath),
        preservesUserData: true
    };
}

async function installRuntime(event, options = {}) {
    const installPath = validateInstallPath(options.installPath || INSTALL_ROOT);
    const sourcePath = runtimeSource();
    const mode = options.mode || "install";
    let lastProgress = -1;

    const sendProgress = (percent, message) => {
        const normalized = Math.max(0, Math.min(100, Math.round(percent)));

        if (normalized === lastProgress) {
            return;
        }

        lastProgress = normalized;
        event.sender.send("installer:progress", {
            percent: normalized,
            message
        });
    };

    sendProgress(4, "Preparing protected runtime location");

    const quarantinePath = mode === "repair" || mode === "reinstall"
        ? backupExistingRuntime(installPath)
        : "";

    fs.mkdirSync(installPath, { recursive: true });

    sendProgress(12, "Installing official BlackShield runtime");

    installRuntimePayload(sourcePath, installPath, (percent) => {
        sendProgress(12 + Math.round(percent * 0.78), "Restoring clean runtime files");
    });

    fs.mkdirSync(USER_DATA_DIR, {
        recursive: true
    });

    sendProgress(96, "Reconnecting preserved user profile");

    fs.writeFileSync(path.join(installPath, ".blackshield-runtime"), "official runtime\n");

    return {
        status: "complete",
        installPath,
        userDataPath: USER_DATA_DIR,
        quarantinePath,
        preservesUserData: true
    };
}

function createWindow() {
    installerWindow = new BrowserWindow({
        width: 980,
        height: 720,
        minWidth: 900,
        minHeight: 640,
        frame: false,
        backgroundColor: "#050505",
        ...(fs.existsSync(ICON_PATH) ? { icon: ICON_PATH } : {}),
        webPreferences: {
            preload: path.join(__dirname, "installer-preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });

    installerWindow.loadFile(path.join(__dirname, "index.html"));

    const testQuitAfterMs = Number(process.env.BLACKSHIELD_INSTALLER_TEST_QUIT_AFTER_MS || 0);

    if (testQuitAfterMs > 0) {
        setTimeout(() => app.quit(), testQuitAfterMs);
    }
}

ipcMain.handle("installer:inspect", (_event, installPath) => inspectRuntime(installPath));

ipcMain.handle("installer:choose-path", async () => {
    const result = await dialog.showOpenDialog(installerWindow, {
        title: "Choose BlackShield X install folder",
        defaultPath: INSTALL_ROOT,
        properties: ["openDirectory", "createDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
        return "";
    }

    return validateInstallPath(result.filePaths[0]);
});

ipcMain.handle("installer:install", installRuntime);

ipcMain.on("installer:close", () => {
    app.quit();
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
    app.quit();
});
