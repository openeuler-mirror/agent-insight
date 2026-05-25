import { config as dotenvConfig } from "dotenv";
dotenvConfig({ override: true });
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

function cleanEnvValue(value: string | undefined, defaultValue: string): string {
  if (!value) return defaultValue;
  return value.replace(/^["']|["']$/g, "").trim() || defaultValue;
}

export const langfuseSpanProcessor = new LangfuseSpanProcessor({
  publicKey: cleanEnvValue(process.env.LANGFUSE_PUBLIC_KEY, ""),
  secretKey: cleanEnvValue(process.env.LANGFUSE_SECRET_KEY, ""),
  baseUrl: cleanEnvValue(process.env.LANGFUSE_BASE_URL, "https://cloud.langfuse.com"),
  environment: process.env.NODE_ENV ?? "development",
});

const sdk = new NodeSDK({
  spanProcessors: [langfuseSpanProcessor],
});

sdk.start();

process.on("SIGTERM", async () => {
  await langfuseSpanProcessor.forceFlush();
  process.exit(0);
});

process.on("SIGINT", async () => {
  await langfuseSpanProcessor.forceFlush();
  process.exit(0);
});