(() => {
    "use strict";

    const screens = Array.from(document.querySelectorAll(".screen"));
    const steps = Array.from(document.querySelectorAll(".step"));
    const backBtn = document.getElementById("backBtn");
    const nextBtn = document.getElementById("nextBtn");
    const closeBtn = document.getElementById("closeBtn");
    const installPath = document.getElementById("installPath");
    const choosePathBtn = document.getElementById("choosePathBtn");
    const pathStatus = document.getElementById("pathStatus");
    const progressFill = document.getElementById("progressFill");
    const progressText = document.getElementById("progressText");
    const installTitle = document.getElementById("installTitle");
    const completeText = document.getElementById("completeText");

    let currentStep = 0;
    let runtimeMode = "install";

    function setStep(index) {
        currentStep = Math.max(0, Math.min(index, screens.length - 1));

        screens.forEach((screen, screenIndex) => {
            screen.classList.toggle("active", screenIndex === currentStep);
        });

        steps.forEach((step, stepIndex) => {
            step.classList.toggle("active", stepIndex === currentStep);
        });

        backBtn.disabled = currentStep === 0;
        nextBtn.textContent = currentStep === 4
            ? runtimeMode === "repair" ? "Repair" : "Install"
            : currentStep === 5 ? "Close" : "Continue";
    }

    async function inspectPath() {
        if (!window.installer) {
            pathStatus.textContent = "Installer bridge unavailable.";
            return;
        }

        try {
            const result = await window.installer.inspect(installPath.value);
            runtimeMode = result.mode;
            pathStatus.textContent = !result.runtimePackageReady
                ? `Runtime package missing. Run npm run runtime:zip or set BLACKSHIELD_RUNTIME_ZIP.`
                : result.exists
                ? "Existing runtime detected. Repair mode will preserve your profile and replace runtime files."
                : "Clean install path ready. Your profile will be created or reconnected in AppData.";
        } catch (error) {
            pathStatus.textContent = error.message;
        }
    }

    async function runInstall() {
        if (!window.installer) {
            progressText.textContent = "Installer bridge unavailable.";
            return;
        }

        installTitle.textContent = runtimeMode === "repair"
            ? "Repairing official runtime"
            : "Installing official runtime";
        progressFill.style.width = "0%";
        progressText.textContent = "Starting...";

        try {
            const result = await window.installer.install({
                mode: runtimeMode,
                installPath: installPath.value,
                components: {
                    python: document.getElementById("pythonComponent").checked,
                    rust: document.getElementById("rustComponent").checked
                }
            });

            progressFill.style.width = "100%";
            progressText.textContent = "Complete.";
            completeText.textContent = `Runtime installed at ${result.installPath}. Profile preserved at ${result.userDataPath}.`;
            setStep(5);
        } catch (error) {
            progressText.textContent = error.message;
        }
    }

    if (window.installer) {
        window.installer.onProgress((progress) => {
            progressFill.style.width = `${progress.percent}%`;
            progressText.textContent = progress.message;
        });
    }

    backBtn.addEventListener("click", () => setStep(currentStep - 1));

    nextBtn.addEventListener("click", async () => {
        if (currentStep === 5) {
            window.installer.close();
            return;
        }

        if (currentStep === 2) {
            await inspectPath();
        }

        if (currentStep === 4) {
            await runInstall();
            return;
        }

        setStep(currentStep + 1);
    });

    choosePathBtn.addEventListener("click", async () => {
        if (!window.installer) {
            return;
        }

        const chosenPath = await window.installer.choosePath();

        if (chosenPath) {
            installPath.value = chosenPath;
            await inspectPath();
        }
    });

    installPath.addEventListener("change", inspectPath);

    closeBtn.addEventListener("click", () => {
        if (window.installer) {
            window.installer.close();
        }
    });

    setStep(0);
    inspectPath();
})();
