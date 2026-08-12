import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  MessageFlags,
} from 'discord.js';
import { DatabaseService, MonitorAuthorRow } from '../services/databaseService';
import { TweetMonitorService, normalizeUsername, resolveProfile, DEFAULT_FIXERS } from '../services/tweetMonitorService';
import { safeEditReply } from '../utils/interactionUtils';

export const MONITOR_VERIFY_SELECT_ID = 'monitor_verify_select';
export const MONITOR_CONFIG_SELECT_ID = 'monitor_config';

const CONFIG_STEP_AUTHOR = `${MONITOR_CONFIG_SELECT_ID}:author`;
const CONFIG_STEP_CONTENT = `${MONITOR_CONFIG_SELECT_ID}:content`;
const CONFIG_STEP_MEDIA = `${MONITOR_CONFIG_SELECT_ID}:media`;
const CONFIG_STEP_HASHTAG = `${MONITOR_CONFIG_SELECT_ID}:hashtag`;

const CONTENT_OPTIONS = [
  { label: 'Posts + reposts', value: '101', description: 'Default — posts and reposts, no replies' },
  { label: 'Posts only', value: '100', description: 'Own posts, no replies, no reposts' },
  { label: 'Replies only', value: '010', description: 'Only replies' },
  { label: 'Posts + replies', value: '110', description: 'Posts and replies, no reposts' },
  { label: 'Reposts only', value: '001', description: 'Only reposts' },
  { label: 'Everything', value: '111', description: 'Posts, replies, and reposts' },
];

const MEDIA_OPTIONS = [
  { label: 'Media only', value: '1', description: 'Default — only posts with media' },
  { label: 'Text + media', value: '0', description: 'Relay text posts too' },
];

const HASHTAG_OPTIONS = [
  { label: 'Off', value: '0', description: 'Default — no hashtag filter' },
  { label: 'On', value: '1', description: 'Only relay posts matching monitor-hashtags.txt' },
];

function parseFlags(flags: string): { include_posts: number; include_replies: number; include_reposts: number } {
  const [p, r, s] = flags.split('').map((c) => (c === '1' ? 1 : 0));
  return { include_posts: p, include_replies: r, include_reposts: s };
}

function configSummary(a: MonitorAuthorRow): string {
  const content = [
    a.include_posts ? 'posts' : null,
    a.include_replies ? 'replies' : null,
    a.include_reposts ? 'reposts' : null,
  ].filter(Boolean).join('+');
  return `${content} · ${a.media_only ? 'media only' : 'text+media'}${a.hashtag_filter ? ' · #filter' : ''}`;
}

