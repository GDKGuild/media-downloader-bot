import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
  ActionRowBuilder,
  MessageFlags,
  EmbedBuilder,
} from 'discord.js';
import { DatabaseService, MonitorAuthorRow, MonitorPlatform } from '../services/databaseService';
import { TweetMonitorService, normalizeUsername, resolveProfile, DEFAULT_FIXERS, DEFAULT_PIXIV_FIXERS, formatMs } from '../services/tweetMonitorService';
import { resolvePixivUser } from '../services/pixivService';
import { safeEditReply } from '../utils/interactionUtils';

export const MONITOR_VERIFY_SELECT_ID = 'monitor_verify_select';
export const MONITOR_CONFIG_SELECT_ID = 'monitor_config';
export const MONITOR_MIGRATE_SELECT_ID = 'monitor_migrate_select';

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

function authorName(a: MonitorAuthorRow): string {
  return a.platform === 'pixiv'
    ? `${a.display_name ?? a.username} (pixiv)`
    : `@${a.username}`;
}

function bindingText(db: DatabaseService, guildId: string, a: MonitorAuthorRow): string {
  if (a.channel_id) return `, bound to <#${a.channel_id}>`;
  const def = db.getMonitorConfig(guildId, 'target_channel_id');
  return def ? `, relaying to the server default <#${def}>` : ' with no channel bound';
}

function configSummary(a: MonitorAuthorRow): string {
  if (a.platform === 'pixiv') return 'artworks';
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
  .setDescription('Manage social media author monitoring')
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add an author to monitor')
      .addStringOption(opt =>
        opt.setName('username')
          .setDescription('Twitter handle (without @) or pixiv user ID/URL')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('platform')
          .setDescription('Platform to monitor (default twitter)')
          .setRequired(false)
          .addChoices(
            { name: 'twitter', value: 'twitter' },
            { name: 'pixiv', value: 'pixiv' },
          )))
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
    sub.setName('migrate')
      .setDescription('Copy an author + settings from another guild into this one (source keeps monitoring)')
      .addStringOption(opt =>
        opt.setName('username')
          .setDescription('Twitter handle (without @) or pixiv user ID monitored in another guild')
          .setRequired(true)))
  .addSubcommand(sub =>
    sub.setName('channel')
      .setDescription('Set the relay channel (server default, or per-author with a username)')
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('Target channel')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('username')
          .setDescription('Optional — bind this one author to the channel instead of setting the server default')
          .setRequired(false)))
  .addSubcommand(sub =>
    sub.setName('fixers')
      .setDescription('Set the ordered fixer domain list (space or comma separated)')
      .addStringOption(opt =>
        opt.setName('domains')
          .setDescription('e.g. fixupx.com fixvx.com fxtwitter.com vxtwitter.com')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('platform')
          .setDescription('Which platform this fixer list applies to (default twitter)')
          .setRequired(false)
          .addChoices(
            { name: 'twitter', value: 'twitter' },
            { name: 'pixiv', value: 'pixiv' },
          )))
  .addSubcommand(sub =>
    sub.setName('interval')
      .setDescription('Set the poll interval (seconds or minutes)')
      .addIntegerOption(opt =>
        opt.setName('value')
          .setDescription('Interval value (1–86400 for seconds, 1–1440 for minutes)')
          .setRequired(true))
      .addStringOption(opt =>
        opt.setName('unit')
          .setDescription('Unit for the value')
          .setRequired(true)
          .addChoices(
            { name: 'seconds', value: 'seconds' },
            { name: 'minutes', value: 'minutes' },
          )))
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
        opt.setName('value')
          .setDescription('How long to wait (1–1800 seconds or 1–30 minutes, default 5 minutes)')
          .setRequired(false))
      .addStringOption(opt =>
        opt.setName('unit')
          .setDescription('Unit for the value (default minutes)')
          .setRequired(false)
          .addChoices(
            { name: 'seconds', value: 'seconds' },
            { name: 'minutes', value: 'minutes' },
          )));

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
    case 'migrate':
      await handleMigrate(interaction, db, monitor, guildId);
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
  const platform = (interaction.options.getString('platform') ?? 'twitter') as MonitorPlatform;

  if (platform === 'pixiv') {
    await safeEditReply(interaction, `Resolving pixiv user \`${raw}\`...`);
    const user = await resolvePixivUser(raw);
    if (!user) {
      await safeEditReply(interaction, `\`${raw}\` is not a valid pixiv user ID or \`/users/\` link.`);
      return;
    }
    const existing = db.findMonitorAuthorByUserId(guildId, user.userId);
    if (existing) {
      await safeEditReply(interaction, `That pixiv artist is already being monitored here as ${authorName(existing)}${bindingText(db, guildId, existing)}. Run \`/monitor channel <#channel> <username>\` to move it.`);
      return;
    }
    db.addMonitorAuthor(guildId, user.userId, user.userId, 'pixiv', user.name, interaction.channelId);
    await safeEditReply(interaction, `Now monitoring pixiv artist **${user.name}** (\`${user.userId}\`), relaying to <#${interaction.channelId}>. The next poll baselines their gallery; new artworks are relayed there after that.`);
    return;
  }

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
      await safeEditReply(interaction, `That account is already being monitored here as @${existingById.username}${bindingText(db, guildId, existingById)}. Run \`/monitor channel <#channel> <username>\` to move it.`);
      return;
    }
  }
  const existing = db.findMonitorAuthorCI(guildId, profile.screen_name);
  if (existing) {
    await safeEditReply(interaction, `@${existing.username} is already being monitored here${bindingText(db, guildId, existing)}. Run \`/monitor channel <#channel> <username>\` to move it.`);
    return;
  }
  db.addMonitorAuthor(guildId, profile.screen_name, profile.id, 'twitter', null, interaction.channelId);
  await safeEditReply(interaction, `Now monitoring @${profile.screen_name}, relaying to <#${interaction.channelId}>. The next poll baselines their timeline; new posts are relayed there after that.`);
}

