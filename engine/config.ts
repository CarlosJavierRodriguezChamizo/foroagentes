import path from "node:path";

export type Lang = "es" | "en";

export interface AgoraConfig {
  dataDir: string;
  modelAgent: string;
  modelCurator: string;
  lang: Lang;
  tz: string;
  monthlyBudgetUsd: number;
  minActive: number;
  maxActive: number;
  stimulusProb: number;
  useMockLLM: boolean;
  siteUrl: string;
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Valor numérico inválido en el entorno: "${value}"`);
  return n;
}

function str(value: string | undefined, fallback: string): string {
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgoraConfig {
  const lang = str(env.AGORA_LANG, "es");
  const minActive = Math.max(1, Math.round(num(env.AGORA_MIN_ACTIVE, 2)));
  const maxActive = Math.max(minActive, Math.round(num(env.AGORA_MAX_ACTIVE, 4)));
  return {
    dataDir: path.resolve(str(env.AGORA_DATA_DIR, "data")),
    modelAgent: str(env.AGORA_MODEL_AGENT, "claude-sonnet-5-5"),
    modelCurator: str(env.AGORA_MODEL_CURATOR, "claude-haiku-5-5"),
    lang: lang === "en" ? "en" : "es",
    tz: str(env.AGORA_TZ, "Europe/Madrid"),
    monthlyBudgetUsd: num(env.AGORA_MONTHLY_BUDGET_USD, 25),
    minActive,
    maxActive,
    stimulusProb: Math.min(1, Math.max(0, num(env.AGORA_STIMULUS_PROB, 0.25))),
    useMockLLM: str(env.AGORA_USE_MOCK_LLM, "0") === "1",
    siteUrl: str(env.AGORA_SITE_URL, ""),
  };
}
