import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { safeEditReply } from '../utils/interactionUtils';

export const data = new SlashCommandBuilder()
  .setName('edit')
  .setDescription('Edit a message sent by the bot (by message ID)')
  .addStringOption(option =>
    option.setName('message-id')
      .setDescription('ID of the message to edit')
      .setRequired(true))
  .addStringOption(option =>
    option.setName('content')
      .setDescription('New message text (max 2000 characters)')
      .setRequired(true)
      .setMaxLength(2000))
  .addStringOption(option =>
    option.setName('channel-id')
      .setDescription('ID of the channel where the message lives (defaults to current channel; works across servers)')
      .setRequired(false));

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const messageId = interaction.options.getString('message-id', true);
  const content = interaction.options.getString('content', true);
  const targetId = interaction.options.getString('channel-id') ?? interaction.channelId;
  const channel = await interaction.client.channels.fetch(targetId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await safeEditReply(interaction, 'The target is not a text channel the bot can see.');
    return;
  }

  try {
    const message = await channel.messages.fetch(messageId);
    if (message.author.id !== interaction.client.user?.id) {
      await safeEditReply(interaction, 'That message was not sent by the bot.');
      return;
    }
    if (!message.editable) {
      await safeEditReply(interaction, 'That message cannot be edited (the bot lacks permission or it is too old).');
      return;
    }
    await message.edit(content);
    await safeEditReply(interaction, `Edited message \`${messageId}\`.`);
  } catch (err) {
    console.error(`[Edit] Failed to edit ${messageId}: ${err instanceof Error ? err.message : String(err)}`);
    await safeEditReply(interaction, `Could not edit message \`${messageId}\` — is the ID correct and in the selected channel?`);
  }
}