async function handleAwait(interaction: ChatInputCommandInteraction, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  if (!monitor) {
    await safeEditReply(interaction, 'The monitor service is not available.');
    return;
  }
  const value = interaction.options.getInteger('value') ?? 5;
  const unit = interaction.options.getString('unit') ?? 'minutes';
  const ms = unit === 'seconds' ? value * 1000 : value * 60_000;
  if (value < 1 || ms > 1_800_000) {
    await safeEditReply(interaction, 'Wait time must be between 1 second and 30 minutes.');
    return;
  }
  monitor.armAwait(guildId, interaction.channelId, interaction.user.id, ms, interaction);
  await safeEditReply(interaction, `Waiting **${formatMs(ms)}** for a link in this server. Paste any \`x.com\` / \`twitter.com\` tweet link or a \`pixiv.net\` / \`phixiv.net\` artwork or user link in any channel — I'll add its author to the monitor.`);
}

function findDestConflict(db: DatabaseService, guildId: string, candidates: Array<MonitorAuthorRow & { guild_id: string }>): MonitorAuthorRow | null {
  for (const c of candidates) {
    if (c.user_id) {
      const byId = db.findMonitorAuthorByUserId(guildId, c.user_id);
      if (byId) return byId;
    }
  }
  for (const c of candidates) {
    const byName = db.findMonitorAuthorCI(guildId, c.username);
    if (byName) return byName;
  }
  return null;
}

function performMigrate(db: DatabaseService, monitor: TweetMonitorService, guildId: string, source: MonitorAuthorRow, sourceGuildId: string, channelId: string): string {
  db.cloneMonitorAuthor(guildId, source, channelId);
  const guildLabel = monitor.getGuildName(sourceGuildId) ?? sourceGuildId;
  const cursorNote = source.last_tweet_id ? ` (last \`${source.last_tweet_id}\`)` : '';
  return `Migrated **${authorName(source)}** from **${guildLabel}** — config and poll cursor copied${cursorNote}.\nRelaying to <#${channelId}>. The first poll catches up anything newer than the cursor; new posts relay here from then on. **${guildLabel} still monitors them too.**`;
}

