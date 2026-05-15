const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const AdmZip = require("adm-zip");
const { app } = require("electron");
const log = require("electron-log");
const semver = require("semver");
const { autoUpdater } = require("electron-updater");

/*
 * Production updater architecture:
 * - electron-updater owns installed app updates through electron-builder's
 *   generated app-update.yml/latest.yml GitHub Releases metadata.
 * - This module owns optional component updates: manifest fetch, validation,
 *   version checks, ZIP download, safe extraction, install, cleanup, logging,
 *   and update state reporting.
 * - Mutable update data is stored under app.getPath("userData"), never inside
 *   the packaged app directory and never in the user profile data directory.
 */

const DEFAULT_CHANNEL = "latest";
const COMPONENT_STATE_FILE = "component_versions.json";
const UPDATE_STATE_FILE = "update_state.json";
const MANAGED_MARKER = ".blackshield-managed";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 5;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;
const SUPPORTED_MANIFEST_SCHEMA = 1;

const COMPONENT_TYPES = new Set([
    "browser",
    "python",
    "rust",
    "module"
]);

const stateEvents = new EventEmitter();
let electronUpdaterListenersAttached = false;
let loggerConfigured = false;

let updateState = {
    phase: "idle",
    message: "Updater idle",
    channel: DEFAULT_CHANNEL,
    checkedAt: null,
    app: {
        status: "idle"
    },
    components: {
        status: "idle",
        manifestUrl: "",
        checked: [],
        available: [],
        installed: [],
        skipped: [],
        errors: []
    },
    logs: []
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(",")}]`;
    }

    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => {
            return `${JSON.stringify(key)}:${stableStringify(value[key])}`;
        }).join(",")}}`;
    }

    return JSON.stringify(value);
}

function getPackageConfig() {
    try {
        const pkg = require("../package.json");
        return pkg.blackshield || (pkg.build && pkg.build.extraMetadata && pkg.build.extraMetadata.blackshield) || {};
    } catch {
        return {};
    }
}

function getIntegrityPublicKey() {
    const packageConfig = getPackageConfig();

    const key = process.env.BLACKSHIELD_INTEGRITY_PUBLIC_KEY ||
        packageConfig.integrityPublicKeyPem ||
        "";

    return key.replace(/\\n/g, "\n");
}

function getUserDataDir() {
    return app && app.isReady()
        ? app.getPath("userData")
        : path.join(__dirname, "..", ".blackshield-user-data");
}

function getPaths() {
    const userData = getUserDataDir();
    const updaterRoot = path.join(userData, "updater");
    const tempDir = path.join(updaterRoot, "temp");
    const stagingDir = path.join(updaterRoot, "staging");
    const modulesDir = path.join(userData, "modules");
    const logsDir = path.join(userData, "logs");

    return {
        userData,
        updaterRoot,
        tempDir,
        stagingDir,
        modulesDir,
        logsDir,
        componentStatePath: path.join(updaterRoot, COMPONENT_STATE_FILE),
        updateStatePath: path.join(updaterRoot, UPDATE_STATE_FILE),
        devUpdateConfigPath: path.join(__dirname, "..", "dev-app-update.yml")
    };
}

function ensureInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    const relative = path.relative(parentPath, childPath);

    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return childPath;
    }

    throw new Error(`Unsafe path outside managed directory: ${child}`);
}

function ensureDirectories() {
    const paths = getPaths();

    [
        paths.updaterRoot,
        paths.tempDir,
        paths.stagingDir,
        paths.modulesDir,
        paths.logsDir
    ].forEach((directory) => {
        fs.mkdirSync(directory, {
            recursive: true,
            mode: 0o700
        });
    });

    fs.writeFileSync(path.join(paths.updaterRoot, MANAGED_MARKER), "managed by BlackShield X updater\n");
    fs.writeFileSync(path.join(paths.modulesDir, MANAGED_MARKER), "managed by BlackShield X updater\n");

    return paths;
}

function configureLogger() {
    if (loggerConfigured) {
        return;
    }

    loggerConfigured = true;
    const paths = ensureDirectories();

    log.transports.file.level = "info";
    log.transports.console.level = app && app.isPackaged ? "warn" : "info";
    log.transports.file.fileName = "updater.log";
    log.transports.file.resolvePathFn = () => path.join(paths.logsDir, "updater.log");
    log.transports.file.maxSize = 2 * 1024 * 1024;

    autoUpdater.logger = log;
}

