const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app } = require("electron");
const log = require("electron-log");

/*
 * Advanced Integrity & Tamper Protection:
 * - Verifies the signed official integrity manifest.
 * - Verifies runtime SHA256 hashes and updater/module integrity.
 * - Uses a Python integrity service as an independent hash verifier when present.
 * - Enters protected mode on invalid official builds without deleting user data.
 */

const MANIFEST_FILE = "integrity-manifest.json";
const SIGNATURE_ALGORITHM = "ed25519";
const HASH_ALGORITHM = "sha256";
const TRUSTED_PRODUCT = "BlackShield X";
const TRUSTED_ID_PREFIX = "bsx";

const events = new EventEmitter();

let protectedMode = false;
let integrityState = {
    status: "unknown",
    protectedMode: false,
    integrityId: "",
    buildSignature: "",
    manifestPath: "",
    reason: "",
    details: [],
    checkedAt: null,
    backendTrust: {
        status: "unknown"
    },
    service: {
        status: "not-started"
    }
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function emitState(patch = {}) {
    integrityState = {
        ...integrityState,
        ...patch,
        backendTrust: {
            ...integrityState.backendTrust,
            ...(patch.backendTrust || {})
        },
        service: {
            ...integrityState.service,
            ...(patch.service || {})
        }
    };

    events.emit("state", clone(integrityState));
    return integrityState;
}

function getUserDataDir() {
    return app.getPath("userData");
}

function getAppRoot() {
    return app.isPackaged ? app.getAppPath() : path.join(__dirname, "..");
}

function getResourceRoot() {
    return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}

function getManifestPath() {
    const packagedManifest = path.join(process.resourcesPath || "", "integrity", MANIFEST_FILE);
    const devManifest = path.join(__dirname, MANIFEST_FILE);

    if (app.isPackaged && fs.existsSync(packagedManifest)) {
        return packagedManifest;
    }

    return devManifest;
}

function ensureInside(parent, child) {
    const parentPath = path.resolve(parent);
    const childPath = path.resolve(child);
    const relative = path.relative(parentPath, childPath);

    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
        return childPath;
    }

    throw new Error(`Integrity path escaped trusted root: ${child}`);
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

function getPublicKey() {
    const packageConfig = (() => {
        try {
            const pkg = require("../package.json");
            return pkg.blackshield || (pkg.build && pkg.build.extraMetadata && pkg.build.extraMetadata.blackshield) || {};
        } catch {
            return {};
        }
    })();

    const key = process.env.BLACKSHIELD_INTEGRITY_PUBLIC_KEY ||
        packageConfig.integrityPublicKeyPem ||
        "";

    return key.replace(/\\n/g, "\n");
}

function allowUnsignedPackagedBuilds() {
    return process.env.BLACKSHIELD_ALLOW_UNSIGNED_PACKAGED === "1";
}

function readManifest(manifestPath) {
    if (!fs.existsSync(manifestPath)) {
        throw new Error(`Integrity manifest missing: ${manifestPath}`);
    }

    const raw = fs.readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(raw);

    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Integrity manifest must be an object");
    }

    if (manifest.schemaVersion !== 1) {
        throw new Error(`Unsupported integrity manifest schema: ${manifest.schemaVersion}`);
    }

    if (manifest.product !== TRUSTED_PRODUCT) {
        throw new Error("Integrity manifest product identity mismatch");
    }

    if (!String(manifest.integrityId || "").startsWith(TRUSTED_ID_PREFIX)) {
        throw new Error("Integrity manifest ID is not a BlackShield identity");
    }

    if (manifest.hashAlgorithm !== HASH_ALGORITHM) {
        throw new Error(`Unsupported hash algorithm: ${manifest.hashAlgorithm}`);
    }

    if (!Array.isArray(manifest.files)) {
        throw new Error("Integrity manifest files must be an array");
    }

    return manifest;
}

