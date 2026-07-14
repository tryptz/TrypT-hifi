// Slash command definitions and handlers.
// Each command defers its reply (Qobuz lookups take a moment) and then edits it
// with a rich embed. Handlers are keyed by command name.

import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } from 'discord.js';
import { getAlbum, getDownloadUrl, probeSize, searchMusic } from './lib/qobuz-client.mjs';
import { albumEmbed, searchEmbed, statsEmbed, trackEmbed } from './lib/embeds.mjs';
import { QUALITY_CHOICES, formatArtists, formatTitle, humanBytes, qualityExtension, qualityLabel, sanitizeFilename } from './lib/format.mjs';
import { config } from './lib/config.mjs';

// ---- Command definitions (registered with Discord) -------------------------

export const commandData = [
    new SlashCommandBuilder()
        .setName('download')
        .setDescription('Search for a track and download it from Qobuz')
        .addStringOption((o) => o.setName('query').setDescription('Song name, artist, or a Qobuz track URL').setRequired(true))
        .addStringOption((o) => o.setName('quality').setDescription('Audio quality').addChoices(...QUALITY_CHOICES)),
    new SlashCommandBuilder()
        .setName('track')
        .setDescription('Show song info and album art')
        .addStringOption((o) => o.setName('query').setDescription('Song name, artist, or a Qobuz track URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('album')
        .setDescription('Show album art, tracklist, and details')
        .addStringOption((o) => o.setName('query').setDescription('Album name, artist, or a Qobuz album URL').setRequired(true)),
    new SlashCommandBuilder()
        .setName('search')
        .setDescription('Search Qobuz and list the top results')
        .addStringOption((o) => o.setName('query').setDescription('What to search for').setRequired(true))
        .addStringOption((o) =>
            o
                .setName('type')
                .setDescription('Result type')
                .addChoices({ name: 'Albums', value: 'albums' }, { name: 'Tracks', value: 'tracks' }, { name: 'Artists', value: 'artists' })
        ),
    new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Cool statistics about an album (quality, sizes, track distribution)')
        .addStringOption((o) => o.setName('query').setDescription('Album name, artist, or a Qobuz album URL').setRequired(true))
].map((c) => c.toJSON());

// ---- Shared helpers --------------------------------------------------------

function firstResult(results, type) {
    return results?.[type]?.items?.[0] || null;
}

// Resolve the full album (with tracklist) for a query, whether the top hit is an
// album or a track that belongs to one.
async function resolveAlbum(query) {
    const results = await searchMusic(query);
    const album = firstResult(results, 'albums');
    const track = firstResult(results, 'tracks');
    const albumId = album?.id || track?.album?.id;
    if (!albumId) return null;
    const full = await getAlbum(albumId);
    return full || album || track?.album || null;
}

// ---- Handlers --------------------------------------------------------------

async function handleDownload(interaction) {
    const query = interaction.options.getString('query', true);
    const quality = interaction.options.getString('quality') || config.defaultQuality;

    const results = await searchMusic(query);
    const track = firstResult(results, 'tracks');
    if (!track) {
        await interaction.editReply(`No tracks found for **${query}**.`);
        return;
    }

    const url = await getDownloadUrl(track.id, quality);
    if (!url) {
        await interaction.editReply(`Couldn't get a download link for **${formatTitle(track)}**. It may not be streamable in this region.`);
        return;
    }

    const embed = trackEmbed(track).setFooter({ text: `Quality: ${qualityLabel(quality)}` });
    const size = await probeSize(url);

    // Small enough to hand Discord the actual file; otherwise fall back to a link.
    if (size && size <= config.maxUploadBytes) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const filename = `${sanitizeFilename(`${formatArtists(track)} - ${formatTitle(track)}`)}.${qualityExtension(quality)}`;
            const attachment = new AttachmentBuilder(buffer, { name: filename });
            await interaction.editReply({ content: `⬇️ **${formatTitle(track)}** — ${formatArtists(track)}`, embeds: [embed], files: [attachment] });
            return;
        } catch {
            // Fall through to the link-based reply below.
        }
    }

    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Download').setStyle(ButtonStyle.Link).setURL(url).setEmoji('⬇️'));
    const note = size ? `File is ${humanBytes(size)} — too large to attach here, so here's a direct link (valid ~15 min).` : `Here's your download link (valid ~15 min).`;
    await interaction.editReply({ content: note, embeds: [embed], components: [row] });
}

async function handleTrack(interaction) {
    const query = interaction.options.getString('query', true);
    const results = await searchMusic(query);
    const track = firstResult(results, 'tracks') || firstResult(results, 'albums');
    if (!track) {
        await interaction.editReply(`No results found for **${query}**.`);
        return;
    }
    await interaction.editReply({ embeds: [trackEmbed(track)] });
}

async function handleAlbum(interaction) {
    const query = interaction.options.getString('query', true);
    const album = await resolveAlbum(query);
    if (!album) {
        await interaction.editReply(`No albums found for **${query}**.`);
        return;
    }
    await interaction.editReply({ embeds: [albumEmbed(album, album.tracks?.items)] });
}

async function handleSearch(interaction) {
    const query = interaction.options.getString('query', true);
    const type = interaction.options.getString('type') || 'albums';
    const results = await searchMusic(query);
    const items = results?.[type]?.items || [];
    await interaction.editReply({ embeds: [searchEmbed(query, type, items)] });
}

async function handleStats(interaction) {
    const query = interaction.options.getString('query', true);
    const album = await resolveAlbum(query);
    if (!album) {
        await interaction.editReply(`No albums found for **${query}**.`);
        return;
    }
    await interaction.editReply({ embeds: [statsEmbed(album, album.tracks?.items)] });
}

export const handlers = {
    download: handleDownload,
    track: handleTrack,
    album: handleAlbum,
    search: handleSearch,
    stats: handleStats
};