function emitState(patch = {}) {
    updateState = {
        ...updateState,
        ...patch,
        app: {
            ...updateState.app,
            ...(patch.app || {})
        },
        components: {
            ...updateState.components,
            ...(patch.components || {})
        }
    };

    const snapshot = clone(updateState);
    stateEvents.emit("state", snapshot);

    try {
        const paths = ensureDirectories();
        fs.writeFileSync(paths.updateStatePath, JSON.stringify(snapshot, null, 2));
    } catch {
        // State persistence is helpful for diagnostics, but must not break updates.
    }

    return snapshot;
}

function logEvent(level, category, message, details = null) {
    configureLogger();

    const safeLevel = ["error", "warn", "info", "debug"].includes(level)
        ? level
        : "info";
    const entry = {
        time: new Date().toISOString(),
        level: safeLevel,
        category,
        message,
        details
    };

    updateState.logs = [entry, ...updateState.logs].slice(0, 80);
    emitState({
        message
    });

    const line = `[${category}] ${message}`;

    if (details) {
        log[safeLevel](line, details);
    } else {
        log[safeLevel](line);
    }
}

function classifyError(error, fallbackCategory) {
    const message = error && error.message ? error.message : String(error);

    if (/manifest/i.test(message)) {
        return "manifest";
    }

    if (/download|request|timeout|http|status/i.test(message)) {
        return "network";
    }

    if (/sha512|checksum|hash|zip|extract|traversal|unsafe/i.test(message)) {
        return "security";
    }

    if (/permission|access|eacces|eperm|readonly/i.test(message)) {
        return "filesystem";
    }

    return fallbackCategory || "unknown";
}

function readJson(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
        return clone(fallback);
    }
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), {
        recursive: true,
        mode: 0o700
    });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function loadComponentState() {
    const paths = ensureDirectories();
    const state = readJson(paths.componentStatePath, {
        schemaVersion: 1,
        components: {}
    });

    if (!state || typeof state !== "object") {
        return {
            schemaVersion: 1,
            components: {}
        };
    }

    if (!state.components || typeof state.components !== "object") {
        state.components = {};
    }

    return state;
}

function saveComponentState(state) {
    const paths = ensureDirectories();

    writeJson(paths.componentStatePath, {
        schemaVersion: 1,
        components: state.components || {}
    });
}

function getInstalledComponent(id, componentState = loadComponentState()) {
    const component = componentState.components[id];

    if (typeof component === "string") {
        return {
            version: component
        };
    }

    return component || null;
}

function sanitizeId(id) {
    const value = String(id || "").trim();

    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(value)) {
        throw new Error(`Invalid component id: ${value}`);
    }

    return value.toLowerCase();
}

function normalizeType(type, id) {
    const inferred = id.includes("python")
        ? "python"
        : id.includes("rust")
            ? "rust"
            : "module";
    const value = String(type || inferred).trim().toLowerCase();

    if (!COMPONENT_TYPES.has(value)) {
        throw new Error(`Unsupported component type: ${value}`);
    }

    return value;
}

function normalizeArray(value) {
    if (value === undefined || value === null) {
        return [];
    }

    return Array.isArray(value) ? value.map(String) : [String(value)];
}

function getCurrentChannel(options = {}) {
    const packageConfig = getPackageConfig();

    return String(
        options.channel ||
        process.env.BLACKSHIELD_UPDATE_CHANNEL ||
        packageConfig.updateChannel ||
        DEFAULT_CHANNEL
    ).trim() || DEFAULT_CHANNEL;
}

function getDefaultManifestUrl(channel) {
    const packageConfig = getPackageConfig();
    const explicit =
        process.env.BLACKSHIELD_MODULE_MANIFEST_URL ||
        packageConfig.moduleManifestUrl ||
        "";

    if (explicit) {
        return explicit;
    }

    if (channel !== DEFAULT_CHANNEL) {
        return "";
    }

    return "https://github.com/darkchocolate00/blackshield-x/releases/latest/download/module-manifest.json";
}

function validateVersion(version, label) {
    const value = String(version || "").trim();

    if (!semver.valid(value)) {
        throw new Error(`Invalid ${label} version: ${value}`);
    }

    return value;
}

