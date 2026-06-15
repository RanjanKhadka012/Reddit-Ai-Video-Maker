import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(__dirname, "..");
export const dataRoot = process.env.RVM_DATA_DIR
  ? path.resolve(process.env.RVM_DATA_DIR)
  : appRoot;

export const backgroundsDir = path.join(dataRoot, "backgrounds");
export const rendersDir = path.join(dataRoot, "renders");
export const distDir = path.join(appRoot, "dist");

export function ensureDataDirs() {
  fs.mkdirSync(backgroundsDir, { recursive: true });
  fs.mkdirSync(rendersDir, { recursive: true });
}
