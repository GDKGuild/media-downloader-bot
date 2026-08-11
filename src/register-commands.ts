import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import { data as downloadCommand } from './commands/download';
import { data as cancelCommand } from './commands/cancel';
import { data as monitorCommand } from './commands/monitor';

config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildIds = (process.env.GUILD_ID ?? '').split(',').map((id) => id.trim()).filter(Boolean);

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set in .env');
  process.exit(1);
}

const commands = [downloadCommand.toJSON(), cancelCommand.toJSON(), monitorCommand.toJSON()];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands...');

    if (guildIds.length > 0) {
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      console.log('Cleared global commands');
      for (const guildId of guildIds) {
        await rest.put(
          Routes.applicationGuildCommands(clientId, guildId),
          { body: commands }
        );
        console.log(`Registered ${commands.length} commands for guild ${guildId}`);
      }
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log(`Registered ${commands.length} global commands`);

      const guilds = (await rest.get(Routes.userGuilds())) as { id: string }[];
      for (const guild of guilds) {
        const existing = (await rest.get(Routes.applicationGuildCommands(clientId, guild.id))) as unknown[];
        if (existing.length > 0) {
          await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
          console.log(`Cleared stale guild commands in ${guild.id}`);
        }
      }
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();
