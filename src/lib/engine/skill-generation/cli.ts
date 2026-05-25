import { generateSkillStream } from "./index";
import { SkillSpec } from "./types";
import dotenv from "dotenv";
import { createLogger } from "@/lib/logger";

const logger = createLogger("skill-generation:cli");

dotenv.config();

/**
 * CLI Entry point for Skill Generation
 * 
 * Usage: node --import tsx src/lib/engine/skill-generation/cli.ts
 */
async function main() {
  const spec: SkillSpec = {
    name: "demo-skill",
    intent: "创建一个简单的演示技能，用于在控制台打印 Hello World",
    triggerScenarios: ["用户想要演示", "测试系统功能"],
    expectedOutput: "一个能够成功运行并输出 Hello World 的 SKILL.md 文件",
    testCases: [
      {
        prompt: "运行演示技能",
        expectations: ["输出包含 Hello World"]
      }
    ],
  };

  const modelOptions = {
    modelId: process.env.MODEL_ID || "deepseek-chat",
    apiKey: process.env.API_KEY || process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.BASE_URL || "https://api.deepseek.com",
  };

  if (!modelOptions.apiKey) {
    logger.warn("API key is missing for skill generation CLI");
    console.warn("⚠️  Warning: API_KEY or DEEPSEEK_API_KEY is not set in environment variables.");
    console.warn("Please set them in .env or provide them via command line.\n");
  }

  console.log("\n🚀 Starting Skill Generation...");
  logger.log("CLI skill generation started", {
    skillName: spec.name,
    modelId: modelOptions.modelId,
    baseUrl: modelOptions.baseUrl,
    hasApiKey: Boolean(modelOptions.apiKey),
  });
  console.log("------------------------------------------");
  console.log(`Target Skill: ${spec.name}`);
  console.log(`Intent: ${spec.intent}`);
  console.log("------------------------------------------\n");

  try {
    const stream = generateSkillStream(spec, modelOptions);

    for await (const chunk of stream) {
      // Debug: Log the chunk structure if it's not what we expect
      // console.log("DEBUG CHUNK:", JSON.stringify(chunk, null, 2));

      // Handle both [mode, data] and { mode: data } formats
      let mode: string | undefined;
      let data: any;

      if (Array.isArray(chunk)) {
        [mode, data] = chunk;
      } else {
        const entries = Object.entries(chunk);
        if (entries.length > 0) {
          [mode, data] = entries[0];
        }
      }

      if (mode === "updates") {
        logger.debug("Received updates chunk", {
          nodeCount: Object.keys((data as Record<string, any>) || {}).length,
        });
        for (const [nodeName, update] of Object.entries(data as Record<string, any>)) {
          console.log(`\n📍 [Node]: ${nodeName}`);
          const up = update as any;
          if (up.status) console.log(`   ⚙️ Status: ${up.status}`);
          if (up.iteration !== undefined) console.log(`   🔄 Iteration: ${up.iteration}`);
          if (up.decision) console.log(`   ⚖️ Decision: ${up.decision}`);
          
          // Show messages from the nodes
          const msgs = up.generatorMessages || up.evaluatorMessages;
          if (msgs && Array.isArray(msgs)) {
            const lastMsg = msgs[msgs.length - 1];
            if (lastMsg && lastMsg.content) {
              const content = lastMsg.content.toString();
              if (content.trim()) {
                console.log(`\n💬 [Agent]: ${content.slice(0, 500)}${content.length > 500 ? "..." : ""}`);
              }
            }
          }
        }
      } else if (mode === "values") {
        logger.debug("Received values chunk", { hasStatus: Boolean((data as any)?.status) });
        if (data.status) {
          process.stdout.write(`\r   ⚙️ Current Status: ${data.status}`);
        }
      } else if (mode === "messages") {
        logger.debug("Received messages chunk", { messageCount: (data as any[])?.length ?? 0 });
        const msgs = data as any[];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.content) {
          const content = lastMsg.content.toString();
          if (content.trim()) {
            console.log(`\n💬 [Message]: ${content.slice(0, 150)}${content.length > 150 ? "..." : ""}`);
          }
        }
      }
    }

    console.log("\n------------------------------------------");
    console.log("✅ Skill Generation Completed Successfully!");
    logger.log("CLI skill generation completed", { skillName: spec.name });
  } catch (error) {
    logger.error("CLI skill generation failed", {
      error: (error as Error).message,
    });
    console.error("\n❌ Error during Skill Generation:");
    console.error(error);
    process.exit(1);
  }
}

main().catch(console.error);
