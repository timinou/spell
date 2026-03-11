import { $ } from "bun";

export interface AdbDevice {
  id: string;
  type: "device" | "emulator" | "unauthorized";
}

/** Returns true if `adb` is available in PATH. */
export function isAdbAvailable(): boolean {
  return Bun.which("adb") !== null;
}

/** Returns list of connected ADB devices. Empty array if none or adb fails. */
export async function getConnectedDevices(): Promise<AdbDevice[]> {
  try {
    const result = await $`adb devices`.quiet().nothrow();
    const lines = result.stdout.toString().split("\n");
    const devices: AdbDevice[] = [];

    // Skip the header line ("List of devices attached")
    for (const line of lines.slice(1)) {
      if (!line.includes("\t")) continue;
      const tabIdx = line.indexOf("\t");
      const id = line.slice(0, tabIdx).trim();
      const state = line.slice(tabIdx + 1).trim();
      if (!id) continue;

      let type: AdbDevice["type"];
      if (state === "device") {
        type = "device";
      } else if (state === "emulator") {
        type = "emulator";
      } else {
        type = "unauthorized";
      }

      // Only include usable devices
      if (type === "device" || type === "emulator") {
        devices.push({ id, type });
      }
    }

    return devices;
  } catch {
    return [];
  }
}

/** Returns true if Spell (io.ohmypi.spell) is installed on the device. */
export async function isSpellInstalled(deviceId?: string): Promise<boolean> {
  try {
    const result = deviceId
      ? await $`adb -s ${deviceId} shell pm list packages io.ohmypi.spell`.quiet().nothrow()
      : await $`adb shell pm list packages io.ohmypi.spell`.quiet().nothrow();
    return result.stdout.toString().includes("package:io.ohmypi.spell");
  } catch {
    return false;
  }
}

/** Installs the APK at apkPath. Returns true on success. */
export async function installApk(apkPath: string, deviceId?: string): Promise<boolean> {
  try {
    const result = deviceId
      ? await $`adb -s ${deviceId} install -r ${apkPath}`.quiet().nothrow()
      : await $`adb install -r ${apkPath}`.quiet().nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Sets up `adb reverse tcp:PORT tcp:PORT`. Returns true on success. */
export async function setupPortForward(port: number, deviceId?: string): Promise<boolean> {
  try {
    const portStr = String(port);
    const result = deviceId
      ? await $`adb -s ${deviceId} reverse tcp:${portStr} tcp:${portStr}`.quiet().nothrow()
      : await $`adb reverse tcp:${portStr} tcp:${portStr}`.quiet().nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Launches Spell via `adb shell am start`. Returns true on success. */
export async function launchSpell(deviceId?: string): Promise<boolean> {
  try {
    const result = deviceId
      ? await $`adb -s ${deviceId} shell am start -n io.ohmypi.spell/.MainActivity`.quiet().nothrow()
      : await $`adb shell am start -n io.ohmypi.spell/.MainActivity`.quiet().nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/** Removes Spell from device. Returns true on success. */
export async function uninstallSpell(deviceId?: string): Promise<boolean> {
  try {
    const result = deviceId
      ? await $`adb -s ${deviceId} uninstall io.ohmypi.spell`.quiet().nothrow()
      : await $`adb uninstall io.ohmypi.spell`.quiet().nothrow();
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
