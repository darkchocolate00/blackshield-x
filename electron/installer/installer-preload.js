const { contextBridge, ipcRenderer } = require("electron");

function on(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("installer", {
    inspect: (installPath) => ipcRenderer.invoke("installer:inspect", installPath || ""),
    choosePath: () => ipcRenderer.invoke("installer:choose-path"),
    install: (options) => ipcRenderer.invoke("installer:install", options || {}),
    onProgress: (callback) => on("installer:progress", callback),
    close: () => ipcRenderer.send("installer:close")
});