function isAllowedForCurrentRuntime(component, channel) {
    const reasons = [];

    if (component.platforms.length > 0 && !component.platforms.includes(process.platform)) {
        reasons.push(`platform ${process.platform} not listed`);
    }

    if (component.arches.length > 0 && !component.arches.includes(process.arch)) {
        reasons.push(`arch ${process.arch} not listed`);
    }

    if (component.channels.length > 0 && !component.channels.includes(channel)) {
        reasons.push(`channel ${channel} not listed`);
    }

    const appVersion = app.getVersion();

    if (component.minAppVersion && semver.lt(appVersion, component.minAppVersion)) {
        reasons.push(`app version ${appVersion} below ${component.minAppVersion}`);
    }

    if (component.maxAppVersion && semver.gt(appVersion, component.maxAppVersion)) {
        reasons.push(`app version ${appVersion} above ${component.maxAppVersion}`);
    }

    return {
        allowed: reasons.length === 0,
        reasons
    };
}

function resolveManifestUrl(url, baseUrl) {
    const resolved = baseUrl
        ? new URL(url, baseUrl)
        : new URL(url);

    if (app.isPackaged && resolved.protocol !== "https:") {
        throw new Error(`Production component URLs must use https: ${resolved.href}`);
    }

    if (!["https:", "http:", "file:"].includes(resolved.protocol)) {
        throw new Error(`Unsupported component URL protocol: ${resolved.protocol}`);
    }

    return resolved.toString();
}

function validateSha512(value) {
    if (!value) {
        return "";
    }

    const normalized = String(value).trim();

    if (!/^[a-f0-9]{128}$/i.test(normalized) && !/^[A-Za-z0-9+/=]{86,}$/.test(normalized)) {
        throw new Error("Invalid sha512 checksum format");
    }

    return normalized;
}

function validateSha256(value) {
    if (!value) {
        return "";
    }

    const normalized = String(value).trim();

    if (!/^[a-f0-9]{64}$/i.test(normalized)) {
        throw new Error("Invalid sha256 checksum format");
    }

    return normalized.toLowerCase();
}

function verifyRemoteManifestSignature(rawManifest) {
    if (!rawManifest.signed && !app.isPackaged) {
        return {
            status: "development-unsigned"
        };
    }

    if (!rawManifest.signed) {
        throw new Error("Packaged builds require signed module manifests");
    }

    if (rawManifest.signatureAlgorithm && rawManifest.signatureAlgorithm !== "ed25519") {
        throw new Error(`Unsupported module manifest signature algorithm: ${rawManifest.signatureAlgorithm}`);
    }

    const publicKey = getIntegrityPublicKey();

    if (!publicKey) {
        throw new Error("Module manifest public key is not configured");
    }

    const payload = {
        ...rawManifest
    };
    delete payload.signature;

    const verified = crypto.verify(
        null,
        Buffer.from(stableStringify(payload), "utf8"),
        publicKey,
        Buffer.from(String(rawManifest.signature || ""), "base64")
    );

    if (!verified) {
        throw new Error("Module manifest signature verification failed");
    }

    return {
        status: "signed"
    };
}

function validateManifest(rawManifest, manifestUrl, channel) {
    if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest)) {
        throw new Error("Manifest must be a JSON object");
    }

    verifyRemoteManifestSignature(rawManifest);

    const schemaVersion = Number(rawManifest.schemaVersion || rawManifest.version || SUPPORTED_MANIFEST_SCHEMA);

    if (schemaVersion !== SUPPORTED_MANIFEST_SCHEMA) {
        throw new Error(`Unsupported manifest schema version: ${schemaVersion}`);
    }

    const rawComponents = rawManifest.components || rawManifest.modules;

    if (!rawComponents || typeof rawComponents !== "object" || Array.isArray(rawComponents)) {
        throw new Error("Manifest must contain a components object");
    }

    const components = [];
    const skipped = [];

    Object.entries(rawComponents).forEach(([rawId, rawComponent]) => {
        const id = sanitizeId(rawId);

        if (!rawComponent || typeof rawComponent !== "object" || Array.isArray(rawComponent)) {
            throw new Error(`Component ${id} must be an object`);
        }

        if (rawComponent.enabled === false) {
            skipped.push({
                id,
                reason: "disabled by manifest"
            });
            return;
        }

        const component = {
            id,
            type: normalizeType(rawComponent.type || rawComponent.kind, id),
            version: validateVersion(rawComponent.version, `${id} component`),
            url: resolveManifestUrl(rawComponent.url, manifestUrl),
            sha256: validateSha256(rawComponent.sha256),
            sha512: validateSha512(rawComponent.sha512 || rawComponent.checksum),
            size: Number(rawComponent.size) || 0,
            keepVersions: Math.max(1, Math.min(Number(rawComponent.keepVersions) || 1, 3)),
            platforms: normalizeArray(rawComponent.platforms || rawComponent.platform),
            arches: normalizeArray(rawComponent.arches || rawComponent.arch),
            channels: normalizeArray(rawComponent.channels || rawComponent.channel),
            minAppVersion: rawComponent.minAppVersion ? validateVersion(rawComponent.minAppVersion, `${id} minAppVersion`) : "",
            maxAppVersion: rawComponent.maxAppVersion ? validateVersion(rawComponent.maxAppVersion, `${id} maxAppVersion`) : "",
            allowDowngrade: Boolean(rawComponent.allowDowngrade),
            maxUncompressedBytes: Number(rawComponent.maxUncompressedBytes) || DEFAULT_MAX_UNCOMPRESSED_BYTES
        };

        const runtime = isAllowedForCurrentRuntime(component, channel);

        if (!runtime.allowed) {
            skipped.push({
                id,
                version: component.version,
                reason: runtime.reasons.join("; ")
            });
            return;
        }

        components.push(component);
    });

    return {
        schemaVersion,
        channel,
        generatedAt: rawManifest.generatedAt || "",
        components,
        skipped
    };
}

