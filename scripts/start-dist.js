const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const exePath = path.join(repoRoot, "electron", "dist", "win-unpacked", "BlackShield X.exe");
const quitAfterArg = process.argv.find((arg) => arg.startsWith("--quit-after="));
const quitAfterMs = quitAfterArg ? quitAfterArg.split("=").slice(1).join("=") : "";
const appArgs = quitAfterMs ? [`--blackshield-test-quit-after=${quitAfterMs}`] : [];

if (!fs.existsSync(exePath)) {
    console.error(`Packaged app missing. Run npm run dist first: ${exePath}`);
    process.exit(1);
}

const child = spawn(exePath, appArgs, {
    cwd: path.dirname(exePath),
    env: {
        ...process.env,
        BLACKSHIELD_ALLOW_UNSIGNED_PACKAGED: "1",
        ...(quitAfterMs ? { BLACKSHIELD_TEST_QUIT_AFTER_MS: quitAfterMs } : {})
    },
    stdio: "inherit",
    windowsHide: false
});

child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
});

child.on("exit", (code) => {
    process.exitCode = code || 0;
});
