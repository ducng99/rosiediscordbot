import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
  type AudioPlayer,
  type VoiceConnection,
} from "@discordjs/voice";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message,
  type TextChannel,
  type VoiceBasedChannel,
} from "discord.js";
import { config } from "./config";
import { log } from "./logger";

export interface QueuedSong {
  filePath: string;
  jobId: string;
  style: string;
  /** LLM-generated song title, shown in messages and attachment names. */
  title: string;
  idea: string;
  requesterId: string;
}

/** The control buttons attached to each "now playing" message. */
export function buildControls(isPaused: boolean): ActionRowBuilder<ButtonBuilder> {
  const toggle = new ButtonBuilder()
    .setCustomId("rosie:toggle")
    .setLabel(isPaused ? "▶ Resume" : "⏸ Pause")
    .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Secondary);
  const skip = new ButtonBuilder()
    .setCustomId("rosie:skip")
    .setLabel("⏭ Skip")
    .setStyle(ButtonStyle.Primary);
  const stop = new ButtonBuilder()
    .setCustomId("rosie:stop")
    .setLabel("⏹ Stop")
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(toggle, skip, stop);
}

/**
 * One queue per guild. Holds the voice connection + audio player, keeps the
 * song list, auto-advances when a song ends, and posts a "now playing"
 * message (with controls + the file) each time a song starts.
 */
class GuildQueue {
  private songs: QueuedSong[] = [];
  private connection?: VoiceConnection;
  private readonly player: AudioPlayer;
  private current?: QueuedSong;
  private textChannel?: TextChannel;
  /** The "now playing" message for the current song, deleted when it ends. */
  private nowPlaying?: Message;
  /** Pending disconnect timer — fires when the queue has stayed empty for a while. */
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  /** Set by stop() so the Idle handler doesn't immediately advance. */
  private stopped = false;

  constructor() {
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play },
    });
    this.player.on(AudioPlayerStatus.Idle, () => {
      if (this.stopped) return;
      log.debug(`Player idle — auto-advancing`);
      this.current = undefined;
      void this.deleteNowPlayingMessage();
      void this.playNext().catch((e) => log.error("playNext failed:", e));
    });
  }

  get size(): number {
    return this.songs.length;
  }
  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }
  get isPaused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }
  get isConnected(): boolean {
    return (
      !!this.connection &&
      this.connection.state.status !== VoiceConnectionStatus.Destroyed
    );
  }

  /** Add a song. Connects if needed and starts playback if idle. */
  async enqueue(
    song: QueuedSong,
    voiceChannel: VoiceBasedChannel | undefined,
    textChannel: TextChannel,
  ): Promise<void> {
    this.textChannel = textChannel;
    this.stopped = false;
    this.clearDisconnectTimer();
    this.songs.push(song);
    log.info(
      `Enqueued song — title: "${song.title}", idea: "${song.idea}", style: "${song.style}", job: ${song.jobId}, queue size: ${this.songs.length}`,
    );

    if (!this.isConnected && voiceChannel) {
      await this.connect(voiceChannel);
    }
    if (this.player.state.status === AudioPlayerStatus.Idle) {
      log.debug(`Player idle — starting playback immediately`);
      void this.playNext().catch((e) => log.error("playNext failed:", e));
    }
  }

  private async connect(voiceChannel: VoiceBasedChannel): Promise<void> {
    log.info(
      `Connecting to voice channel ${voiceChannel.name} (${voiceChannel.id}) in guild ${voiceChannel.guild.id}`,
    );
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    this.connection = connection;
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
    connection.subscribe(this.player);
    log.info(`Voice connection ready`);
  }

  private async playNext(): Promise<void> {
    const song = this.songs.shift();
    if (!song) {
      log.info(
        `Queue empty — leaving voice channel in ${config.voiceIdleMinutes} minute(s) unless a new song arrives`,
      );
      this.scheduleDisconnect();
      return;
    }
    this.current = song;
    log.info(`Now playing — title: "${song.title}", idea: "${song.idea}", style: "${song.style}", job: ${song.jobId}, remaining: ${this.songs.length}`);
    this.player.play(createAudioResource(song.filePath));
    await this.announce(song);
  }

  private async announce(song: QueuedSong): Promise<void> {
    const channel = this.textChannel;
    if (!channel) return;
    try {
      const next = this.songs.length;
      this.nowPlaying = await channel.send({
        content: `🎵 Now playing: **${song.title}**${
          next ? `\n📜 Up next: ${next} song(s) in queue` : ""
        }`,
        components: [buildControls(this.isPaused)],
      });
    } catch (e) {
      log.error("announce failed:", e);
    }
  }

  /** Remove the current song's "now playing" message (ignore if already gone). */
  private async deleteNowPlayingMessage(): Promise<void> {
    const message = this.nowPlaying;
    this.nowPlaying = undefined;
    if (!message) return;
    try {
      await message.delete();
    } catch (e) {
      log.debug("Could not delete now-playing message:", e);
    }
  }

  /** Leave the voice channel after the idle delay unless a new song arrives first. */
  private scheduleDisconnect(): void {
    this.clearDisconnectTimer();
    const ms = config.voiceIdleMinutes * 60_000;
    this.disconnectTimer = setTimeout(() => {
      this.disconnectTimer = undefined;
      log.info(`Queue still empty — leaving voice channel`);
      this.disconnect();
    }, ms);
    // Never keep the process alive just to disconnect.
    this.disconnectTimer.unref?.();
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = undefined;
    }
  }

  /** Halt the current song and move to the next (if any). */
  skip(): void {
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      log.info(`Skipping current song`);
      this.player.stop(true); // triggers Idle -> playNext
    }
  }

  pause(): void {
    if (this.isPlaying) {
      log.info(`Pausing playback`);
      this.player.pause();
    }
  }

  resume(): void {
    if (this.isPaused) {
      log.info(`Resuming playback`);
      this.player.unpause();
    }
  }

  /** Clear the queue, stop playback, and leave the voice channel. */
  stop(): void {
    log.info(`Stopping — clearing ${this.songs.length} queued song(s)`);
    this.stopped = true;
    this.songs = [];
    this.current = undefined;
    if (this.player.state.status !== AudioPlayerStatus.Idle) {
      this.player.stop(true);
    }
    void this.deleteNowPlayingMessage();
    this.disconnect();
  }

  private disconnect(): void {
    this.clearDisconnectTimer();
    if (this.connection) {
      log.info(`Disconnecting from voice channel`);
    }
    this.connection?.destroy();
    this.connection = undefined;
  }
}

const guilds = new Map<string, GuildQueue>();

export function getGuildQueue(guildId: string): GuildQueue {
  let q = guilds.get(guildId);
  if (!q) {
    q = new GuildQueue();
    guilds.set(guildId, q);
  }
  return q;
}
