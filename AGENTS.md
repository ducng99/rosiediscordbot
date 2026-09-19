# Rosie Discord Bot

A Discord bot using ComfyUI API v2 to generate songs based on user input, then play them in voice channel.

## Environment

Windows with PowerShell 7 — use PowerShell syntax, not bash.

## Commands

```powershell
bun install           # install dependencies
bun run typecheck     # tsc --noEmit — the only check; no test suite or linter exists
bun start             # bun run index.ts — start the bot (requires .env, see .env.example)
$env:DEBUG = "1"; bun start   # enable verbose debug logging (logger.ts gates on DEBUG)
```

There are no tests, no lint script, and no build step (Bun runs TypeScript directly; `tsc` is typecheck-only via `noEmit`).

## What the bot does (request flow)

Requests come in two ways: a **mention** (`@Rosie <idea>`, always 1 song) or the **`/song` slash command** (`prompt` required, `count` 1–10 optional — generates `count` different songs and queues them all). Both go through `runSongRequest` in `src/song-request.ts`.

1. The requester **must be in a voice channel** or the request is rejected.
2. `src/lyrics.ts` calls OpenAI with a strict JSON-schema response (`{ style, lyrics }`) — a system prompt teaches the style/section-tag format the ComfyUI music model expects.
3. `src/comfy.ts` loads the API-format workflow file, injects style/lyrics text (and a random seed if configured) into configured nodes, runs the job via `@comfyorg/sdk` (Comfy API v2), downloads the first audio output to `OUTPUT_DIR` (default `output/`). All `generateSong` calls are serialized through a promise chain — ComfyUI can only run one job at a time, and multi-song requests must not run in parallel.
4. `src/queue.ts` enqueues the song per guild, joins the requester's voice channel, plays via `@discordjs/voice` (needs **ffmpeg** on PATH), and posts a "now playing" message with Pause/Resume, Skip, Stop buttons. In multi-song requests each finished song is enqueued immediately, so playback starts while the rest still generate.
5. Slash commands are registered in `bot.ts` on `ClientReady` — to `DISCORD_GUILD_ID` if set (instant, dev-friendly) or globally otherwise.

## Architecture notes

- **Per-guild queue pattern**: `getGuildQueue(guildId)` returns a `GuildQueue` from a module-level `Map`. Each queue owns its `AudioPlayer` + `VoiceConnection`. Auto-advance is driven by the player's `Idle` event; the `stopped` flag prevents `stop()` from triggering another advance. Queue empties → bot disconnects from voice.
- **Button contract**: all playback controls use `customId` prefixed `rosie:` (`rosie:toggle`, `rosie:skip`, `rosie:stop`). `bot.ts` handles the interaction and re-edits the message's components via `buildControls(isPaused)`.
- **Comfy workflow wiring is env-driven**: `COMFY_STYLE_NODE_ID` / `COMFY_LYRICS_NODE_ID` (+ optional `_FIELD_NAME`, `_SEED_NODE_ID`, `_OUTPUT_NODE_ID`) point at nodes in the API-format workflow JSON (`COMFY_WORKFLOW_PATH`, default `workflow.json`). `yue2_minimal.json` is an example YuE2 workflow (style node `55`, lyrics `54`, seed `53`). `workflow.json` itself is gitignored (user-specific).
- **http→https fetch patch** (`patchHttpToHttps` in `comfy.ts`): when `COMFY_BASE_URL` is https, the SDK's fetch is wrapped to rewrite `http://` URLs in `/api/v2/` JSON responses to `https://` — needed when the Comfy API v2 server sits behind an HTTPS-terminating reverse proxy. Don't remove this.
- **Config**: everything comes from env vars via `src/config.ts` (fail-fast `required()` checks). Comfy access is either self-hosted (`COMFY_BASE_URL`, e.g. `comfy-api-proxy` on `:8189`) or Comfy Cloud (`COMFY_API_KEY`, no base URL).
- **Attachment limit**: generated files > 25 MB are played but not attached to the Discord message (bot upload limit, `MAX_ATTACHMENT_BYTES` in `song-request.ts`).

## Deployment

Multi-arch Docker image (Bun + ffmpeg) built and pushed to GHCR by `.github/workflows/docker-publish.yml` on pushes to `main` (`latest`, `sha-<sha>`) and `v*.*.*` tags (`x.y.z`, `x.y`). The Dockerfile runs as non-root `bun` user with `OUTPUT_DIR=/app/output` as a volume; `workflow.json` is mounted read-only at runtime.
