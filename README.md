# Rosie Discord Bot

A Discord bot that generates songs. Tag the bot with an idea, and it will:

1. Ask OpenAI to write song lyrics from your idea
2. Run a ComfyUI workflow (via the Comfy API v2 / `@comfyorg/sdk`) with a **style** and **lyrics** text input
3. Post the resulting audio file in the channel and play it in your voice channel (if you're in one)

## Setup

```bash
bun install
cp .env.example .env   # then fill in your keys
```

You will also need:

- **Discord bot token** — https://discord.com/developers/applications
  - Enable the **Message Content Intent** on the Bot page
- **OpenAI API key** — https://platform.openai.com/api-keys
- **ComfyUI workflow** — export your workflow in **API format** (Save → Save (API Format)) to `workflow.json`.
  Configure which nodes receive the style/lyrics text via `COMFY_STYLE_NODE_ID` / `COMFY_LYRICS_NODE_ID` in `.env`.
- **ComfyUI access**, one of:
  - **Self-hosted**: run `pip install comfy-api-proxy && comfy-api-proxy` (serves API v2 on `http://127.0.0.1:8189` in front of ComfyUI on `8188`) and set `COMFY_BASE_URL`
  - **Comfy Cloud**: leave `COMFY_BASE_URL` unset and set `COMFY_API_KEY`
- **ffmpeg** on your PATH (needed for voice-channel playback)

## Run

```bash
bun run index.ts
```

## Docker

The Dockerfile builds a multi-arch (`linux/amd64`, `linux/arm64`) image with Bun and ffmpeg. A GitHub Actions workflow (`.github/workflows/docker-publish.yml`) pushes it to GHCR on every push to `main` (`latest` + `sha-<sha>` tags) and on `v*.*.*` version tags (`x.y.z`, `x.y`):

```bash
docker pull ghcr.io/<owner>/rosiediscordbot:latest
```

Run it — mount your API-format `workflow.json` read-only and a writable output dir, and pass env vars via `--env-file`:

```bash
docker run -d --name rosie \
  --env-file .env \
  -v ./workflow.json:/app/workflow.json:ro \
  -v rosie-output:/app/output \
  ghcr.io/<owner>/rosiediscordbot:latest
```

If you use the self-hosted `comfy-api-proxy`, note that `127.0.0.1` inside the container points at the container itself — set `COMFY_BASE_URL=http://host.docker.internal:8189` and add `--add-host=host.docker.internal:host-gateway` on Linux.

## Usage

### Slash command

```
/song prompt:a song about space cats count:5
```

- `prompt` (required) — what the songs should be about
- `count` (optional, 1–10, default 1) — how many **different** songs to generate;
  they are generated one at a time (ComfyUI runs a single job at a time) and
  queued as each one finishes, so playback starts while the rest are cooking

### Mention

In any channel the bot can read:

```
@Rosie a song about space cats
```

OpenAI decides the musical style and writes the lyrics; ComfyUI generates the audio. The bot plays it in your voice channel and posts a now-playing message with **Pause/Resume**, **Skip**, and **Stop** buttons.

The confirmation message includes the finished audio as a file attachment, so anyone in the channel can download it. Files over 25 MB (Discord's bot upload limit) are skipped.

If you're in a voice channel when you tag it, the bot joins and plays the song there, too.

## Project layout

- `index.ts` — entry point
- `src/bot.ts` — Discord client, `/song` slash command + mention handler, playback buttons
- `src/lyrics.ts` — OpenAI lyric generation
- `src/comfy.ts` — ComfyUI workflow execution + output download (all jobs serialized one-at-a-time)
- `src/song-request.ts` — shared generate-and-queue pipeline used by both the slash command and mentions
- `src/queue.ts` — per-guild queue + voice-channel playback (`@discordjs/voice`)
- `src/config.ts` — env configuration
