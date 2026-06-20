import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';

export async function safeEditReply(
  interaction: ChatInputCommandInteraction,
  content: string
): Promise<boolean> {
  try {
    await interaction.editReply(content);
    return true;
  } catch (err: any) {
    if (err?.code === 50027) {
      console.log('Interaction expired before editReply could be sent');
      return false;
    }
    throw err;
  }
}

export async function safeSendDM(
  interaction: ChatInputCommandInteraction,
  content: string
): Promise<void> {
  try {
    await interaction.user.send(content);
  } catch (err: any) {
    console.error(`Failed to send DM to ${interaction.user.tag}: ${err?.message ?? err}`);
  }
}
