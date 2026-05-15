const fs = require("fs");
const path = require("path");
const { Arch, Platform, build } = require("../electron/node_modules/electron-builder");

const packageRuntime = require("./package-runtime");

const repoRoot = path.resolve(__dirname, "..");
const electronRoot = path.join(repoRoot, "electron");
const runtimeZip = path.join(electronRoot, "installer", "runtime", "blackshield-runtime.zip");

async function buildCustomInstaller() {
    if (!fs.existsSync(runtimeZip)) {
        packageRuntime();
    }

    await build({
        projectDir: electronRoot,
        targets: Platform.WINDOWS.createTarget(["portable"], Arch.x64),
        config: {
            appId: "com.blackshieldx.installer",
            productName: "BlackShield X Installer",
            directories: {
                output: "installer-dist",
                buildResources: "build"
            },
            files: [
                "installer/**",
                "package.json",
                "!installer/runtime/**",
                "!dist/**",
                "!installer-dist/**",
                "!updates/**",
                "!modules/**",
                "!profile/**",
                "!**/*.map"
            ],
            extraMetadata: {
                name: "blackshieldx-installer",
                main: "installer/installer-main.js"
            },
            extraResources: [
                {
                    from: "installer/runtime/blackshield-runtime.zip",
                    to: "runtime/blackshield-runtime.zip"
                },
                {
                    from: "installer/runtime/blackshield-runtime.zip.sha256",
                    to: "runtime/blackshield-runtime.zip.sha256"
                }
            ],
            win: {
                target: ["portable"],
                requestedExecutionLevel: "requireAdministrator"
            },
            portable: {
                artifactName: "BlackShield-X-Installer-${version}.${ext}"
            },
            npmRebuild: false
        }
    });
}

if (require.main === module) {
    buildCustomInstaller().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = buildCustomInstaller;