function componentNeedsUpdate(component, installed) {
    if (!installed || !installed.version) {
        return true;
    }

    if (component.version === installed.version) {
        return false;
    }

    if (semver.gt(component.version, installed.version)) {
        return true;
    }

    return Boolean(component.allowDowngrade);
}

function requestUrl(url, redirectCount = 0) {
    return new Promise((resolve, reject) => {
        const parsed = new URL(url);
        const client = parsed.protocol === "http:" ? http : https;
        const request = client.get(parsed, {
            timeout: REQUEST_TIMEOUT_MS,
            headers: {
                "User-Agent": `BlackShieldX/${app.getVersion()}`
            }
        }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                response.resume();

                if (redirectCount >= MAX_REDIRECTS) {
                    reject(new Error("Too many redirects"));
                    return;
                }

                requestUrl(new URL(response.headers.location, parsed).toString(), redirectCount + 1)
                    .then(resolve, reject);
                return;
            }

            if (response.statusCode < 200 || response.statusCode >= 300) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode} for ${parsed.href}`));
                return;
            }

            resolve(response);
        });

        request.on("timeout", () => {
            request.destroy(new Error(`Request timed out for ${parsed.href}`));
        });

        request.on("error", reject);
    });
}

async function fetchManifest(manifestUrl, channel) {
    if (!manifestUrl) {
        return {
            manifest: null,
            skipped: true,
            message: "No module manifest URL configured"
        };
    }

    const parsed = new URL(manifestUrl);
    let raw;

    if (parsed.protocol === "file:") {
        if (app.isPackaged) {
            throw new Error("file: manifests are not allowed in production");
        }

        raw = fs.readFileSync(parsed, "utf8");
    } else {
        if (app.isPackaged && parsed.protocol !== "https:") {
            throw new Error("Production manifest URLs must use https");
        }

        const response = await requestUrl(parsed.toString());
        raw = await new Promise((resolve, reject) => {
            let data = "";

            response.setEncoding("utf8");
            response.on("data", (chunk) => {
                data += chunk;
            });
            response.on("end", () => resolve(data));
            response.on("error", reject);
        });
    }

    let json;

    try {
        json = JSON.parse(raw);
    } catch (error) {
        throw new Error(`Manifest JSON parse failed: ${error.message}`);
    }

    return {
        manifest: validateManifest(json, manifestUrl, channel),
        skipped: false,
        message: "Manifest loaded"
    };
}

function makeDownloadPath(component) {
    const paths = ensureDirectories();
    const fileName = `${component.id}-${component.version}.zip`;
    const target = path.join(paths.tempDir, fileName);
    return ensureInside(paths.tempDir, target);
}

function copyFileUrlToPath(url, outputPath) {
    const parsed = new URL(url);

    if (app.isPackaged) {
        throw new Error("file: downloads are not allowed in production");
    }

    fs.copyFileSync(parsed, outputPath);
}

async function downloadFile(url, outputPath, expectedSize = 0) {
    const parsed = new URL(url);

    fs.mkdirSync(path.dirname(outputPath), {
        recursive: true,
        mode: 0o700
    });

    if (parsed.protocol === "file:") {
        copyFileUrlToPath(url, outputPath);
        return {
            bytes: fs.statSync(outputPath).size
        };
    }

    const response = await requestUrl(parsed.toString());
    const contentLength = Number(response.headers["content-length"]) || 0;

    if (expectedSize > 0 && contentLength > 0 && expectedSize !== contentLength) {
        response.resume();
        throw new Error(`Download size mismatch for ${parsed.href}`);
    }

    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(outputPath, {
            mode: 0o600
        });

        response.pipe(file);
        response.on("error", reject);
        file.on("finish", () => file.close(resolve));
        file.on("error", reject);
    });

    return {
        bytes: fs.statSync(outputPath).size
    };
}

function verifySha512(filePath, expectedSha512) {
    if (!expectedSha512) {
        return;
    }

    const digestHex = crypto
        .createHash("sha512")
        .update(fs.readFileSync(filePath))
        .digest("hex");

    const expected = expectedSha512.trim();
    const expectedHex = /^[a-f0-9]{128}$/i.test(expected)
        ? expected.toLowerCase()
        : Buffer.from(expected, "base64").toString("hex");

    if (digestHex !== expectedHex) {
        throw new Error(`sha512 mismatch for ${path.basename(filePath)}`);
    }
}

function verifySha256(filePath, expectedSha256) {
    if (!expectedSha256) {
        return;
    }

    const digestHex = crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");

    if (digestHex !== expectedSha256) {
        throw new Error(`sha256 mismatch for ${path.basename(filePath)}`);
    }
}

function verifyDownloadIntegrity(filePath, component) {
    if (app.isPackaged && !component.sha256 && !component.sha512) {
        throw new Error("Production component updates require sha256 or sha512");
    }

    if (!component.sha256 && !component.sha512) {
        logEvent("warn", "security", `No checksum provided for ${path.basename(filePath)}; allowed only in development`);
        return;
    }

    verifySha256(filePath, component.sha256);
    verifySha512(filePath, component.sha512);
}

function entryIsSymlink(entry) {
    const mode = (entry.attr >> 16) & 0o170000;
    return mode === 0o120000;
}

function validateZipEntry(entry, destinationDir) {
    const entryName = String(entry.entryName || "").replace(/\\/g, "/");

    if (!entryName || entryName.startsWith("/") || /^[a-zA-Z]:/.test(entryName)) {
        throw new Error(`Unsafe ZIP entry path: ${entry.entryName}`);
    }

    const parts = entryName.split("/");

    if (parts.includes("..")) {
        throw new Error(`ZIP path traversal blocked: ${entry.entryName}`);
    }

    if (entryIsSymlink(entry)) {
        throw new Error(`ZIP symlink entry blocked: ${entry.entryName}`);
    }

    return ensureInside(destinationDir, path.join(destinationDir, entryName));
}

function safeExtractZip(zipPath, destinationDir, maxUncompressedBytes) {
    const zip = new AdmZip(zipPath);
    const entries = zip.getEntries();
    let totalSize = 0;

    fs.mkdirSync(destinationDir, {
        recursive: true,
        mode: 0o700
    });

    for (const entry of entries) {
        totalSize += Number(entry.header && entry.header.size) || 0;

        if (totalSize > maxUncompressedBytes) {
            throw new Error("ZIP uncompressed size exceeds manifest limit");
        }

        const target = validateZipEntry(entry, destinationDir);

        if (entry.isDirectory) {
            fs.mkdirSync(target, {
                recursive: true,
                mode: 0o700
            });
            continue;
        }

        fs.mkdirSync(path.dirname(target), {
            recursive: true,
            mode: 0o700
        });
        fs.writeFileSync(target, entry.getData(), {
            mode: 0o600
        });

        const mode = (entry.attr >> 16) & 0o777;
        const safeMode = mode > 0 ? mode & 0o755 : 0o600;
        fs.chmodSync(target, safeMode);
    }
}

function readComponentPackageManifest(stagingPath, component) {
    const manifestPath = path.join(stagingPath, "blackshield-component.json");

    if (!fs.existsSync(manifestPath)) {
        return {
            files: []
        };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error(`${component.id} package manifest must be an object`);
    }

    if (manifest.id && manifest.id !== component.id) {
        throw new Error(`${component.id} package manifest id mismatch`);
    }

    if (manifest.version && manifest.version !== component.version) {
        throw new Error(`${component.id} package manifest version mismatch`);
    }

    const files = Array.isArray(manifest.files) ? manifest.files : [];

    const verifiedFiles = files.map((entry) => {
        const relative = String(entry.path || "").replace(/\\/g, "/");

        if (!relative || relative.startsWith("/") || /^[a-zA-Z]:/.test(relative) || relative.split("/").includes("..")) {
            throw new Error(`${component.id} package manifest has unsafe path: ${entry.path}`);
        }

        const target = ensureInside(stagingPath, path.join(stagingPath, relative));

        if (!fs.existsSync(target)) {
            throw new Error(`${component.id} package file missing: ${relative}`);
        }

        const actual = crypto
            .createHash("sha256")
            .update(fs.readFileSync(target))
            .digest("hex");
        const expected = String(entry.sha256 || "").toLowerCase();

        if (!expected || actual !== expected) {
            throw new Error(`${component.id} package file hash mismatch: ${relative}`);
        }

        return {
            path: relative,
            sha256: actual
        };
    });

    return {
        files: verifiedFiles
    };
}

function componentInstallDir(component) {
    const paths = ensureDirectories();
    const componentRoot = ensureInside(paths.modulesDir, path.join(paths.modulesDir, component.id));
    const versionDir = ensureInside(componentRoot, path.join(componentRoot, component.version));

    return {
        componentRoot,
        versionDir
    };
}

function removeDirectory(target) {
    if (fs.existsSync(target)) {
        fs.rmSync(target, {
            recursive: true,
            force: true
        });
    }
}

function removeFile(target) {
    fs.rmSync(target, {
        force: true
    });
}

function cleanupTemp() {
    const paths = ensureDirectories();

    removeDirectory(paths.tempDir);
    removeDirectory(paths.stagingDir);

    fs.mkdirSync(paths.tempDir, {
        recursive: true,
        mode: 0o700
    });
    fs.mkdirSync(paths.stagingDir, {
        recursive: true,
        mode: 0o700
    });

    logEvent("info", "cleanup", "Temporary update files cleaned");
}

function cleanupOldVersions(component, componentState) {
    const { componentRoot } = componentInstallDir(component);
    const installed = getInstalledComponent(component.id, componentState);
    const activeVersion = installed && installed.version;

    if (!fs.existsSync(componentRoot)) {
        return [];
    }

    const removed = [];
    const versions = fs.readdirSync(componentRoot, {
        withFileTypes: true
    }).filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((version) => semver.valid(version))
        .sort(semver.rcompare);

    const keep = new Set(versions.slice(0, component.keepVersions));

    if (activeVersion) {
        keep.add(activeVersion);
    }

    versions.forEach((version) => {
        if (keep.has(version)) {
            return;
        }

        const target = ensureInside(componentRoot, path.join(componentRoot, version));
        removeDirectory(target);
        removed.push(version);
    });

    if (removed.length > 0) {
        logEvent("info", "cleanup", `Removed old ${component.id} versions`, removed);
    }

    return removed;
}

function cleanupOrphanComponents(manifest, componentState) {
    const paths = ensureDirectories();
    const knownIds = new Set([
        ...Object.keys(componentState.components || {}),
        ...manifest.components.map((component) => component.id)
    ]);
    const removed = [];

    if (!fs.existsSync(paths.modulesDir)) {
        return removed;
    }

    fs.readdirSync(paths.modulesDir, {
        withFileTypes: true
    }).forEach((entry) => {
        if (!entry.isDirectory()) {
            return;
        }

        if (knownIds.has(entry.name)) {
            return;
        }

        const target = ensureInside(paths.modulesDir, path.join(paths.modulesDir, entry.name));
        removeDirectory(target);
        removed.push(entry.name);
    });

    if (removed.length > 0) {
        logEvent("info", "cleanup", "Removed orphan updater-managed component folders", removed);
    }

    return removed;
}

async function installComponent(component) {
    const paths = ensureDirectories();
    const downloadPath = makeDownloadPath(component);
    const stagingPath = ensureInside(paths.stagingDir, path.join(paths.stagingDir, `${component.id}-${component.version}`));
    const { versionDir } = componentInstallDir(component);

    removeDirectory(stagingPath);
    removeFile(downloadPath);

    logEvent("info", "download", `Downloading ${component.id} ${component.version}`);
    const download = await downloadFile(component.url, downloadPath, component.size);

    logEvent("info", "security", `Verifying ${component.id} ${component.version}`);
    verifyDownloadIntegrity(downloadPath, component);

    logEvent("info", "extract", `Extracting ${component.id} ${component.version}`);
    safeExtractZip(downloadPath, stagingPath, component.maxUncompressedBytes);
    const packageManifest = readComponentPackageManifest(stagingPath, component);

    removeDirectory(versionDir);
    fs.mkdirSync(path.dirname(versionDir), {
        recursive: true,
        mode: 0o700
    });
    fs.renameSync(stagingPath, versionDir);

    const installedAt = new Date().toISOString();
    const componentState = loadComponentState();
    componentState.components[component.id] = {
        id: component.id,
        type: component.type,
        version: component.version,
        installPath: versionDir,
        sourceUrl: component.url,
        sha256: component.sha256,
        sha512: component.sha512,
        size: download.bytes,
        fileIntegrity: packageManifest.files,
        installedAt
    };
    saveComponentState(componentState);
    cleanupOldVersions(component, componentState);

    removeFile(downloadPath);
    removeDirectory(stagingPath);

    logEvent("info", "install", `Installed ${component.id} ${component.version}`);

    return componentState.components[component.id];
}

function detectComponentUpdates(manifest, componentState) {
    const checked = [];
    const available = [];
    const skipped = [...manifest.skipped];

    manifest.components.forEach((component) => {
        const installed = getInstalledComponent(component.id, componentState);
        const needsUpdate = componentNeedsUpdate(component, installed);
        const record = {
            id: component.id,
            type: component.type,
            currentVersion: installed && installed.version ? installed.version : null,
            targetVersion: component.version,
            needsUpdate
        };

        checked.push(record);

        if (needsUpdate) {
            available.push(component);
        } else {
            skipped.push({
                id: component.id,
                version: component.version,
                reason: "already current"
            });
        }
    });

    return {
        checked,
        available,
        skipped
    };
}

async function checkModuleUpdates(options = {}) {
    const channel = getCurrentChannel(options);
    const manifestUrl = options.manifestUrl || getDefaultManifestUrl(channel);

    emitState({
        phase: "checking-components",
        channel,
        checkedAt: new Date().toISOString(),
        components: {
            status: "checking",
            manifestUrl,
            checked: [],
            available: [],
            installed: [],
            skipped: [],
            errors: []
        }
    });

    const fetched = await fetchManifest(manifestUrl, channel);

    if (fetched.skipped) {
        logEvent("info", "manifest", fetched.message);
        emitState({
            components: {
                status: "skipped",
                skipped: [{
                    reason: fetched.message
                }]
            }
        });
        return {
            status: "skipped",
            message: fetched.message,
            checked: [],
            available: [],
            installed: [],
            skipped: []
        };
    }

    const componentState = loadComponentState();
    const updates = detectComponentUpdates(fetched.manifest, componentState);

    emitState({
        components: {
            status: updates.available.length > 0 ? "updates-available" : "current",
            checked: updates.checked,
            available: updates.available.map((component) => ({
                id: component.id,
                type: component.type,
                version: component.version
            })),
            skipped: updates.skipped
        }
    });

    const installed = [];
    const errors = [];

    for (const component of updates.available) {
        try {
            const result = await installComponent(component);
            installed.push(result);
            emitState({
                components: {
                    installed
                }
            });
        } catch (error) {
            const category = classifyError(error, "component");
            const record = {
                id: component.id,
                version: component.version,
                category,
                message: error.message
            };

            errors.push(record);
            logEvent("error", category, `Failed to update ${component.id}`, record);
        }
    }

    cleanupOrphanComponents(fetched.manifest, loadComponentState());
    cleanupTemp();

    const status = errors.length > 0
        ? "error"
        : installed.length > 0
            ? "updated"
            : "current";

    emitState({
        components: {
            status,
            installed,
            errors
        }
    });

    return {
        status,
        manifestUrl,
        checked: updates.checked,
        available: updates.available.map((component) => ({
            id: component.id,
            type: component.type,
            version: component.version
        })),
        installed,
        skipped: updates.skipped,
        errors
    };
}

function hasDevUpdateConfig() {
    const paths = getPaths();
    return fs.existsSync(paths.devUpdateConfigPath);
}

function configureElectronUpdater(options = {}) {
    configureLogger();

    const channel = getCurrentChannel(options);

    autoUpdater.autoDownload = options.autoDownload !== false;
    autoUpdater.autoInstallOnAppQuit = options.autoInstallOnAppQuit !== false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.allowPrerelease = channel !== DEFAULT_CHANNEL;
    autoUpdater.channel = channel;
    autoUpdater.allowDowngrade = Boolean(options.allowDowngrade);

    if (!app.isPackaged && hasDevUpdateConfig()) {
        autoUpdater.forceDevUpdateConfig = true;
        logEvent("info", "app-update", "Using dev-app-update.yml for development app update checks");
    }

    if (electronUpdaterListenersAttached) {
        return;
    }

    electronUpdaterListenersAttached = true;

    autoUpdater.on("checking-for-update", () => {
        emitState({
            phase: "checking-app",
            app: {
                status: "checking"
            }
        });
        logEvent("info", "app-update", "Checking GitHub Releases for app updates");
    });

    autoUpdater.on("update-available", (info) => {
        emitState({
            app: {
                status: "available",
                version: info.version,
                files: info.files || []
            }
        });
        logEvent("info", "app-update", `App update available: ${info.version}`);
    });

    autoUpdater.on("update-not-available", (info) => {
        emitState({
            app: {
                status: "current",
                version: info && info.version ? info.version : app.getVersion()
            }
        });
        logEvent("info", "app-update", "No app update available");
    });

    autoUpdater.on("download-progress", (progress) => {
        emitState({
            phase: "downloading-app",
            app: {
                status: "downloading",
                progress: {
                    percent: progress.percent,
                    transferred: progress.transferred,
                    total: progress.total,
                    bytesPerSecond: progress.bytesPerSecond
                }
            }
        });
    });

    autoUpdater.on("update-downloaded", (event) => {
        emitState({
            phase: "app-update-downloaded",
            app: {
                status: "downloaded",
                version: event.version,
                downloadedFile: event.downloadedFile || ""
            }
        });
        logEvent("info", "app-update", `App update downloaded: ${event.version}`);
    });

    autoUpdater.on("update-cancelled", (info) => {
        emitState({
            app: {
                status: "cancelled",
                version: info && info.version ? info.version : ""
            }
        });
        logEvent("warn", "app-update", "App update cancelled");
    });

    autoUpdater.on("error", (error) => {
        const category = classifyError(error, "app-update");
        emitState({
            app: {
                status: "error",
                error: {
                    category,
                    message: error.message
                }
            }
        });
        logEvent("error", category, "App update failed", error.message);
    });
}

async function checkElectronUpdates(options = {}) {
    configureElectronUpdater(options);

    if (!app.isPackaged && !hasDevUpdateConfig()) {
        const message = "App updater skipped in development because dev-app-update.yml is not configured";
        emitState({
            app: {
                status: "skipped",
                message
            }
        });
        logEvent("info", "app-update", message);

        return {
            status: "skipped",
            message
        };
    }

    const result = await autoUpdater.checkForUpdatesAndNotify();

    return {
        status: "ok",
        updateInfo: result && result.updateInfo ? result.updateInfo : null
    };
}

async function startUpdater(options = {}) {
    ensureDirectories();
    configureLogger();
    cleanupTemp();

    const channel = getCurrentChannel(options);

    emitState({
        phase: "checking",
        channel,
        checkedAt: new Date().toISOString(),
        message: "Checking for updates"
    });

    const result = {
        status: "ok",
        channel,
        app: {
            status: "skipped"
        },
        components: {
            status: "skipped"
        },
        errors: []
    };

    if (options.enableElectronUpdater !== false) {
        try {
            result.app = await checkElectronUpdates({
                ...options,
                channel
            });
        } catch (error) {
            const category = classifyError(error, "app-update");
            result.app = {
                status: "error",
                category,
                message: error.message
            };
            result.errors.push(result.app);
            logEvent("error", category, "Electron app update check failed", error.message);
        }
    }

    if (options.enableModuleUpdater !== false) {
        try {
            result.components = await checkModuleUpdates({
                ...options,
                channel
            });
        } catch (error) {
            const category = classifyError(error, "manifest");
            result.components = {
                status: "error",
                category,
                message: error.message
            };
            result.errors.push(result.components);
            logEvent("error", category, "Component update check failed", error.message);
        }
    }

    result.status = result.errors.length > 0 ? "error" : "ok";

    emitState({
        phase: "idle",
        message: result.status === "ok" ? "Update check finished" : "Update check finished with errors"
    });

    return result;
}

function getUpdateState() {
    return clone(updateState);
}

function onStateChange(callback) {
    stateEvents.on("state", callback);
    return () => {
        stateEvents.removeListener("state", callback);
    };
}

function installDownloadedUpdate() {
    autoUpdater.quitAndInstall(false, true);
}

module.exports = {
    startUpdater,
    checkModuleUpdates,
    getUpdateState,
    onStateChange,
    installDownloadedUpdate
};
