const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const electronRoot = path.join(repoRoot, "electron");
const sourceDir = path.join(electronRoot, "dist", "win-unpacked");
const outputDir = path.join(electronRoot, "installer", "runtime");
const outputZip = path.join(outputDir, "blackshield-runtime.zip");

function getAdmZip() {
    return require(path.join(electronRoot, "node_modules", "adm-zip"));
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
            results.push(...walk(fullPath));
            return;
        }

        if (entry.isFile()) {
            results.push(fullPath);
        }
    });

    return results;
}

function packageRuntime() {
    if (!fs.existsSync(sourceDir)) {
        throw new Error(`Packaged runtime missing. Run npm run dist first: ${sourceDir}`);
    }

    const AdmZip = getAdmZip();
    const zip = new AdmZip();

    walk(sourceDir).forEach((filePath) => {
        const relative = path.relative(sourceDir, filePath).replace(/\\/g, "/");
        const zipDirectory = path.posix.dirname(relative);
        zip.addLocalFile(filePath, zipDirectory === "." ? "" : zipDirectory);
    });

    fs.mkdirSync(outputDir, {
        recursive: true
    });
    zip.writeZip(outputZip);

    const digest = sha256(outputZip);
    fs.writeFileSync(`${outputZip}.sha256`, `${digest}  blackshield-runtime.zip\n`);

    console.log(`Runtime package: ${outputZip}`);
    console.log(`SHA256: ${digest}`);

    return {
        outputZip,
        sha256: digest
    };
}

if (require.main === module) {
    try {
        packageRuntime();
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = packageRuntime;
