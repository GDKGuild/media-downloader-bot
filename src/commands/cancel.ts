import { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { setCancel, setGlobalCancel, resetGlobalCancel } from '../services/cancelManager';
import { safeEditReply } from '../utils/interactionUtils';

export const data = new SlashCommandBuilder()
  .setName('cancel')
  .setDescription('Cancel the current download in this channel')
  .addBooleanOption(option =>
    option.setName('all')
      .setDescription('Cancel all active downloads (overrides channel-specific cancel)')
      .setRequired(false));

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const cancelAll = interaction.options.getBoolean('all');

  if (cancelAll) {
    setGlobalCancel();
    console.log(`[Cancel] All downloads cancelled by ${interaction.user.tag}`);
    await safeEditReply(interaction, 'All downloads cancelled. Any in-progress downloads will stop shortly.');
    return;
  }

  const channelId = interaction.channel?.id;
  if (!channelId) {
    await safeEditReply(interaction, 'Could not identify this channel.');
    return;
  }

  setCancel(channelId);
  console.log(`[Cancel] Download cancelled in channel ${channelId}`);
  await safeEditReply(interaction, 'Download cancelled. Any in-progress download in this channel will stop shortly.');
}
