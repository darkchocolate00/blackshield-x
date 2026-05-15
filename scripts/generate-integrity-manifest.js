const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const electronRoot = path.join(repoRoot, "electron");
const outputPath = path.join(electronRoot, "security", "integrity-manifest.json");

const INCLUDE_DIRS = [
    "installer",
    "renderer",
    "security",
    "styles",
    "updater",
    "views"
];

const INCLUDE_FILES = [
    "main.js",
    "preload.js",
    "package.json"
];

const EXCLUDED_NAMES = new Set([
    "integrity-manifest.json"
]);

const EXCLUDED_EXTENSIONS = new Set([
    ".7z",
    ".blockmap",
    ".exe",
    ".sha256",
    ".zip"
]);

const EXCLUDED_DIRECTORIES = new Set([
    "local-signing"
]);

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

function sha256(filePath) {
    return crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
}

function walk(directory) {
    const results = [];

    fs.readdirSync(directory, {
        withFileTypes: true
    }).forEach((entry) => {
        const fullPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            if (EXCLUDED_DIRECTORIES.has(entry.name)) {
                return;
            }

            results.push(...walk(fullPath));
            return;
        }

        if (
            entry.isFile() &&
            !EXCLUDED_NAMES.has(entry.name) &&
            !EXCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
            results.push(fullPath);
        }
    });

    return results;
}

function collectFiles() {
    const files = [];

    INCLUDE_FILES.forEach((fileName) => {
        files.push(path.join(electronRoot, fileName));
    });

    INCLUDE_DIRS.forEach((directory) => {
        const fullPath = path.join(electronRoot, directory);

        if (fs.existsSync(fullPath)) {
            files.push(...walk(fullPath));
        }
    });

    return files
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => {
            return {
                root: "app",
                path: path.relative(electronRoot, filePath).replace(/\\/g, "/"),
                sha256: sha256(filePath)
            };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
}

function optionalResourceFiles() {
    const pythonEngine = path.join(repoRoot, "python-engine", "dist", "engine.exe");

    if (!fs.existsSync(pythonEngine)) {
        return [];
    }

    return [{
        root: "resources",
        path: "python-engine/engine.exe",
        sha256: sha256(pythonEngine),
        optional: true
    }];
}

function signManifest(manifest) {
    const privateKey = process.env.BLACKSHIELD_INTEGRITY_PRIVATE_KEY || "";

    if (!privateKey) {
        return {
            ...manifest,
            signed: false,
            signature: ""
        };
    }

    const payload = {
        ...manifest,
        signed: true,
        signature: ""
    };
    delete payload.signature;

    const signature = crypto.sign(
        null,
        Buffer.from(stableStringify(payload), "utf8"),
        privateKey
    );

    return {
        ...manifest,
        signed: true,
        signature: signature.toString("base64")
    };
}

const backendToken = process.env.BLACKSHIELD_BACKEND_TRUST_TOKEN || "";

const manifest = {
    schemaVersion: 1,
    product: "BlackShield X",
    integrityId: `bsx-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`,
    buildSignature: process.env.BLACKSHIELD_BUILD_SIGNATURE || "development-unsigned",
    buildChannel: process.env.BLACKSHIELD_UPDATE_CHANNEL || "latest",
    hashAlgorithm: "sha256",
    signatureAlgorithm: "ed25519",
    signed: false,
    signature: "",
    backendTrust: {
        required: Boolean(backendToken),
        tokenSha256: backendToken
            ? crypto.createHash("sha256").update(backendToken).digest("hex")
            : ""
    },
    files: [
        ...collectFiles(),
        ...optionalResourceFiles()
    ]
};

const finalManifest = signManifest(manifest);

fs.mkdirSync(path.dirname(outputPath), {
    recursive: true
});
fs.writeFileSync(outputPath, `${JSON.stringify(finalManifest, null, 2)}\n`);

console.log(`Generated ${outputPath}`);
console.log(`Files: ${finalManifest.files.length}`);
console.log(`Signed: ${finalManifest.signed}`);
