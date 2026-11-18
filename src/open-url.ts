import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

function runCommand(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { env, windowsHide: true }, (error) => {
      if (error) reject(error);
      else resolve();
    });
    child.on("error", reject);
  });
}

export function isWsl(env: NodeJS.ProcessEnv = process.env, procVersionPath = "/proc/version"): boolean {
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(readFileSync(procVersionPath, "utf8"));
  } catch {
    return false;
  }
}

function openWithPowerShell(href: string, env: NodeJS.ProcessEnv): Promise<void> {
  const script = `Start-Process '${href.replaceAll("'", "''")}'`;
  return runCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], env);
}

export async function openUrl(url: URL | string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<void> {
  const href = url.toString();
  if (!/^https?:\/\//i.test(href)) {
    throw new Error("Refusing to open non-HTTP(S) URL");
  }
  if (platform === "win32") {
    await runCommand("rundll32.exe", ["url.dll,FileProtocolHandler", href], env);
    return;
  }
  if (platform === "darwin") {
    await runCommand("open", [href], env);
    return;
  }
  if (isWsl(env)) {
    try {
      await runCommand("wslview", [href], env);
      return;
    } catch { /* Fall back to PowerShell or xdg-open. */ }
    try {
      await openWithPowerShell(href, env);
      return;
    } catch { /* Fall back to xdg-open. */ }
  }
  await runCommand("xdg-open", [href], env);
}
