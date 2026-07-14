// Qobuz-DL Discord bot entry point.
//
// Usage:  node bot/index.mjs   (or: npm run bot)
//
// Requires the slash commands to have been registered once via
// `node bot/register-commands.mjs` (npm run bot:register).

import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { handlers } from './commands.mjs';
import { config } from './lib/config.mjs';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
    console.log(`✅ Logged in as ${readyClient.user.tag}`);
    console.log(`   Talking to Qobuz-DL app at ${config.appUrl}`);
    console.log(`   Commands: ${Object.keys(handlers).map((n) => `/${n}`).join(', ')}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const handler = handlers[interaction.commandName];
    if (!handler) return;

    try {
        await interaction.deferReply();
        await handler(interaction);
    } catch (error) {
        console.error(`Error handling /${interaction.commandName}:`, error);
        const message = `⚠️ ${error.message || 'Something went wrong handling that command.'}`;
        try {
            if (interaction.deferred || interaction.replied) {
                await interaction.editReply(message);
            } else {
                await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
            }
        } catch {
            // Interaction likely expired; nothing more we can do.
        }
    }
});

client.login(config.token).catch((error) => {
    console.error('❌ Failed to log in. Check DISCORD_BOT_TOKEN.', error.message);
    process.exit(1);
});