function verifyManifestSignature(manifest) {
    const signed = Boolean(manifest.signed);

    if (!signed && !app.isPackaged) {
        return {
            ok: true,
            status: "development-unsigned"
        };
    }

    if (!signed && app.isPackaged && allowUnsignedPackagedBuilds()) {
        log.warn("[integrity] Unsigned packaged build allowed for local testing only.");

        return {
            ok: true,
            status: "local-packaged-unsigned"
        };
    }

    if (!signed) {
        throw new Error("Official packaged builds require a signed integrity manifest");
    }

    if (manifest.signatureAlgorithm !== SIGNATURE_ALGORITHM) {
        throw new Error(`Unsupported signature algorithm: ${manifest.signatureAlgorithm}`);
    }

    const publicKey = getPublicKey();

    if (!publicKey) {
        throw new Error("Integrity public key is not configured");
    }

    const signature = Buffer.from(String(manifest.signature || ""), "base64");
    const payload = {
        ...manifest
    };
    delete payload.signature;

    const verified = crypto.verify(
        null,
        Buffer.from(stableStringify(payload), "utf8"),
        publicKey,
        signature
    );

    if (!verified) {
        throw new Error("Integrity manifest signature verification failed");
    }

    return {
        ok: true,
        status: "signed"
    };
}

function resolveFileEntry(entry) {
    const root = entry.root || "app";
    const baseRoots = {
        app: getAppRoot(),
        resources: getResourceRoot(),
        userModules: path.join(getUserDataDir(), "modules")
    };
    const base = baseRoots[root];

    if (!base) {
        throw new Error(`Unsupported integrity root: ${root}`);
    }

    const relative = String(entry.path || "").replace(/\\/g, "/");

    if (!relative || relative.startsWith("/") || /^[a-zA-Z]:/.test(relative) || relative.split("/").includes("..")) {
        throw new Error(`Unsafe integrity manifest path: ${entry.path}`);
    }

    return {
        root,
        relative,
        fullPath: ensureInside(base, path.join(base, relative))
    };
}

function sha256File(filePath) {
    return crypto
        .createHash(HASH_ALGORITHM)
        .update(fs.readFileSync(filePath))
        .digest("hex");
}

function isVirtualAsarPath(filePath) {
    return /\.asar[\\/]/i.test(filePath);
}

function terminateServiceProcess(child) {
    if (!child || child.killed) {
        return;
    }

    if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore"
        });

        killer.on("error", () => {
            child.kill();
        });
        return;
    }

    child.kill();
}

function verifyFilesInNode(files) {
    const checked = [];
    const failures = [];

    files.forEach((entry) => {
        const resolved = resolveFileEntry(entry);

        if (!fs.existsSync(resolved.fullPath)) {
            if (entry.optional) {
                checked.push({
                    path: entry.path,
                    status: "optional-missing"
                });
                return;
            }

            failures.push({
                path: entry.path,
                reason: "missing"
            });
            return;
        }

        const actual = sha256File(resolved.fullPath);
        const expected = String(entry.sha256 || "").toLowerCase();

        if (!expected || actual !== expected) {
            failures.push({
                path: entry.path,
                reason: "hash-mismatch",
                expected,
                actual
            });
            return;
        }

        checked.push({
            path: entry.path,
            status: "ok"
        });
    });

    return {
        checked,
        failures
    };
}

function findPythonService() {
    const resourceExe = path.join(getResourceRoot(), "python-engine", "engine.exe");
    const devPython = path.join(__dirname, "..", "..", "python-engine", ".venv", "Scripts", "python.exe");
    const serviceScript = path.join(__dirname, "..", "..", "python-engine", "main.py");

    if (app.isPackaged && fs.existsSync(resourceExe)) {
        return {
            command: resourceExe,
            args: ["--integrity-service"]
        };
    }

    if (fs.existsSync(devPython) && fs.existsSync(serviceScript)) {
        return {
            command: devPython,
            args: [serviceScript, "--integrity-service"]
        };
    }

    if (!app.isPackaged && fs.existsSync(serviceScript)) {
        return {
            command: "python",
            args: [serviceScript, "--integrity-service"]
        };
    }

    return null;
}

