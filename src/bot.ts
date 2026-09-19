import fs from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { config } from "./config";
import { buildControls, getGuildQueue } from "./queue";
import { MAX_SONGS_PER_REQUEST, runSongRequest } from "./song-request";
import { log } from "./logger";

fs.mkdirSync(config.outputDir, { recursive: true });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Channel],
});

const songCommand = new SlashCommandBuilder()
  .setName("song")
  .setDescription("Generate song(s) from a prompt and queue them in your voice channel")
  .addStringOption((option) =>
    option
      .setName("prompt")
      .setDescription("What should the song be about?")
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("count")
      .setDescription(
        `How many different songs to generate (1-${MAX_SONGS_PER_REQUEST}, default 1)`,
      )
      .setMinValue(1)
      .setMaxValue(MAX_SONGS_PER_REQUEST),
  )
  .toJSON();

client.once(Events.ClientReady, (c) => {
  log.info(`Logged in as ${c.user.tag} (id: ${c.user.id})`);
  const register = config.discordGuildId
    ? c.application.commands.set([songCommand], config.discordGuildId)
    : c.application.commands.set([songCommand]);
  register
    .then(() =>
      log.info(
        config.discordGuildId
          ? `Registered /song in guild ${config.discordGuildId}`
          : "Registered /song globally",
      ),
    )
    .catch((e) => log.error("Slash command registration failed:", e));
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!client.user) return;
  // Check the raw content for an explicit tag: Discord also adds the
  // replied-to user to `mentions` on replies, which would make every reply
  // to a bot message trigger a song request.
  const tagPattern = new RegExp(`<@!?${client.user.id}>`);
  if (!tagPattern.test(message.content)) return;

  const idea = message.content
    .replace(new RegExp(`<@!?${client.user!.id}>`, "g"), "")
    .trim();

  log.info(
    `Mention from ${message.author.tag} (${message.author.id}) in guild ${message.guildId} #${message.channelId}: "${idea}"`,
  );

  if (!idea) {
    await message.reply("Tag me with an idea, e.g. `@Rosie a song about space cats`");
    return;
  }

  const member = message.member;
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    log.warn(`User ${message.author.tag} is not in a voice channel`);
    await message.reply("Join a voice channel first, then tag me! 🎧");
    return;
  }

  const queue = getGuildQueue(message.guildId!);
  const status = await message.reply(
    `🎶 Queued **${idea}** — position #${queue.size + 1}. Writing lyrics...`,
  );

  await runSongRequest({
    idea,
    count: 1,
    requesterId: message.author.id,
    voiceChannel,
    textChannel: message.channel as never,
    onStatus: (content) => status.edit({ content }),
    // Discord replaces the attachment list on edit — pass the existing
    // attachments as the keep-list or they're dropped.
    onFile: (file) =>
      status.edit({
        files: [file],
        attachments: [...status.attachments.values()],
      }),
  });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (interaction.commandName === "song") {
      await handleSongCommand(interaction).catch((e) =>
        log.error("Song command failed:", e),
      );
    }
    return;
  }

  if (!interaction.isButton()) return;
  if (!interaction.customId.startsWith("rosie:")) return;

  log.info(
    `Button ${interaction.customId} pressed by ${interaction.user.tag} in guild ${interaction.guildId}`,
  );
  const queue = getGuildQueue(interaction.guildId!);
  let label: string;
  switch (interaction.customId) {
    case "rosie:toggle":
      if (queue.isPaused) {
        queue.resume();
        label = "▶ Resumed";
      } else if (queue.isPlaying) {
        queue.pause();
        label = "⏸ Paused";
      } else {
        label = "Nothing playing";
      }
      break;
    case "rosie:skip":
      queue.skip();
      label = "⏭ Skipped";
      break;
    case "rosie:stop":
      queue.stop();
      label = "⏹ Stopped";
      break;
    default:
      return;
  }

  await interaction.reply({ content: label, ephemeral: true });
  await refreshControls(interaction, queue);
});

async function handleSongCommand(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const idea = interaction.options.getString("prompt", true).trim();
  const count = interaction.options.getInteger("count") ?? 1;

  log.info(
    `/song from ${interaction.user.tag} (${interaction.user.id}) in guild ${interaction.guildId}: "${idea}" x${count}`,
  );

  if (!idea) {
    await interaction.reply({
      content: "Tell me what the song should be about! 🎶",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.inCachedGuild()) {
    await interaction.reply({
      content: "This only works inside a server.",
      ephemeral: true,
    });
    return;
  }

  const voiceChannel = interaction.member.voice?.channel;
  if (!voiceChannel) {
    log.warn(`User ${interaction.user.tag} is not in a voice channel`);
    await interaction.reply({
      content: "Join a voice channel first, then run `/song`! 🎧",
      ephemeral: true,
    });
    return;
  }

  // Generation takes minutes — defer so the request doesn't time out.
  await interaction.deferReply();

  // Then complete the deferred response with ONE webhook edit: only webhook
  // edits (editReply) clear the "is thinking..." loading state — raw message
  // edits don't. The token is fresh here, so this single call is safely
  // inside the 15-minute window. All later edits go through the Message
  // object: interaction tokens (editReply/followUp) expire and long
  // multi-song requests would otherwise die with 401 50027.
  const statusMessage = await interaction.editReply({
    content: `🎶 Working on **${idea}**...`,
  });

  const { generated, failed } = await runSongRequest({
    idea,
    count,
    requesterId: interaction.user.id,
    voiceChannel,
    textChannel: interaction.channel as never,
    onStatus: (content) => statusMessage.edit({ content }),
    // Discord replaces the attachment list on edit — pass the existing
    // attachments as the keep-list or they're dropped.
    onFile: (file) =>
      statusMessage.edit({
        files: [file],
        attachments: [...statusMessage.attachments.values()],
      }),
  });

  if (count > 1) {
    await statusMessage.edit({
      content: failed
        ? `🎉 Finished — ${generated}/${count} songs queued for **${idea}** (${failed} failed).`
        : `🎉 All done — ${generated} songs queued for **${idea}**!`,
    });
  }
}

async function refreshControls(
  interaction: ButtonInteraction,
  queue: ReturnType<typeof getGuildQueue>,
): Promise<void> {
  const message = interaction.message as Message;
  if (!message) return;
  try {
    await message.edit({ components: [buildControls(queue.isPaused)] });
  } catch (e) {
    log.debug("refreshControls: could not edit message:", e);
  }
}

client.login(config.discordToken);
