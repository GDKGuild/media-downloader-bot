import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';

export const HELP_PAGE_PREFIX = 'help_page:';

const PAGES: string[] = [
  [
    '**Automated Discord Archiver & Monitor — overview**',
    '',
    'This bot downloads and archives media from your Discord channels, and monitors Twitter/X authors for you.',
    '',
    '• **Auto-download** — every message with attachments or media embeds is saved automatically, with per-channel dedup so nothing is stored twice.',
    '• **Backfill** — `/download` walks a channel\'s history on demand (with time or date limits) and saves whatever\'s missing.',
    '• **Monitor** — `/monitor` tracks Twitter/X authors and relays their media posts into your server.',
    '• **Media viewer** — browse downloaded files by guild/channel/thread.',
    '• **Storage** — files go to the local downloads folder, an external drive, or MEGA.',
    '',
    'This `/help` message is ephemeral — only you can see it.',
    'Use **◀ Previous** / **Next ▶** to flip through the pages.',
  ].join('\n'),
  [
    '**`/download` — download media from a channel**',
    '',
    'Scans a channel (or many) and saves media files. No options = full history of the current channel.',
    '',
    '• `type` — All / Images / Videos / Audio.',
    '• `channel` — one channel (defaults to current).',
    '• `channels` — multiple channels: #mentions or IDs, comma-separated.',
    '• `scan_all` — scan every accessible channel + active threads.',
    '• `voice_only` — scan only accessible voice channels.',
    '• `thread_only` — scan threads of the selected channel(s) instead (needs `channel`/`channels`).',
    '• `thread` — scan only the thread with this name in the selected channel(s).',
    '• `days` / `hours` / `minutes` / `seconds` — how far back to look (combined).',
    '• `after` / `before` — date range, `YYYY-MM-DD`.',
    '• `concurrency` — channels processed at once (1–10, default 3).',
  ].join('\n'),
  [
    '**`/monitor` — Twitter/X author monitoring**',
    '',
    'Tracks authors and relays their media posts to a target channel.',
    '',
    '• `add <username>` — start monitoring an author.',
    '• `remove <username>` — stop monitoring an author.',
    '• `remove-all` — stop monitoring everyone.',
    '• `list` — show monitored authors + settings.',
    '• `channel <channel>` — set where new posts are relayed.',
    '• `fixers <domains>` — set the fixer domain order (e.g. `fixupx.com fxtwitter.com`).',
    '• `interval <minutes>` — poll interval (1–1440).',
    '• `config` — per-author settings (posts/replies/reposts, media-only, hashtag filter) via menus.',
    '• `verify` — send a tracked author\'s latest post as a test.',
    '• `verify-all` — relay the latest unverified post of every author.',
    '• `await [minutes]` — wait (1–30, default 5) for a tweet link, then auto-add its author.',
  ].join('\n'),
  [
    '**`/delete` — remove a bot message**',
    '',
    'Deletes a message the bot sent.',
    '',
    '• `message-id` — ID of the message to delete (required).',
    '• `channel-id` — channel the message lives in (defaults to current; works across servers).',
  ].join('\n'),
  [
    '**`/cancel` — stop a running operation**',
    '',
    'Stops in-progress work.',
    '',
    '• `all` — cancel all active operations (downloads + `/monitor verify-all`).',
    'Without `all`, cancels the download in the current channel.',
  ].join('\n'),
];

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('Show what this bot does and how to use every command');

function clampPage(page: number): number {
  return Math.max(0, Math.min(page, PAGES.length - 1));
}

function renderPage(page: number): { content: string; components: ActionRowBuilder<ButtonBuilder>[] } {
  const prev = new ButtonBuilder()
    .setCustomId(`${HELP_PAGE_PREFIX}${page - 1}`)
    .setLabel('◀ Previous')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page === 0);
  const next = new ButtonBuilder()
    .setCustomId(`${HELP_PAGE_PREFIX}${page + 1}`)
    .setLabel('Next ▶')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(page >= PAGES.length - 1);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next);
  return {
    content: `${PAGES[page]}\n\n— Page ${page + 1}/${PAGES.length} —`,
    components: [row],
  };
}

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await interaction.editReply(renderPage(0));
}

export async function handleHelpButton(interaction: ButtonInteraction): Promise<void> {
  const raw = interaction.customId.slice(HELP_PAGE_PREFIX.length);
  const page = clampPage(parseInt(raw, 10) || 0);
  await interaction.deferUpdate();
  await interaction.editReply(renderPage(page));
}
