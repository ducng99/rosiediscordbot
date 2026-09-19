import OpenAI from "openai";
import { config } from "./config";
import { log } from "./logger";

const openai = new OpenAI({
  apiKey: config.openaiApiKey,
  baseURL: config.openaiBaseUrl,
});

const SYSTEM_PROMPT = `You are a music composer. You can write music in any genre and style.

## Writing the Style

Describe the main musical characteristics, such as:

- **Genre:** pop, jazz, rock, electronic, folk
- **Vocals:** warm female vocal, expressive male vocal, soft vocals
- **Language:** English, Chinese, Japanese, etc.
- **Tempo:** 90 BPM, slow, upbeat
- **Instruments:** piano, electric guitar, bass, drums, synths

Example:

> English, warm female vocal, contemporary pop, 96 BPM, piano, rounded electric bass, restrained drums, clear diction

Keep musical instructions in **Style** rather than in the lyrics.

## Writing the Title

Come up with a short, catchy title (a few words, no surrounding quotes)
that captures the song's theme. Do not put the title in the lyrics.

## Writing Lyrics

Use section tags to describe the song structure:

    [Verse]
    Morning light across the window
    City waking down below

    [Chorus]
    Run with me into the sunlight
    Leave the shadows far behind

You can structure the song with sections such as:

[Verse] · [Chorus] · [Bridge] · [Outro]`;

const schema = {
  type: "object",
  properties: {
    title: { type: "string", description: "A short, catchy song title (a few words, no quotes)." },
    style: { type: "string", description: "A short musical style, e.g. 'lo-fi jazz'." },
    lyrics: { type: "string", description: "The full song lyrics as plain text." },
  },
  required: ["title", "style", "lyrics"],
  additionalProperties: false,
} as const;

export interface LyricsResult {
  title: string;
  style: string;
  lyrics: string;
}

export async function generateLyrics(userIdea: string): Promise<LyricsResult> {
  log.info(`Generating lyrics for idea: "${userIdea}" (model: ${config.openaiModel})`);
  const start = Date.now();
  const completion = await openai.chat.completions.create({
    model: config.openaiModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userIdea },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "song", schema, strict: true },
    },
  });

  const raw = completion.choices[0]?.message?.content?.trim();
  if (!raw) {
    throw new Error("OpenAI returned no content");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`OpenAI did not return valid JSON: ${raw.slice(0, 200)}`);
  }

  const obj = parsed as Partial<LyricsResult>;
  if (typeof obj.title !== "string" || typeof obj.style !== "string" || typeof obj.lyrics !== "string") {
    throw new Error("OpenAI JSON missing 'title', 'style' or 'lyrics'");
  }

  // Cap the title so it stays sane in Discord messages and filenames.
  const result = {
    title: obj.title.trim().slice(0, 100),
    style: obj.style.trim(),
    lyrics: obj.lyrics.trim(),
  };
  log.info(
    `Lyrics generated in ${Date.now() - start}ms — title: "${result.title}", style: "${result.style}", lyrics length: ${result.lyrics.length} chars`,
  );
  log.debug(`Lyrics content:\n${result.lyrics}`);
  return result;
}
