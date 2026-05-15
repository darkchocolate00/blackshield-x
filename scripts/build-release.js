const buildApp = require("./build-dist");
const buildCustomInstaller = require("./build-custom-installer");

async function main() {
    await buildApp(process.argv.slice(2));
    await buildCustomInstaller();
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
