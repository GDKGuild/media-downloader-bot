import { config } from 'dotenv';
import { createBot } from './bot';

config();

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('DISCORD_TOKEN must be set in .env');
  console.error('Copy .env.example to .env and fill in your values');
  process.exit(1);
}

const client = createBot();

client.login(token).catch((error) => {
  console.error('Failed to login:', error);
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.destroy();
  process.exit(0);
});
