import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_DATA = path.resolve(import.meta.dirname, "..", "data");
const STATIC_FILES = ["quality.json", "banned-phrases.json", "tags.json", "stimuli.json"];

/** Crea un directorio data/ temporal con los ficheros de configuración reales del repo. */
export function makeTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agora-test-"));
  for (const sub of ["agents", "threads", "ticks", "digests"]) fs.mkdirSync(path.join(dir, sub));
  for (const f of STATIC_FILES) fs.copyFileSync(path.join(REPO_DATA, f), path.join(dir, f));
  return dir;
}
