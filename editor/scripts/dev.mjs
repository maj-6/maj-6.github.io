import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const editorRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const executable = (name) => resolve(
  editorRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? `${name}.cmd` : name
);

const children = new Set();
let shuttingDown = false;

function launch(command, args, environment = process.env) {
  const child = spawn(command, args, {
    cwd: editorRoot,
    env: environment,
    shell: false,
    stdio: "inherit"
  });
  children.add(child);
  child.once("exit", (code) => {
    children.delete(child);
    if (!shuttingDown && code) shutdown(code);
  });
  return child;
}

function waitForPort(port, host = "127.0.0.1", attempts = 100) {
  return new Promise((resolveReady, reject) => {
    const tryConnect = (remaining) => {
      const socket = createConnection({ port, host });
      socket.once("connect", () => {
        socket.destroy();
        resolveReady();
      });
      socket.once("error", () => {
        socket.destroy();
        if (remaining <= 0) reject(new Error(`Vite did not open ${host}:${port}`));
        else setTimeout(() => tryConnect(remaining - 1), 100);
      });
    };
    tryConnect(attempts);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  children.forEach((child) => child.kill());
  setTimeout(() => process.exit(exitCode), 50).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const vite = launch(executable("vite"), ["--host", "127.0.0.1", "--port", "5173", "--strictPort"]);

try {
  await waitForPort(5173);
  const electron = launch(executable("electron"), ["."], {
    ...process.env,
    WHL_EDITOR_DEV_SERVER_URL: "http://127.0.0.1:5173"
  });
  electron.once("exit", (code) => shutdown(code || 0));
  vite.once("exit", (code) => shutdown(code || 0));
} catch (error) {
  console.error(error.message);
  shutdown(1);
}
