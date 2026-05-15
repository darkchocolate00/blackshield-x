const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const electronRoot = path.join(repoRoot, "electron");
const packagePath = path.join(electronRoot, "package.json");
const keyDir = path.join(electronRoot, "security", "local-signing");
const privateKeyPath = path.join(keyDir, "integrity-private.pem");
const publicKeyPath = path.join(keyDir, "integrity-public.pem");

function ensureLocalKeyPair() {
    fs.mkdirSync(keyDir, {
        recursive: true,
        mode: 0o700
    });

    if (fs.existsSync(privateKeyPath) && fs.existsSync(publicKeyPath)) {
        return {
            privateKeyPem: fs.readFileSync(privateKeyPath, "utf8"),
            publicKeyPem: fs.readFileSync(publicKeyPath, "utf8"),
            source: "local-existing"
        };
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({
        type: "pkcs8",
        format: "pem"
    });
    const publicKeyPem = publicKey.export({
        type: "spki",
        format: "pem"
    });

    fs.writeFileSync(privateKeyPath, privateKeyPem, {
        mode: 0o600
    });
    fs.writeFileSync(publicKeyPath, publicKeyPem, {
        mode: 0o644
    });

    return {
        privateKeyPem,
        publicKeyPem,
        source: "local-generated"
    };
}

function loadSigningKeys() {
    const envPrivate = process.env.BLACKSHIELD_INTEGRITY_PRIVATE_KEY || "";
    const envPublic = process.env.BLACKSHIELD_INTEGRITY_PUBLIC_KEY || "";

    if (envPrivate && envPublic) {
        return {
            privateKeyPem: envPrivate.replace(/\\n/g, "\n"),
            publicKeyPem: envPublic.replace(/\\n/g, "\n"),
            source: "environment"
        };
    }

    return ensureLocalKeyPair();
}

function updatePackagePublicKey(publicKeyPem) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));

    packageJson.build = packageJson.build || {};
    packageJson.build.extraMetadata = packageJson.build.extraMetadata || {};
    packageJson.build.extraMetadata.blackshield = packageJson.build.extraMetadata.blackshield || {};
    packageJson.build.extraMetadata.blackshield.integrityPublicKeyPem = publicKeyPem;

    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
}

function generateManifest(privateKeyPem) {
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "generate-integrity-manifest.js")], {
        cwd: electronRoot,
        env: {
            ...process.env,
            BLACKSHIELD_INTEGRITY_PRIVATE_KEY: privateKeyPem,
            BLACKSHIELD_BUILD_SIGNATURE: process.env.BLACKSHIELD_BUILD_SIGNATURE || "local-signed-build"
        },
        encoding: "utf8"
    });

    if (result.stdout) {
        process.stdout.write(result.stdout);
    }

    if (result.stderr) {
        process.stderr.write(result.stderr);
    }

    if (result.status !== 0) {
        throw new Error(`Integrity manifest generation failed with code ${result.status}`);
    }
}

function prepareSignedIntegrity() {
    const keys = loadSigningKeys();

    updatePackagePublicKey(keys.publicKeyPem);
    generateManifest(keys.privateKeyPem);

    console.log(`Integrity signing key: ${keys.source}`);
    return keys;
}

if (require.main === module) {
    try {
        prepareSignedIntegrity();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = prepareSignedIntegrity;