function verifyWithPythonService(files) {
    return new Promise((resolve) => {
        const service = findPythonService();

        if (!service) {
            const status = app.isPackaged ? "missing" : "unavailable-dev";
            emitState({
                service: {
                    status
                }
            });
            resolve({
                status,
                failures: []
            });
            return;
        }

        let serviceFiles = [];

        try {
            serviceFiles = files
                .map((entry) => ({
                    entry,
                    resolved: resolveFileEntry(entry)
                }))
                .filter(({ resolved }) => !isVirtualAsarPath(resolved.fullPath));
        } catch (error) {
            resolve({
                status: "error",
                failures: [{
                    reason: error.message
                }]
            });
            return;
        }

        if (serviceFiles.length === 0) {
            emitState({
                service: {
                    status: "skipped-virtual-asar"
                }
            });
            resolve({
                status: "skipped-virtual-asar",
                failures: []
            });
            return;
        }

        const child = spawn(service.command, service.args, {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });

        let output = "";
        let errorOutput = "";
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) {
                return;
            }

            settled = true;
            terminateServiceProcess(child);
            resolve({
                status: "timeout",
                failures: [{
                    reason: "integrity-service-timeout"
                }]
            });
        }, 12000);

        child.stdout.on("data", (data) => {
            output += data.toString();
        });

        child.stderr.on("data", (data) => {
            errorOutput += data.toString();
        });

        child.on("error", (error) => {
            if (settled) {
                return;
            }

            clearTimeout(timeout);
            settled = true;
            resolve({
                status: "error",
                failures: [{
                    reason: error.message
                }]
            });
        });

        child.on("close", () => {
            if (settled) {
                return;
            }

            clearTimeout(timeout);
            settled = true;

            try {
                const lines = output.trim().split(/\r?\n/).filter(Boolean);
                const parsed = JSON.parse(lines[lines.length - 1] || "{}");
                resolve(parsed);
            } catch {
                resolve({
                    status: "error",
                    failures: [{
                        reason: errorOutput || "invalid service response"
                    }]
                });
            }
        });

        const payload = {
            command: "verify_hashes",
            files: serviceFiles.map(({ entry, resolved }) => {
                return {
                    path: resolved.fullPath,
                    displayPath: entry.path,
                    sha256: entry.sha256,
                    optional: Boolean(entry.optional)
                };
            })
        };

        child.stdin.write(`${JSON.stringify(payload)}\n`);
        child.stdin.end();
    });
}

function verifyBackendTrust(manifest) {
    const backend = manifest.backendTrust || {};

    if (!backend.required) {
        return {
            status: "not-required"
        };
    }

    const token = process.env.BLACKSHIELD_BACKEND_TRUST_TOKEN || "";

    if (!token) {
        return {
            status: "missing",
            reason: "backend trust token not available"
        };
    }

    const actual = crypto.createHash("sha256").update(token).digest("hex");
    const expected = String(backend.tokenSha256 || "").toLowerCase();

    if (actual !== expected) {
        return {
            status: "invalid",
            reason: "backend trust token mismatch"
        };
    }

    return {
        status: "valid"
    };
}

