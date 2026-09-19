import fs from "node:fs";
import path from "node:path";
import type { TextChannel, VoiceBasedChannel } from "discord.js";
import { generateSong } from "./comfy";
import { generateLyrics } from "./lyrics";
import { getGuildQueue, type QueuedSong } from "./queue";
import { log } from "./logger";

/** Discord's upload limit for bots on non-boosted servers. */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Hard cap on songs per request — ComfyUI generation is slow. */
export const MAX_SONGS_PER_REQUEST = 10;

/**
 * Build a file attachment for a generated song, or undefined if the file is
 * too large for Discord. The name is derived from the song title.
 */
export function attachmentFor(title: string, filePath: string) {
  const size = fs.statSync(filePath).size;
  if (size > MAX_ATTACHMENT_BYTES) return undefined;
  const base =
    title
      .replace(/[\\/:*?"<>|]+/g, "-")
      .trim()
      .slice(0, 80) || "song";
  return { attachment: filePath, name: `${base}${path.extname(filePath) || ".mp3"}` };
}

export interface SongRequestOptions {
  idea: string;
  /** How many different songs to generate. */
  count: number;
  requesterId: string;
  voiceChannel: VoiceBasedChannel;
  textChannel: TextChannel;
  /** Publish a progress update to the user. */
  onStatus(content: string): Promise<unknown>;
  /** Deliver a finished audio file as soon as it's ready (one per song). */
  onFile?(file: { attachment: string; name: string }): Promise<unknown>;
}

export interface SongRequestResult {
  generated: number;
  failed: number;
}

/**
 * Generate `count` songs for `idea` and queue them as each one finishes.
 * Songs are generated strictly one at a time (ComfyUI can only run one job),
 * and each is enqueued immediately so playback starts while the rest cook.
 */
export async function runSongRequest(
  opts: SongRequestOptions,
): Promise<SongRequestResult> {
  const { idea, count, requesterId, voiceChannel, textChannel, onStatus, onFile } =
    opts;
  const queue = getGuildQueue(textChannel.guild.id);
  const tag = count > 1 ? (i: number) => ` (${i}/${count})` : () => "";

  let generated = 0;
  let failed = 0;

  for (let i = 1; i <= count; i++) {
    try {
      await onStatus(`🎶 Writing lyrics for **${idea}**${tag(i)}...`);
      const { title, style, lyrics } = await generateLyrics(idea);

      await onStatus(
        `📝 Lyrics ready for **${title}**${tag(i)} — generating audio (this can take a while)...`,
      );
      const { filePath, jobId } = await generateSong(style, lyrics);

      const song: QueuedSong = { filePath, jobId, style, title, idea, requesterId };
      await queue.enqueue(song, voiceChannel, textChannel);
      generated++;

      const file = attachmentFor(title, filePath);
      if (file && onFile) {
        await onFile(file);
      }
      await onStatus(
        `✅ Generated **${title}**${tag(i)} — added to the queue.${
          file ? "" : "\n⚠️ File too large to attach here."
        }`,
      );
    } catch (err) {
      failed++;
      log.error(`Song generation failed for "${idea}"${tag(i)}:`, err);
      await onStatus(
        `❌ Something went wrong with **${idea}**${tag(i)}: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  log.info(
    `Song request finished — idea: "${idea}", requested: ${count}, generated: ${generated}, failed: ${failed}`,
  );
  return { generated, failed };
}
