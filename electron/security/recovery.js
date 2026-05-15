const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { URL } = require("url");
const { spawn } = require("child_process");
const { app, shell } = require("electron");
const log = require("electron-log");

/*
 * Recovery/Reinstall Pipeline:
 * - Downloads an official repair installer into userData/recovery.
 * - Validates sha256 when a .sha256 release asset or explicit hash is present.
 * - Never deletes AppData/Roaming/BlackShieldX profile data.
 * - Runtime removal is deferred to the installer while this app is still running.
 */

const GITHUB_API =
    "https://api.github.com/repos/darkchocolate00/blackshield-x/releases/latest";

function recoveryDir() {
    const dir = path.join(app.getPath("userData"), "recovery");
    fs.mkdirSync(dir, {
        recursive: true,
        mode: 0o700
    });
    return dir;
}

function ensureInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    const relative = path.relative(parentPath, childPath);

    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return childPath;
    }

    throw new Error(`Unsafe recovery path: ${child}`);
}

function requestJson(url) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const request = https.get(parsed, {
            headers: {
                "Accept": "application/vnd.github+json",
                "User-Agent": `BlackShieldX/${app.getVersion()}`
            },
            timeout: 30000
        }, (response) => {
            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                reject(new Error(`GitHub release request failed: HTTP ${response.statusCode}`));
                return;
            }

            let data = "";

            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                data += chunk;
            });
            response.on("end", () => {
                try {
                    resolve(JSON.parse(data));
                } catch (error) {
                    reject(error);
                }
            });
        });

        request.on("timeout", () => {
            request.destroy(new Error("GitHub release request timed out"));
        });
        request.on("error", reject);
    });
}

function download(url, outputPath) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const file = fs.createWriteStream(outputPath, {
            mode: 0o600
        });

        const request = https.get(parsed, {
            headers: {
                "User-Agent": `BlackShieldX/${app.getVersion()}`
            },
            timeout: 60000
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();
                file.close(() => {
                    fs.rmSync(outputPath, { force: true });
                    download(new URL(response.headers.location, parsed).toString(), outputPath).then(resolve, reject);
                });
                return;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                file.close(() => {
                    fs.rmSync(outputPath, { force: true });
                    reject(new Error(`Installer download failed: HTTP ${response.statusCode}`));
                });
                return;
            }

            response.pipe(file);
            file.on("finish", () => file.close(resolve));
        });

        request.on("timeout", () => {
            request.destroy(new Error("Installer download timed out"));
        });
        request.on("error", (error) => {
            file.close(() => {
                fs.rmSync(outputPath, { force: true });
                reject(error);
            });
        });
        file.on("error", reject);
    });
}

function sha256(filePath) {
    return crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
}

function chooseInstallerAsset(release) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const candidates = assets.filter((asset) => {
        return /\.exe$/i.test(asset.name || "") && /blackshield/i.test(asset.name || "");
    });
    const installer = candidates.find((asset) => /installer/i.test(asset.name || "")) ||
        candidates.find((asset) => /setup/i.test(asset.name || "")) ||
        candidates.find((asset) => /portable/i.test(asset.name || ""));

    if (!installer) {
        throw new Error("No official Windows installer asset found in latest GitHub release");
    }

    const hashAsset = assets.find((asset) => {
        return asset.name === `${installer.name}.sha256` || /\.sha256$/i.test(asset.name || "");
    });

    return {
        name: installer.name,
        url: installer.browser_download_url,
        sha256Url: hashAsset ? hashAsset.browser_download_url : "",
        version: release.tag_name || ""
    };
}

