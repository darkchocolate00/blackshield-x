const fs = require("fs");
const path = require("path");
const { Arch, Platform, build } = require("../electron/node_modules/electron-builder");

const repoRoot = path.resolve(__dirname, "..");
const electronRoot = path.join(repoRoot, "electron");
const runtimeDir = path.join(electronRoot, "dist", "win-unpacked");

async function buildCustomInstaller() {
    if (!fs.existsSync(runtimeDir)) {
        throw new Error(`Packaged runtime missing. Run npm run app:dist first: ${runtimeDir}`);
    }

    await build({
        projectDir: electronRoot,
        targets: Platform.WINDOWS.createTarget(["portable"], Arch.x64),
        config: {
            appId: "com.blackshieldx.installer",
            productName: "BlackShield X Installer",
            directories: {
                output: "installer-upload",
                buildResources: "build"
            },
            files: [
                "installer/**",
                "assets/icon.ico",
                "assets/icon.png",
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
                    from: "dist/win-unpacked",
                    to: "runtime",
                    filter: [
                        "**/*"
                    ]
                }
            ],
            win: {
                target: ["portable"],
                icon: "assets/icon.ico",
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
