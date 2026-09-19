import path from "node:path";
import { Comfy } from "@comfyorg/sdk";
import { config } from "./config";
import { log } from "./logger";

log.info(
  `ComfyUI client ready — baseUrl: ${config.comfy.baseUrl ?? "Comfy Cloud"}, workflow: ${config.comfy.workflowPath}`,
);
log.info(
  `Workflow inputs — style node: ${config.comfy.styleNodeId}.${config.comfy.styleFieldName}, lyrics node: ${config.comfy.lyricsNodeId}.${config.comfy.lyricsFieldName}, output node: ${config.comfy.outputNodeId || "(any)"}`,
);

/**
 * Wrap the SDK's fetch to rewrite http:// URLs to https:// in job responses.
 * This fixes the case where the v2 API server advertises http:// URLs but is
 * behind an HTTPS-terminating reverse proxy (Caddy, nginx, etc.).
 */
function patchHttpToHttps(baseUrl: string | undefined): typeof fetch {
  const shouldPatch = baseUrl?.startsWith("https://") ?? false;
  const origFetch = globalThis.fetch.bind(globalThis);

  if (!shouldPatch) {
    return origFetch as typeof fetch;
  }

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await origFetch(input, init);
    // Only patch JSON responses from the v2 API
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
    if (!url.includes("/api/v2/")) {
      return response;
    }

    // Clone so we can read the body
    const cloned = response.clone();
    try {
      const text = await cloned.text();
      if (!text) return response;

      // Rewrite http:// to https:// in URLs (urls.self, urls.events, etc.)
      const patched = text.replace(
        /"url"\s*:\s*"http:\/\//g,
        '"url":"https://',
      );
      // Also rewrite urls.* fields directly (self, events, cancel, logs)
      const patched2 = patched.replace(
        /"(self|events|cancel|logs|workflow)"\s*:\s*"http:\/\//g,
        '"$1":"https://',
      );
      if (patched2 === text) return response;

      log.debug(`Patched http:// to https:// in response from ${url.split("?")[0]}`);
      return new Response(patched2, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch {
      return response;
    }
  };

  // Copy Bun-specific fetch properties
  (wrapped as typeof fetch).preconnect = (globalThis.fetch as typeof fetch).preconnect?.bind(globalThis.fetch);
  return wrapped as typeof fetch;
}

const client = new Comfy({
  apiKey: config.comfy.apiKey,
  fetch: patchHttpToHttps(config.comfy.baseUrl),
});

export interface SongResult {
  /** Path to the downloaded audio file. */
  filePath: string;
  /** Job id, for logging. */
  jobId: string;
}

/**
 * All generateSong calls are serialized through this chain: ComfyUI can only
 * run one job at a time, so concurrent requests wait here instead of racing.
 */
let generationChain: Promise<unknown> = Promise.resolve();

/**
 * Run the configured ComfyUI workflow with the given style + lyrics,
 * wait for it to finish, and download the first audio output.
 * Calls are queued up one-at-a-time (see generationChain).
 */
export function generateSong(style: string, lyrics: string): Promise<SongResult> {
  const run = generationChain.then(() => runWorkflow(style, lyrics));
  // Keep the chain alive even if a run fails.
  generationChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runWorkflow(style: string, lyrics: string): Promise<SongResult> {
  const start = Date.now();
  log.info(`Loading workflow from ${config.comfy.workflowPath}...`);
  const wf = await client.workflows.fromFile(config.comfy.workflowPath);

  wf.setInput(config.comfy.styleNodeId, config.comfy.styleFieldName, style);
  wf.setInput(config.comfy.lyricsNodeId, config.comfy.lyricsFieldName, lyrics);

  if (config.comfy.seedNodeId) {
    const seed = Math.floor(Math.random() * 2_147_483_647); // 32-bit signed int range
    wf.setInput(config.comfy.seedNodeId, config.comfy.seedFieldName, seed);
    log.debug(`Set random seed: ${seed} (node ${config.comfy.seedNodeId}.${config.comfy.seedFieldName})`);
  }

  log.info(
    `Submitting workflow — style: "${style}", lyrics: ${lyrics.length} chars`,
  );

  const job = await client.run(wf, { timeoutMs: config.comfy.runTimeoutMs });
  log.info(`Job finished — id: ${job.id ?? "?"}, elapsed: ${Date.now() - start}ms`);

  const outputs = config.comfy.outputNodeId
    ? job.getOutputs(config.comfy.outputNodeId)
    : job.outputs;
  const audio = outputs.find((o) => o.type === "audio") ?? outputs[0];
  if (!audio) {
    throw new Error("ComfyUI job produced no outputs");
  }

  log.info(
    `Downloading output — node: ${audio.nodeId}, name: ${audio.name}, type: ${audio.type}, size: ${audio.sizeBytes} bytes`,
  );
  const filePath = path.join(config.outputDir, `${audio.jobId ?? "song"}-${audio.name}`);
  await audio.toFile(filePath);
  log.info(`Saved audio to ${filePath}`);

  return { filePath, jobId: audio.jobId ?? "unknown" };
}
