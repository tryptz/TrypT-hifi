// Registers the bot's slash commands with Discord.
//
// Usage:  node bot/register-commands.mjs
//
// If DISCORD_GUILD_ID is set the commands are registered to that guild (they
// appear instantly — ideal for development). Otherwise they are registered
// globally, which can take up to an hour to propagate.

import { REST, Routes } from 'discord.js';
import { commandData } from './commands.mjs';
import { config } from './lib/config.mjs';

async function main() {
    const rest = new REST({ version: '10' }).setToken(config.token);
    const route = config.guildId ? Routes.applicationGuildCommands(config.clientId, config.guildId) : Routes.applicationCommands(config.clientId);

    console.log(`Registering ${commandData.length} commands ${config.guildId ? `to guild ${config.guildId}` : 'globally'}…`);
    const result = await rest.put(route, { body: commandData });
    console.log(`✅ Registered ${result.length} command(s): ${result.map((c) => `/${c.name}`).join(', ')}`);
}

main().catch((error) => {
    console.error('❌ Failed to register commands:', error.message);
    process.exit(1);
});