async function handleMigrate(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  if (!monitor) {
    await safeEditReply(interaction, 'The monitor service is not available.');
    return;
  }
  const raw = interaction.options.getString('username', true);
  const clean = raw.replace(/^@/, '').trim();
  if (!clean) {
    await safeEditReply(interaction, `Invalid username \`${raw}\`.`);
    return;
  }

  let candidates = db.findMonitorAuthorsGlobalByUserId(clean);
  if (candidates.length === 0) candidates = db.findMonitorAuthorsGlobalCI(clean);
  candidates = candidates.filter((c) => c.guild_id !== guildId && monitor.getGuildName(c.guild_id) !== null);
  if (candidates.length === 0) {
    await safeEditReply(interaction, `\`${clean}\` is not monitored in any other guild the bot can see. Use \`/monitor add\` to add it here from scratch.`);
    return;
  }

  const conflict = findDestConflict(db, guildId, candidates);
  if (conflict) {
    await safeEditReply(interaction, `${authorName(conflict)} is already being monitored here${bindingText(db, guildId, conflict)}. Nothing to migrate.`);
    return;
  }

  if (candidates.length === 1) {
    await safeEditReply(interaction, performMigrate(db, monitor, guildId, candidates[0], candidates[0].guild_id, interaction.channelId));
    return;
  }

  const options = candidates.slice(0, 25).map((c) => {
    const guild = monitor.getGuildName(c.guild_id) ?? c.guild_id;
    const row = db.getMonitorAuthor(c.guild_id, c.username);
    const name = row ? authorName(row) : `${c.platform === 'pixiv' ? '' : '@'}${c.username}`;
    const detail = row?.channel_id
      ? ' · bound to a channel'
      : (row?.last_tweet_id ? ` · last \`${row.last_tweet_id}\`` : ' · not baselined');
    return { label: guild, value: `${c.guild_id}:${c.username}`, description: `${name}${detail}` };
  });
  const row = makeSelectRow(MONITOR_MIGRATE_SELECT_ID, 'Choose the source guild', options);
  await interaction.editReply({
    content: `**Migrate \`${clean}\` — monitored in ${candidates.length} other guilds. Pick the source to clone into this server:**`,
    components: [row],
  });
}