function verifyManagedModules() {
    const modulesDir = path.join(getUserDataDir(), "modules");
    const stateFile = path.join(getUserDataDir(), "updater", "component_versions.json");
    const failures = [];

    if (!fs.existsSync(stateFile)) {
        return {
            status: "no-components",
            failures
        };
    }

    let state;

    try {
        state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch {
        return {
            status: "invalid-state",
            failures: [{
                reason: "component version state is unreadable"
            }]
        };
    }

    Object.values(state.components || {}).forEach((component) => {
        const installPath = component && component.installPath;

        if (!installPath) {
            return;
        }

        try {
            ensureInside(modulesDir, installPath);
        } catch (error) {
            failures.push({
                id: component.id,
                reason: error.message
            });
            return;
        }

        if (!fs.existsSync(installPath)) {
            failures.push({
                id: component.id,
                reason: "component install path missing"
            });
            return;
        }

        (component.fileIntegrity || []).forEach((entry) => {
            const target = ensureInside(installPath, path.join(installPath, entry.path));
            const actual = fs.existsSync(target) ? sha256File(target) : "";

            if (actual !== entry.sha256) {
                failures.push({
                    id: component.id,
                    path: entry.path,
                    reason: "component hash mismatch"
                });
            }
        });
    });

    return {
        status: failures.length > 0 ? "invalid" : "valid",
        failures
    };
}

function enterProtectedMode(reason, details) {
    protectedMode = true;
    log.warn("[integrity] Protected mode enabled:", reason, details);

    emitState({
        status: "invalid",
        protectedMode: true,
        reason,
        details,
        checkedAt: new Date().toISOString()
    });
}

async function verifyStartupIntegrity() {
    const manifestPath = getManifestPath();

    try {
        emitState({
            status: "checking",
            manifestPath,
            checkedAt: new Date().toISOString()
        });

        const manifest = readManifest(manifestPath);
        const signature = verifyManifestSignature(manifest);
        const nodeResult = verifyFilesInNode(manifest.files);
        const serviceResult = await verifyWithPythonService(manifest.files);
        const moduleResult = verifyManagedModules();
        const backendTrust = verifyBackendTrust(manifest);

        const details = [
            ...nodeResult.failures,
            ...((serviceResult.failures || []).map((failure) => ({
                ...failure,
                source: "python-integrity-service"
            }))),
            ...moduleResult.failures
        ];

        if (backendTrust.status === "invalid" || backendTrust.status === "missing") {
            details.push({
                source: "backend-trust",
                reason: backendTrust.reason
            });
        }

        if (serviceResult.status === "missing" && app.isPackaged) {
            details.push({
                source: "python-integrity-service",
                reason: "integrity service missing"
            });
        }

        if (details.length > 0) {
            enterProtectedMode("Runtime integrity verification failed", details);
        } else {
            protectedMode = false;
            emitState({
                status: "valid",
                protectedMode: false,
                integrityId: manifest.integrityId,
                buildSignature: manifest.buildSignature || signature.status,
                reason: "",
                details: [],
                backendTrust,
                service: {
                    status: serviceResult.status || "valid"
                },
                checkedAt: new Date().toISOString()
            });
        }
    } catch (error) {
        enterProtectedMode(error.message, [{
            reason: error.message
        }]);
    }

    return getIntegrityState();
}

function getIntegrityState() {
    return clone(integrityState);
}

function isProtectedMode() {
    return protectedMode;
}

function onStateChange(callback) {
    events.on("state", callback);

    return () => {
        events.removeListener("state", callback);
    };
}

function createProtectedServicesError() {
    const error = new Error("Protected services are disabled until BlackShield X is repaired.");
    error.code = "BLACKSHIELD_PROTECTED_MODE";
    return error;
}

function quarantineManagedRuntime() {
    const userData = getUserDataDir();
    const modulesDir = path.join(userData, "modules");
    const quarantineDir = path.join(userData, "quarantine", `runtime-${Date.now()}`);

    fs.mkdirSync(quarantineDir, {
        recursive: true,
        mode: 0o700
    });

    if (fs.existsSync(modulesDir)) {
        const marker = path.join(modulesDir, ".blackshield-managed");

        if (fs.existsSync(marker)) {
            fs.renameSync(modulesDir, path.join(quarantineDir, "modules"));
        }
    }

    return {
        quarantineDir
    };
}

module.exports = {
    verifyStartupIntegrity,
    getIntegrityState,
    isProtectedMode,
    onStateChange,
    createProtectedServicesError,
    quarantineManagedRuntime
};