async function resolveOfficialInstaller() {
    if (process.env.BLACKSHIELD_REPAIR_INSTALLER_PATH) {
        const installerPath = path.resolve(process.env.BLACKSHIELD_REPAIR_INSTALLER_PATH);

        if (!fs.existsSync(installerPath)) {
            throw new Error(`Configured repair installer does not exist: ${installerPath}`);
        }

        return {
            name: path.basename(installerPath),
            localPath: installerPath,
            sha256: process.env.BLACKSHIELD_REPAIR_INSTALLER_SHA256 || "",
            version: "local"
        };
    }

    if (process.env.BLACKSHIELD_REPAIR_INSTALLER_URL) {
        return {
            name: path.basename(new URL(process.env.BLACKSHIELD_REPAIR_INSTALLER_URL).pathname) || "BlackShieldX-Repair.exe",
            url: process.env.BLACKSHIELD_REPAIR_INSTALLER_URL,
            sha256: process.env.BLACKSHIELD_REPAIR_INSTALLER_SHA256 || "",
            version: "manual"
        };
    }

    const release = await requestJson(GITHUB_API);
    const asset = chooseInstallerAsset(release);

    let hash = "";

    if (asset.sha256Url) {
        const hashPath = ensureInside(recoveryDir(), path.join(recoveryDir(), `${asset.name}.sha256`));
        await download(asset.sha256Url, hashPath);
        hash = fs.readFileSync(hashPath, "utf8").trim().split(/\s+/)[0] || "";
        fs.rmSync(hashPath, { force: true });
    }

    return {
        ...asset,
        sha256: hash
    };
}

async function downloadOfficialInstaller() {
    const dir = recoveryDir();
    const asset = await resolveOfficialInstaller();

    if (asset.localPath) {
        const actual = sha256(asset.localPath);

        if (asset.sha256 && actual.toLowerCase() !== asset.sha256.toLowerCase()) {
            throw new Error("Configured repair installer sha256 validation failed");
        }

        return {
            installerPath: asset.localPath,
            version: asset.version,
            sha256: asset.sha256 || actual,
            preservesUserData: true,
            userDataPath: app.getPath("userData")
        };
    }

    const outputPath = ensureInside(dir, path.join(dir, asset.name));

    log.info("[recovery] Downloading official repair installer", asset.url);
    await download(asset.url, outputPath);

    if (asset.sha256) {
        const actual = sha256(outputPath);

        if (actual.toLowerCase() !== asset.sha256.toLowerCase()) {
            fs.rmSync(outputPath, { force: true });
            throw new Error("Repair installer sha256 validation failed");
        }
    } else if (app.isPackaged) {
        fs.rmSync(outputPath, { force: true });
        throw new Error("Official repair installer is missing sha256 validation data");
    }

    return {
        installerPath: outputPath,
        version: asset.version,
        sha256: asset.sha256 || sha256(outputPath),
        preservesUserData: true,
        userDataPath: app.getPath("userData")
    };
}

function launchExecutable(installerPath) {
    return new Promise((resolve, reject) => {
        const child = spawn(installerPath, [], {
            detached: true,
            stdio: "ignore",
            windowsHide: false
        });

        child.once("spawn", () => {
            child.unref();
            resolve({
                launchMethod: "detached-process",
                pid: child.pid
            });
        });

        child.once("error", reject);
    });
}

async function launchInstaller(installerPath) {
    if (process.platform === "win32" && /\.exe$/i.test(installerPath)) {
        return launchExecutable(installerPath);
    }

    const openResult = await shell.openPath(installerPath);

    if (openResult) {
        throw new Error(openResult);
    }

    return {
        launchMethod: "shell-open"
    };
}

async function beginRepairInstall() {
    const result = await downloadOfficialInstaller();
    const launch = await launchInstaller(result.installerPath);

    if (process.env.BLACKSHIELD_KEEP_APP_OPEN_AFTER_REPAIR !== "1") {
        setTimeout(() => {
            app.quit();
        }, 1500);
    }

    return {
        ...result,
        ...launch,
        willQuitForRepair: process.env.BLACKSHIELD_KEEP_APP_OPEN_AFTER_REPAIR !== "1"
    };
}

module.exports = {
    downloadOfficialInstaller,
    beginRepairInstall,
    resolveOfficialInstaller
};
