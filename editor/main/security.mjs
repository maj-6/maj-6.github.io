import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const DEVELOPMENT_HOST = "127.0.0.1";
const DEVELOPMENT_PORT = "5173";

export function isAllowedDevelopmentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && url.hostname === DEVELOPMENT_HOST
      && url.port === DEVELOPMENT_PORT
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

export function isTrustedRendererUrl(value, developmentUrl = "") {
  try {
    const url = new URL(value);
    if (url.protocol === "whl-editor:" && url.host === "app") return true;
    if (!isAllowedDevelopmentUrl(developmentUrl)) return false;
    const allowedOrigin = new URL(developmentUrl).origin;
    return url.origin === allowedOrigin
      && url.username === ""
      && url.password === "";
  } catch {
    return false;
  }
}

export function isPathInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return pathFromRoot === ""
    || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

/**
 * Resolves an application-protocol request without allowing encoded traversal
 * or symlink escapes. Returning null deliberately conflates missing and denied
 * paths so the protocol does not disclose the host filesystem.
 */
export function resolveRendererAsset(
  rendererRoot,
  requestPath,
  fileSystem = { existsSync, realpathSync }
) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  if (decodedPath.includes("\0")) return null;

  const relativePath = decodedPath.replace(/^[/\\]+/, "") || "index.html";
  const lexicalCandidate = resolve(rendererRoot, relativePath);
  if (!isPathInside(rendererRoot, lexicalCandidate) || !fileSystem.existsSync(lexicalCandidate)) {
    return null;
  }

  try {
    const realRoot = fileSystem.realpathSync(rendererRoot);
    const realCandidate = fileSystem.realpathSync(lexicalCandidate);
    return isPathInside(realRoot, realCandidate) ? realCandidate : null;
  } catch {
    return null;
  }
}
