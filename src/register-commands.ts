import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import { data as downloadCommand } from './commands/download';
import { data as cancelCommand } from './commands/cancel';
import { data as monitorCommand } from './commands/monitor';
import { data as deleteCommand } from './commands/delete';
import { data as editCommand } from './commands/edit';
import { data as helpCommand } from './commands/help';

config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIds = (process.env.GUILD_ID ?? '').split(',').map((id) => id.trim()).filter(Boolean);

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set in .env');
  process.exit(1);
}

const commands = [downloadCommand.toJSON(), cancelCommand.toJSON(), monitorCommand.toJSON(), deleteCommand.toJSON(), editCommand.toJSON(), helpCommand.toJSON()];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands...');

    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    console.log('Cleared global commands (guild-scoped only — avoids global/guild duplicates)');

    let targets = guildIds;
    if (targets.length === 0) {
      const guilds = (await rest.get(Routes.userGuilds())) as { id: string }[];
      targets = guilds.map((g) => g.id);
    }
    if (targets.length === 0) {
      console.log('No guilds to register into.');
      return;
    }
    for (const guildId of targets) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`Registered ${commands.length} commands in guild ${guildId}`);
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();