export async function handleMigrateSelect(
  interaction: StringSelectMenuInteraction,
  db: DatabaseService,
  monitor: TweetMonitorService | undefined,
): Promise<void> {
  const guildId = interaction.guildId;
  const selected = interaction.values[0];
  if (!guildId || !selected) return;
  const sep = selected.indexOf(':');
  if (sep === -1) return;
  const sourceGuildId = selected.slice(0, sep);
  const sourceUsername = selected.slice(sep + 1);

  try {
    await interaction.deferUpdate();
    if (!monitor) {
      await interaction.editReply('The monitor service is not available.');
      return;
    }
    const source = db.getMonitorAuthor(sourceGuildId, sourceUsername);
    if (!source) {
      await interaction.editReply({ content: 'That author is no longer monitored in the selected guild.', components: [] });
      return;
    }
    const conflict = (source.user_id && db.findMonitorAuthorByUserId(guildId, source.user_id))
      || db.findMonitorAuthorCI(guildId, source.username);
    if (conflict) {
      await interaction.editReply({
        content: `${authorName(conflict)} is already being monitored here${bindingText(db, guildId, conflict)}. Nothing to migrate.`,
        components: [],
      });
      return;
    }
    await interaction.editReply({
      content: performMigrate(db, monitor, guildId, source, sourceGuildId, interaction.channelId),
      components: [],
    });
  } catch (err) {
    const e = err as { code?: number } | undefined;
    if (e && typeof e === 'object' && e.code === 10062) {
      console.log('[Monitor] migrate select: interaction expired or already handled (10062) — ignored');
    } else {
      console.error(`[Monitor] migrate select failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
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
  const options = authors.slice(0, 25).map((a, i) => {
    const bound = a.channel_id
      ? ` in <#${a.channel_id}>`
      : (monitor.getAuthorChannel(guildId, a) ? ' (server default channel)' : ' — no channel');
    return {
      label: `${i + 1}. ${authorName(a)}`,
      value: a.username,
      description: (a.platform === 'pixiv' ? `pixiv user ${a.username}` : (a.user_id ? `user ${a.user_id}` : 'user id unknown')) + bound,
    };
  });
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
    const channelId = monitor.getAuthorChannel(guildId, author);
    if (!channelId) {
      await interaction.editReply({
        content: `${authorName(author)} is monitored, but has no relay channel. Set one with \`/monitor channel <#channel> <username>\` (or set the server default).`,
        components: [],
      });
      return;
    }
    const kind = author.platform === 'pixiv' ? 'artwork' : 'post';
    await interaction.editReply({ content: `Fetching latest ${kind} from ${authorName(author)}...`, components: [] });
    const result = await monitor.verify(author, guildId);
    let message: string;
    if (result.reason === 'identity-mismatch') {
      message = `Cannot verify @${author.username} — the handle now belongs to a different account than the tracked user \`${author.user_id}\` (handle recycled). Remove it and re-add the author with the current handle.`;
    } else if (result.reason === 'duplicate') {
      message = `${authorName(author)}'s latest ${kind} (\`${result.tweetId}\`) was already sent to <#${channelId}> — skipped (bot does not repost the same link).`;
    } else if (!result.found) {
      message = `${authorName(author)} has no ${kind === 'artwork' ? 'artworks' : 'posts with media'} (or could not be fetched).`;
    } else if (!result.channelId) {
      message = `${authorName(author)}'s latest ${kind} is \`${result.tweetId}\`, but no target channel is set. Run \`/monitor channel\` first.`;
    } else {
      message = result.posted
        ? `Sent ${authorName(author)}'s latest ${kind} (\`${result.tweetId}\`) to <#${channelId}>.`
        : `Found ${authorName(author)}'s latest ${kind} (\`${result.tweetId}\`), but failed to post to <#${channelId}>.`;
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
    label: `${i + 1}. ${authorName(a)}`,
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
        const author = db.getMonitorAuthor(guildId, username);
        if (author?.platform === 'pixiv') {
          await interaction.editReply({
            content: `**${author.display_name ?? author.username}** is a pixiv artist — new artworks are always relayed. Pixiv filtering is not supported yet.`,
            components: [],
          });
          break;
        }
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
  if (!monitor) {
    await safeEditReply(interaction, 'The monitor service is not available.');
    return;
  }
  if (authors.every((a) => !monitor.getAuthorChannel(guildId, a))) {
    await safeEditReply(interaction, 'None of the monitored authors have a relay channel. Set one with `/monitor channel <#channel> <username>` (or the server default).');
    return;
  }
  await safeEditReply(interaction, `Verifying ${authors.length} author(s)...`);
  const result = await monitor.verifyAll(guildId);
  const lines = result.entries.map((e) => {
    const a = db.getMonitorAuthor(guildId, e.username);
    const name = a ? authorName(a) : `@${e.username}`;
    switch (e.status) {
      case 'posted': return `\`${name}\` → sent \`${e.tweetId}\` to ${e.channelId ? `<#${e.channelId}>` : 'their channel'}`;
      case 'skipped': return `\`${name}\` → skipped (already up to date)`;
      case 'duplicate': return `\`${name}\` → already posted, skipped`;
      case 'identity-mismatch': return `\`${name}\` → handle now belongs to a different account; remove and re-add`;
      case 'no-posts': return `\`${name}\` → no posts with media found`;
      case 'no-channel': return `\`${name}\` → no channel set`;
      default: return `\`${name}\` → failed`;
    }
  });
  const header = result.aborted
    ? `**Verify all aborted by /cancel** (${result.entries.length} author(s) processed before stop)`
    : `**Verify all (${result.entries.length} tracked)**`;
  await safeEditReply(interaction,
    header + '\n' +
    lines.join('\n'));
}

async function handleList(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const authors = db.listMonitorAuthors(guildId);
  const channel = db.getMonitorConfig(guildId, 'target_channel_id');
  const interval = monitor?.getIntervalMs(guildId) ?? 900_000;
  const fixers = monitor?.getFixers(guildId) ?? DEFAULT_FIXERS;
  const pixivFixers = monitor?.getFixers(guildId, 'pixiv') ?? DEFAULT_PIXIV_FIXERS;

  const footer =
    `Default channel: ${channel ? `<#${channel}>` : 'not set'} · Interval: ${formatMs(interval)}\n` +
    `X fixers: ${fixers.map((f) => `\`${f}\``).join(' ')}\n` +
    `Pixiv fixers: ${pixivFixers.map((f) => `\`${f}\``).join(' ')}`;

  if (authors.length === 0) {
    await safeEditReply(interaction,
      `No authors being monitored in this server yet. Use \`/monitor add <username>\` (or \`platform=pixiv\` with a pixiv user ID/URL).\n\n${footer}`);
    return;
  }

  const sections: string[] = [];
  for (const platform of ['twitter', 'pixiv'] as const) {
    const group = authors.filter((a) => a.platform === platform);
    if (group.length === 0) continue;
    const lines = group.map((a) =>
      `\`${a.user_id ?? '?'}\` - ${authorName(a)} — ${configSummary(a)}` +
      (a.channel_id ? ` → <#${a.channel_id}>` : '') +
      (a.last_tweet_id ? ` · last \`${a.last_tweet_id}\`` : ' · not yet baselined'));
    const label = platform === 'pixiv' ? 'Pixiv' : 'Twitter/X';
    sections.push(`**${label}** (${group.length})`, ...lines);
  }

  const chunks: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of sections) {
    const addition = (current.length > 0 ? 1 : 0) + line.length;
    if (current.length > 0 && length + addition > 4096) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(line);
    length += addition;
  }
  if (current.length > 0) chunks.push(current);

  const title = `Monitored authors in this server (${authors.length})`;
  const embeds = chunks.map((chunk, i) => {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(chunks.length > 1 ? `${title} (${i + 1}/${chunks.length})` : title)
      .setDescription(chunk.join('\n'));
    if (i === chunks.length - 1) embed.setFooter({ text: footer });
    return embed;
  });
  await interaction.editReply({ embeds });
}

