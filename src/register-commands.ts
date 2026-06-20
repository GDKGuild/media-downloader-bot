import { REST, Routes } from 'discord.js';
import { config } from 'dotenv';
import { data as downloadCommand } from './commands/download';
import { data as cancelCommand } from './commands/cancel';

config();

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set in .env');
  process.exit(1);
}

const commands = [downloadCommand.toJSON(), cancelCommand.toJSON()];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log('Registering slash commands...');

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`Registered ${commands.length} commands for guild ${guildId}`);
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log(`Registered ${commands.length} global commands`);
    }
  } catch (error) {
    console.error('Failed to register commands:', error);
    process.exit(1);
  }
})();
