import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });

function cleanEnvValue(value: string | undefined, defaultValue: string): string {
  if (!value) return defaultValue;
  return value.replace(/^["']|["']$/g, "").trim() || defaultValue;
}

const rawPublicKey = cleanEnvValue(process.env.LANGFUSE_PUBLIC_KEY, "");
const rawSecretKey = cleanEnvValue(process.env.LANGFUSE_SECRET_KEY, "");

export const config = {
  defaultModel: "claude-3-5-sonnet-20241022",
  maxIterations: 3,
  workspaceRoot: "./workspace/skills",
  evalRoot: "./workspace/evals",
  langfuse: {
    enabled: Boolean(rawPublicKey && rawSecretKey),
    publicKey: rawPublicKey,
    secretKey: rawSecretKey,
    baseUrl: cleanEnvValue(process.env.LANGFUSE_BASE_URL, "https://cloud.langfuse.com"),
  },
};