async function handleChannel(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const channel = interaction.options.getChannel('channel', true);
  const username = interaction.options.getString('username');
  if (username) {
    const clean = username.replace(/^@/, '').trim();
    const author = db.findMonitorAuthorCI(guildId, clean) ?? db.getMonitorAuthor(guildId, clean);
    if (!author) {
      await safeEditReply(interaction, `\`${clean}\` is not being monitored in this server.`);
      return;
    }
    db.updateMonitorAuthorChannel(guildId, author.username, channel.id);
    await safeEditReply(interaction, `**${authorName(author)}** now relays to <#${channel.id}>.`);
    return;
  }
  db.setMonitorConfig(guildId, 'target_channel_id', channel.id);
  monitor?.setChannel(guildId, channel.id);
  await safeEditReply(interaction, `Server default relay channel set to <#${channel.id}>. New authors relay there unless bound to their own channel.`);
}

async function handleFixers(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const platform = (interaction.options.getString('platform') ?? 'twitter') as MonitorPlatform;
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
  db.setMonitorConfig(guildId, platform === 'pixiv' ? 'pixiv_fixer_list' : 'fixer_list', JSON.stringify(valid));
  monitor?.setFixers(guildId, valid, platform);
  const dropped = list.length - valid.length;
  await safeEditReply(interaction,
    `${platform} fixer list set (in order): ${valid.map((d) => `\`${d}\``).join(' ')}` +
    (dropped > 0 ? `\nSkipped ${dropped} invalid domain(s).` : ''));
}

async function handleInterval(interaction: ChatInputCommandInteraction, db: DatabaseService, monitor: TweetMonitorService | undefined, guildId: string): Promise<void> {
  const value = interaction.options.getInteger('value', true);
  const unit = interaction.options.getString('unit', true) ?? 'minutes';
  const ms = unit === 'seconds' ? value * 1000 : value * 60_000;
  if (value < 1 || ms > 86_400_000) {
    await safeEditReply(interaction, 'Interval must be between 1 second and 86400 seconds (24 hours).');
    return;
  }
  db.setMonitorConfig(guildId, 'poll_interval_ms', String(ms));
  monitor?.setIntervalMs(guildId, ms);
  await safeEditReply(interaction, `Poll interval set to ${formatMs(ms)}.`);
}
