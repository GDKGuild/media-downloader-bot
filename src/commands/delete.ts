import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { safeEditReply } from '../utils/interactionUtils';

export const data = new SlashCommandBuilder()
  .setName('delete')
  .setDescription('Delete a message sent by the bot (by message ID)')
  .addStringOption(option =>
    option.setName('message-id')
      .setDescription('ID of the message to delete')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('channel-id')
      .setDescription('ID of the channel where the message lives (defaults to current channel; works across servers)')
      .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message-id', true);
  const targetId = interaction.options.getString('channel-id') ?? interaction.channelId;
  const channel = await interaction.client.channels.fetch(targetId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await safeEditReply(interaction, 'The target is not a text channel the bot can see.');
    return;
  }

  try {
    const message = await channel.messages.fetch(messageId);
    if (!message.deletable) {
      await safeEditReply(interaction, 'That message cannot be deleted (wrong channel, or the bot lacks permission).');
      return;
    }
    await message.delete();
    await safeEditReply(interaction, `Deleted message \`${messageId}\`.`);
  } catch (err) {
    console.error(`[Delete] Failed to delete ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
    await safeEditReply(interaction, `Could not delete message \`${messageId}\` — is the ID correct and in the selected channel?`);
  }
}