function makeSelectRow(
  customId: string,
  placeholder: string,
  options: { label: string; value: string; description?: string }[],
): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options);
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export const data = new SlashCommandBuilder()
  .setName('monitor')
  .setDescription('Manage Twitter/X author monitoring')
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add an author to monitor')
      .addStringOption(opt =>
        opt.setName('username')
          .setDescription('Twitter handle (without @)')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Stop monitoring an author')
      .addStringOption(opt =>
        opt.setName('username')
          .setDescription('Twitter handle (without @)')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('remove-all')
      .setDescription('Stop monitoring all authors in this server'))
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('Show monitored authors and settings'))
  .addSubcommand(sub =>
    sub.setName('channel')
      .setDescription('Set the channel where new posts are relayed')
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Target channel')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('fixers')
      .setDescription('Set the ordered fixer domain list (space or comma separated)')
      .addStringOption(opt =>
        opt.setName('domains')
          .setDescription('e.g. fixupx.com fixvx.com fxtwitter.com vxtwitter.com')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('interval')
      .setDescription('Set the poll interval in minutes')
      .addIntegerOption(opt =>
        opt.setName('minutes')
          .setDescription('Poll interval (1–1440)')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('config')
      .setDescription('Configure per-author monitoring (content, media, hashtag filter)'))
  .addSubcommand(sub =>
    sub.setName('verify')
      .setDescription('Fetch a tracked author\'s latest post and send its link to the monitor channel as a test'))
  .addSubcommand(sub =>
    sub.setName('verify-all')
      .setDescription('Relay the latest post of every tracked author that has not been verified yet'))
  .addSubcommand(sub =>
    sub.setName('await')
      .setDescription('Wait for a tweet link in chat, then add its author to the monitor')
      .addIntegerOption(opt =>
        opt.setName('minutes')
          .setDescription('How long to wait (1–30, default 5)')
          .setRequired(false)));

export async function execute(
  interaction: ChatInputCommandInteraction,
  db: DatabaseService,
  monitor?: TweetMonitorService,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  if (!guildId) {
    await safeEditReply(interaction, 'This command must be run in a server.');
    return;
  }

  const sub = interaction.options.getSubcommand();
  switch (sub) {
    case 'add':
      await handleAdd(interaction, db, guildId);
      break;
    case 'remove':
      await handleRemove(interaction, db, guildId);
      break;
    case 'remove-all':
      await handleRemoveAll(interaction, db, guildId);
      break;
    case 'list':
      await handleList(interaction, db, monitor, guildId);
      break;
    case 'channel':
      await handleChannel(interaction, db, monitor, guildId);
      break;
    case 'fixers':
      await handleFixers(interaction, db, monitor, guildId);
      break;
    case 'interval':
      await handleInterval(interaction, db, monitor, guildId);
      break;
    case 'verify':
      await handleVerify(interaction, db, monitor, guildId);
      break;
    case 'verify-all':
      await handleVerifyAll(interaction, db, monitor, guildId);
      break;
    case 'config':
      await handleConfig(interaction, db, guildId);
      break;
    case 'await':
      await handleAwait(interaction, monitor, guildId);
      break;
    default:
      await safeEditReply(interaction, 'Unknown subcommand.');
  }
}

async function handleAdd(interaction: ChatInputCommandInteraction, db: DatabaseService, guildId: string): Promise<void> {
  const raw = interaction.options.getString('username', true);
  const username = normalizeUsername(raw);
  if (!username) {
    await safeEditReply(interaction, `Invalid username \`${raw}\`. Use 1–15 letters, numbers, or underscores.`);
    return;
  }
  await safeEditReply(interaction, `Verifying @${username}...`);
  const profile = await resolveProfile(username);
  if (!profile) {
    await safeEditReply(interaction, `@${username} was not found on X (or the API could not confirm it).`);
    return;
  }
  if (profile.id) {
    const existingById = db.findMonitorAuthorByUserId(guildId, profile.id);
    if (existingById) {
      await safeEditReply(interaction, `That account is already being monitored here as @${existingById.username}.`);
      return;
    }
  }
  const existing = db.findMonitorAuthorCI(guildId, profile.screen_name);
  if (existing) {
    await safeEditReply(interaction, `@${existing.username} is already being monitored here.`);
    return;
  }
  db.addMonitorAuthor(guildId, profile.screen_name, profile.id);
  await safeEditReply(interaction, `Now monitoring @${profile.screen_name}. The next poll baselines their timeline; new posts are relayed after that.`);
}

async function handleAwait(interaction: ChatInputCommandInteraction, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  if (!monitor) {
    await safeEditReply(interaction, 'The monitor service is not available.');
    return;
  }
  const minutes = interaction.options.getInteger('minutes') ?? 5;
  if (minutes < 1 || minutes > 30) {
    await safeEditReply(interaction, 'Wait time must be between 1 and 30 minutes.');
    return;
  }
  monitor.armAwait(guildId, interaction.channelId, interaction.user.id, minutes, interaction);
  await safeEditReply(interaction, `Waiting **${minutes} minute(s)** for a tweet link in this server. Paste any \`x.com\` / \`twitter.com\` / \`fxtwitter.com\` / \`fixupx.com\` / \`vxtwitter.com\` post link in any channel — I'll add its author to the monitor.`);
}

async function handleRemove(interaction: ChatInputCommandInteraction, db: DatabaseService, guildId: string): Promise<void> {
  const raw = interaction.options.getString('username', true);
  const username = normalizeUsername(raw);
  if (!username) {
    await safeEditReply(interaction, `Invalid username \`${raw}\`.`);
    return;
  }
  const existing = db.findMonitorAuthorCI(guildId, username);
  if (!existing) {
    await safeEditReply(interaction, `@${username} is not being monitored here.`);
    return;
  }
  db.removeMonitorAuthor(guildId, existing.username);
  await safeEditReply(interaction, `Stopped monitoring @${existing.username}.`);
}

async function handleRemoveAll(interaction: ChatInputCommandInteraction, db: DatabaseService, guildId: string): Promise<void> {
  const count = db.removeAllMonitorAuthors(guildId);
  if (count === 0) {
    await safeEditReply(interaction, 'No authors are being monitored here.');
    return;
  }
  await safeEditReply(interaction, `Stopped monitoring all ${count} author(s).`);
}

async function handleVerify(
  interaction: ChatInputCommandInteraction,
  db: DatabaseService,
  monitor: TweetMonitorService | undefined,
  guildId: string,
): Promise<void> {
  if (!monitor) {
    await safeEditReply(interaction, 'The monitor service is not available.');
    return;
  }
  const authors = db.listMonitorAuthors(guildId);
  if (authors.length === 0) {
    await safeEditReply(interaction, 'No authors are being monitored in this server yet. Use `/monitor add <username>` first.');
    return;
  }
  const options = authors.slice(0, 25).map((a, i) => ({
    label: `${i + 1}. @${a.username}`,
    value: a.username,
    description: a.user_id ? `user ${a.user_id}` : 'user id unknown',
  }));
  const select = new StringSelectMenuBuilder()
    .setCustomId(MONITOR_VERIFY_SELECT_ID)
    .setPlaceholder('Choose an author to verify')
    .addOptions(options);
  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  await interaction.editReply({
    content: `**Verify — pick an author (${options.length} tracked):**`,
    components: [row],
  });
}

export async function handleVerifySelect(
  interaction: StringSelectMenuInteraction,
  db: DatabaseService,
  monitor: TweetMonitorService | undefined,
): Promise<void> {
  const guildId = interaction.guildId;
  const username = interaction.values[0];
  if (!guildId || !username) return;

  try {
    await interaction.deferUpdate();
    if (!monitor) {
      await interaction.editReply('The monitor service is not available.');
      return;
    }
    const author = db.getMonitorAuthor(guildId, username);
    if (!author) {
      await interaction.editReply({ content: `@${username} is no longer being monitored here.`, components: [] });
      return;
    }
    const channelId = monitor.getChannelId(guildId);
    if (!channelId) {
      await interaction.editReply({
        content: `@${author.username} is monitored, but no target channel is set. Run \`/monitor channel\` first.`,
        components: [],
      });
      return;
    }
    await interaction.editReply({ content: `Fetching latest post from @${author.username}...`, components: [] });
    const result = await monitor.verify(author, guildId);
    let message: string;
    if (result.reason === 'identity-mismatch') {
      message = `Cannot verify @${author.username} — the handle now belongs to a different account than the tracked user \`${author.user_id}\` (handle recycled). Remove it and re-add the author with the current handle.`;
    } else if (!result.found) {
      message = `@${author.username} has no posts with media (or could not be fetched).`;
    } else if (!result.channelId) {
      message = `@${author.username}'s latest post is \`${result.tweetId}\`, but no target channel is set. Run \`/monitor channel\` first.`;
    } else {
      message = result.posted
        ? `Sent @${author.username}'s latest post (\`${result.tweetId}\`) to <#${channelId}>.`
        : `Found @${author.username}'s latest post (\`${result.tweetId}\`), but failed to post to <#${channelId}>.`;
    }
    await interaction.editReply(message);
  } catch (err) {
    const e = err as { code?: number } | undefined;
    if (e && typeof e === 'object' && e.code === 10062) {
      console.log('[Monitor] verify select: interaction expired or already handled (10062) — ignored');
    } else {
      console.error(`[Monitor] verify select failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function handleConfig(interaction: ChatInputCommandInteraction, db: DatabaseService, guildId: string): Promise<void> {
  const authors = db.listMonitorAuthors(guildId);
  if (authors.length === 0) {
    await safeEditReply(interaction, 'No authors are being monitored in this server yet. Use `/monitor add <username>` first.');
    return;
  }
  const options = authors.slice(0, 25).map((a, i) => ({
    label: `${i + 1}. @${a.username}`,
    value: a.username,
    description: configSummary(a),
  }));
  const row = makeSelectRow(CONFIG_STEP_AUTHOR, 'Choose an author to configure', options);
  await interaction.editReply({
    content: `**Configure — pick an author (${options.length} tracked):**`,
    components: [row],
  });
}

export async function handleConfigSelect(interaction: StringSelectMenuInteraction, db: DatabaseService): Promise<void> {
  const guildId = interaction.guildId;
  const parts = interaction.customId.split(':');
  const step = parts[1];
  const value = interaction.values[0];
  if (!guildId || !step || !value) return;

  try {
    await interaction.deferUpdate();
    const render = (content: string, row: ActionRowBuilder<StringSelectMenuBuilder>): Promise<unknown> =>
      interaction.editReply({ content, components: [row] });

    switch (step) {
      case 'author': {
        const username = value;
        await render(
          `**@${username} — what to include?**`,
          makeSelectRow(`${CONFIG_STEP_CONTENT}:${username}`, 'Choose content types', CONTENT_OPTIONS),
        );
        break;
      }
      case 'content': {
        const username = parts[2];
        if (!username) return;
        await render(
          `**@${username} — media or text?**`,
          makeSelectRow(`${CONFIG_STEP_MEDIA}:${username}:${value}`, 'Media only?', MEDIA_OPTIONS),
        );
        break;
      }
      case 'media': {
        const username = parts[2];
        const flags = parts[3];
        if (!username || !flags) return;
        await render(
          `**@${username} — hashtag filter?**`,
          makeSelectRow(`${CONFIG_STEP_HASHTAG}:${username}:${flags}:${value}`, 'Hashtag filter', HASHTAG_OPTIONS),
        );
        break;
      }
      case 'hashtag': {
        const username = parts[2];
        const flags = parts[3];
        if (!username || !flags) return;
        db.updateMonitorAuthorConfig(guildId, username, {
          ...parseFlags(flags),
          media_only: Number(parts[4]),
          hashtag_filter: Number(value),
        });
        const author = db.getMonitorAuthor(guildId, username);
        await interaction.editReply({
          content: `**@${username} config updated** — ${author ? configSummary(author) : ''}`,
          components: [],
        });
        break;
      }
    }
  } catch (err) {
    const e = err as { code?: number } | undefined;
    if (e && typeof e === 'object' && e.code === 10062) {
      console.log('[Monitor] config select: interaction expired or already handled (10062) — ignored');
    } else {
      console.error(`[Monitor] config select failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function handleVerifyAll(
  interaction: ChatInputCommandInteraction,
  db: DatabaseService,
  monitor: TweetMonitorService | undefined,
  guildId: string,
): Promise<void> {
  if (!monitor) {
    await safeEditReply(interaction, 'The monitor service is not available.');
    return;
  }
  const authors = db.listMonitorAuthors(guildId);
  if (authors.length === 0) {
    await safeEditReply(interaction, 'No authors are being monitored in this server yet. Use `/monitor add <username>` first.');
    return;
  }
  const channelId = monitor.getChannelId(guildId);
  if (!channelId) {
    await safeEditReply(interaction, 'No target channel is set. Run `/monitor channel` first.');
    return;
  }
  await safeEditReply(interaction, `Verifying ${authors.length} author(s)...`);
  const result = await monitor.verifyAll(guildId);
  const lines = result.entries.map((e) => {
    switch (e.status) {
      case 'posted': return `\`@${e.username}\` → sent \`${e.tweetId}\``;
      case 'skipped': return `\`@${e.username}\` → skipped (already up to date)`;
      case 'identity-mismatch': return `\`@${e.username}\` → handle now belongs to a different account; remove and re-add`;
      case 'no-posts': return `\`@${e.username}\` → no posts with media found`;
      case 'no-channel': return `\`@${e.username}\` → no channel set`;
      default: return `\`@${e.username}\` → failed`;
    }
  });
  const header = result.aborted
    ? `**Verify all aborted by /cancel** (${result.entries.length} author(s) processed before stop)`
    : `**Verify all (${result.entries.length} tracked)**`;
  await safeEditReply(interaction,
    header + '\n' +
    lines.join('\n') +
    `\nChannel: <#${channelId}>`);
}

async function handleList(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const authors = db.listMonitorAuthors(guildId);
  const channel = db.getMonitorConfig(guildId, 'target_channel_id');
  const interval = monitor?.getIntervalMinutes(guildId) ?? 15;
  const fixers = monitor?.getFixers(guildId) ?? DEFAULT_FIXERS;

  if (authors.length === 0) {
    await safeEditReply(interaction,
      `No authors being monitored in this server yet. Use \`/monitor add <username>\`.\n\n` +
      `Channel: ${channel ? `<#${channel}>` : 'not set'} · Interval: ${interval} min\n` +
      `Fixers: ${fixers.map((f) => `\`${f}\``).join(' ')}`);
    return;
  }

  const lines = authors.map((a) =>
    `\`${a.user_id ?? '?'}\` - \`@${a.username}\` — ${configSummary(a)}` +
    (a.last_tweet_id ? ` · last \`${a.last_tweet_id}\`` : ' · not yet baselined'));
  await safeEditReply(interaction,
    `**Monitored authors in this server (${authors.length})**\n` +
    lines.join('\n') +
    `\n\nChannel: ${channel ? `<#${channel}>` : 'not set'} · Interval: ${interval} min\n` +
    `Fixers: ${fixers.map((f) => `\`${f}\``).join(' ')}`);
}

async function handleChannel(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  db.setMonitorConfig(guildId, 'target_channel_id', channel.id);
  monitor?.setChannel(guildId, channel.id);
  await safeEditReply(interaction, `Monitor target channel set to <#${channel.id}>. New posts will be relayed there.`);
}

async function handleFixers(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const raw = interaction.options.getString('domains', true);
  const list = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const valid = list.filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d));
  if (valid.length === 0) {
    await safeEditReply(interaction, `No valid fixer domains in \`${raw}\`.`);
    return;
  }
  db.setMonitorConfig(guildId, 'fixer_list', JSON.stringify(valid));
  monitor?.setFixers(guildId, valid);
  const dropped = list.length - valid.length;
  await safeEditReply(interaction,
    `Fixer list set (in order): ${valid.map((d) => `\`${d}\``).join(' ')}` +
    (dropped > 0 ? `\nSkipped ${dropped} invalid domain(s).` : ''));
}

async function handleInterval(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const minutes = interaction.options.getInteger('minutes', true);
  if (minutes < 1 || minutes > 1440) {
    await safeEditReply(interaction, 'Interval must be between 1 and 1440 minutes.');
    return;
  }
  db.setMonitorConfig(guildId, 'poll_interval_minutes', String(minutes));
  monitor?.setIntervalMinutes(guildId, minutes);
  await safeEditReply(interaction, `Poll interval set to ${minutes} minute(s).`);
}
