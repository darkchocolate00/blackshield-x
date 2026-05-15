const path = require("path");
const { spawn } = require("child_process");

const packageRuntime = require("./package-runtime");
const prepareSignedIntegrity = require("./prepare-signed-integrity");

const repoRoot = path.resolve(__dirname, "..");
const electronRoot = path.join(repoRoot, "electron");
const builderCli = path.join(electronRoot, "node_modules", "electron-builder", "cli.js");
const distRoot = path.join(electronRoot, "dist");

function cleanStaleInstallerArtifacts() {
    if (!require("fs").existsSync(distRoot)) {
        return;
    }

    require("fs").readdirSync(distRoot, {
        withFileTypes: true
    }).forEach((entry) => {
        if (!entry.isFile()) {
            return;
        }

        const isBlackShieldArtifact = /^BlackShield.*\.(exe|blockmap)$/i.test(entry.name) ||
            /^blackshieldx-.*\.7z$/i.test(entry.name);
        const isLatestMetadata = entry.name === "latest.yml";

        if (isBlackShieldArtifact || isLatestMetadata) {
            require("fs").rmSync(path.join(distRoot, entry.name), {
                force: true
            });
        }
    });
}

function runBuilder(args) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [builderCli, ...args], {
            cwd: electronRoot,
            env: process.env,
            stdio: "inherit",
            windowsHide: false
        });

        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(`electron-builder exited with code ${code}`));
        });
    });
}

async function buildDist(args = []) {
    prepareSignedIntegrity();
    cleanStaleInstallerArtifacts();
    await runBuilder(args);
    packageRuntime();
}

if (require.main === module) {
    buildDist(process.argv.slice(2)).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = buildDist;
