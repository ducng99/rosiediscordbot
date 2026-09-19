import path from "path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

export const config = {
  discordToken: required("DISCORD_BOT_TOKEN"),
  /** Optional: register slash commands to this guild only (instant, dev-friendly). */
  discordGuildId: optional("DISCORD_GUILD_ID"),

  openaiApiKey: required("OPENAI_API_KEY"),
  openaiBaseUrl: optional("OPENAI_BASE_URL"),
  openaiModel: optional("OPENAI_MODEL", "gpt-4o-mini")!,

  comfy: {
    /** API key — only needed for Comfy Cloud, not for the self-hosted proxy. */
    apiKey: optional("COMFY_API_KEY"),
    /** e.g. http://127.0.0.1:8189 (comfy-api-proxy). Unset = Comfy Cloud. */
    baseUrl: optional("COMFY_BASE_URL"),
    workflowPath: optional("COMFY_WORKFLOW_PATH", "workflow.json")!,
    /** Node ids / input field names in the API-format workflow. */
    styleNodeId: required("COMFY_STYLE_NODE_ID"),
    styleFieldName: optional("COMFY_STYLE_FIELD_NAME", "text")!,
    lyricsNodeId: required("COMFY_LYRICS_NODE_ID"),
    lyricsFieldName: optional("COMFY_LYRICS_FIELD_NAME", "text")!,
    seedNodeId: optional("COMFY_SEED_NODE_ID"),
    seedFieldName: optional("COMFY_SEED_FIELD_NAME", "seed")!,
    outputNodeId: optional("COMFY_OUTPUT_NODE_ID")!,
    /** Timeout for job completion (ms). */
    runTimeoutMs: Number(optional("COMFY_RUN_TIMEOUT_MS", "600000")),
  },

  outputDir: path.resolve(optional("OUTPUT_DIR", "output") ?? "output"),

  /** How long to stay in the voice channel after the queue empties (minutes). */
  voiceIdleMinutes: Number(optional("VOICE_IDLE_MINUTES", "10")),
};
