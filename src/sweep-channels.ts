import { Client, GatewayIntentBits, PermissionFlagsBits, ChannelType, GuildChannel, TextChannel, NewsChannel, ThreadChannel, ForumChannel } from 'discord.js';
import { config } from 'dotenv';

config();

interface ReportEntry {
  type: string;
  name: string;
  parent: string | null;
  id: string;
  issues: string[];
}

const VIEW_CHANNEL_TYPES = [
  ChannelType.GuildText, ChannelType.GuildAnnouncement,
  ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread,
  ChannelType.GuildVoice, ChannelType.GuildStageVoice,
  ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildCategory,
];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error('DISCORD_TOKEN must be set in .env');
    process.exit(1);
  }

  const guildId = process.argv[2] || process.env.GUILD_ID;
  if (!guildId) {
    console.error('Pass a guild ID as argument or set GUILD_ID in .env');
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', async () => {
    console.log(`Logged in as ${client.user!.tag}\n`);

    const guild = await client.guilds.fetch(guildId);
    if (!guild) {
      console.error('Guild not found');
      await client.destroy();
      process.exit(1);
    }
    console.log(`Guild: ${guild.name} (${guild.id})\n`);

    const report: ReportEntry[] = [];

    await guild.channels.fetch();
    const botMember = guild.members.me;
    if (!botMember) {
      console.error('Bot member not found in guild');
      await client.destroy();
      process.exit(1);
    }

    // All cached channels + threads
    const allEntries = Array.from(guild.channels.cache.values());

    for (const entry of allEntries) {
      if (!(entry instanceof GuildChannel || entry instanceof ThreadChannel)) continue;
      const perms = entry.permissionsFor(botMember);
      if (!perms) continue;

      const issues: string[] = [];

      if (VIEW_CHANNEL_TYPES.includes(entry.type)) {
        if (!perms.has(PermissionFlagsBits.ViewChannel)) issues.push('missing ViewChannel');
      }
      if (entry.type === ChannelType.GuildText || entry.type === ChannelType.GuildAnnouncement) {
        if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) issues.push('missing ReadMessageHistory');
        if (!perms.has(PermissionFlagsBits.SendMessages)) issues.push('missing SendMessages');
      }
      if (entry.type === ChannelType.GuildVoice) {
        if (!perms.has(PermissionFlagsBits.Connect)) issues.push('missing Connect');
      }
      if (entry.type === ChannelType.GuildForum) {
        if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) issues.push('missing ReadMessageHistory');
        if (!perms.has(PermissionFlagsBits.SendMessages)) issues.push('missing SendMessages');
      }
      if (entry instanceof ThreadChannel) {
        if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) issues.push('missing ReadMessageHistory');
        if (!perms.has(PermissionFlagsBits.SendMessagesInThreads)) issues.push('missing SendMessagesInThreads');
        if (entry.archived) issues.push('archived');
      }

      if (issues.length > 0) {
        const parentName = entry.parent?.name || null;
        report.push({
          type: ChannelType[entry.type] !== undefined ? ChannelType[entry.type] : String(entry.type),
          name: entry.name,
          parent: parentName,
          id: entry.id,
          issues,
        });
      }
    }

    // Additional threads not yet cached — fetch active + archived from each text/forum channel
    const threadParents = allEntries.filter(
      (e): e is TextChannel | NewsChannel | ForumChannel =>
        e instanceof TextChannel || e instanceof NewsChannel || e instanceof ForumChannel
    );

    for (const ch of threadParents) {
      // Active threads
      try {
        const activeThreads = await ch.threads.fetchActive();
        for (const [, thread] of activeThreads.threads) {
          if (allEntries.some(e => e.id === thread.id)) continue;
          const perms = thread.permissionsFor(botMember);
          if (!perms) continue;

          const issues: string[] = [];
          if (!perms.has(PermissionFlagsBits.ViewChannel)) issues.push('missing ViewChannel');
          if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) issues.push('missing ReadMessageHistory');
          if (thread.archived) issues.push('archived');

          if (issues.length > 0) {
            report.push({
              type: 'PublicThread',
              name: thread.name,
              parent: ch.name,
              id: thread.id,
              issues,
            });
          }
        }
      } catch {}

      // Archived threads
      try {
        const archivedThreads = await ch.threads.fetchArchived();
        for (const [, thread] of archivedThreads.threads) {
          if (allEntries.some(e => e.id === thread.id)) continue;
          const perms = thread.permissionsFor(botMember);
          if (!perms) continue;

          const issues: string[] = [];
          if (!perms.has(PermissionFlagsBits.ViewChannel)) issues.push('missing ViewChannel');
          if (!perms.has(PermissionFlagsBits.ReadMessageHistory)) issues.push('missing ReadMessageHistory');
          if (thread.archived) issues.push('archived');

          if (issues.length > 0) {
            report.push({
              type: 'ArchivedThread',
              name: thread.name,
              parent: ch.name,
              id: thread.id,
              issues,
            });
          }
        }
      } catch {}
    }

    if (report.length === 0) {
      console.log('No inaccessible channels or threads found. The bot has full access.');
    } else {
      console.log(`Found ${report.length} inaccessible channel(s)/thread(s):\n`);
      for (const entry of report) {
        const parentStr = entry.parent ? ` (under #${entry.parent})` : '';
        console.log(`  [${entry.type}] #${entry.name}${parentStr}`);
        console.log(`    ID: ${entry.id}`);
        console.log(`    Issues: ${entry.issues.join(', ')}`);
        console.log('');
      }
    }

    await client.destroy();
    process.exit(0);
  });

  client.on('error', (err) => {
    console.error('Client error:', err);
    process.exit(1);
  });

  await client.login(token);
}

main().catch((err) => {
  console.error('Sweep failed:', err);
  process.exit(1);
});
