import { fileURLToPath } from "node:url";
const addonPath0 = fileURLToPath(new URL("../native/pi_natives.linux-x64-modern.node", import.meta.url));
const workerPath = fileURLToPath(new URL("../native/pi-embedding-worker", import.meta.url));
export const embeddedAddon = {
    platformTag: "linux-x64",
    version: "13.12.8",
    files: [{ variant: "modern", filename: "pi_natives.linux-x64-modern.node", filePath: addonPath0 }],
    worker: { filename: "pi-embedding-worker", filePath: workerPath },
};
//# sourceMappingURL=embedded-addon.js.map