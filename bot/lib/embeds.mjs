// Embed builders that turn Qobuz API objects into rich Discord embeds.

import { EmbedBuilder } from 'discord.js';
import { config } from './config.mjs';
import {
    bar,
    estimatePcmBytes,
    formatArtists,
    formatClock,
    formatDuration,
    formatReleaseDate,
    formatTitle,
    getCoverUrl,
    hiResBadge,
    humanBytes,
    truncate
} from './format.mjs';

export function qobuzUrl(type, id) {
    return `https://open.qobuz.com/${type}/${id}`;
}

function qualityString(input) {
    const depth = input.maximum_bit_depth;
    const rate = input.maximum_sampling_rate;
    if (!depth || !rate) return hiResBadge(input);
    return `${hiResBadge(input)} · ${depth}-bit / ${rate} kHz`;
}

export function trackEmbed(track) {
    const cover = getCoverUrl(track);
    const embed = new EmbedBuilder()
        .setColor(config.embedColor)
        .setTitle(formatTitle(track))
        .setURL(qobuzUrl('track', track.id))
        .setAuthor({ name: formatArtists(track) })
        .addFields(
            { name: 'Album', value: truncate(track.album?.title || '—', 256), inline: true },
            { name: 'Duration', value: formatClock(track.duration), inline: true },
            { name: 'Released', value: formatReleaseDate(track), inline: true },
            { name: 'Quality', value: qualityString(track), inline: true },
            { name: 'Explicit', value: track.parental_warning ? 'Yes' : 'No', inline: true },
            { name: 'Track #', value: `${track.track_number ?? '—'}`, inline: true }
        );
    if (cover) embed.setThumbnail(cover);
    return embed;
}

export function albumEmbed(album, tracks) {
    const cover = getCoverUrl(album);
    const embed = new EmbedBuilder()
        .setColor(config.embedColor)
        .setTitle(formatTitle(album))
        .setURL(qobuzUrl('album', album.id))
        .setAuthor({ name: formatArtists(album) })
        .addFields(
            { name: 'Tracks', value: `${album.tracks_count ?? tracks?.length ?? '—'}`, inline: true },
            { name: 'Duration', value: formatDuration(album.duration), inline: true },
            { name: 'Released', value: formatReleaseDate(album), inline: true },
            { name: 'Quality', value: qualityString(album), inline: true },
            { name: 'Label', value: truncate(album.label?.name || '—', 256), inline: true },
            { name: 'Genre', value: truncate(album.genre?.name || '—', 256), inline: true }
        );
    if (cover) embed.setImage(cover);

    if (tracks && tracks.length) {
        const lines = [];
        let index = 0;
        for (const track of tracks) {
            const line = `\`${String(++index).padStart(2, '0')}\` ${formatTitle(track)} — \`${formatClock(track.duration)}\``;
            if (lines.join('\n').length + line.length > 3900) {
                lines.push(`…and ${tracks.length - index + 1} more`);
                break;
            }
            lines.push(line);
        }
        embed.setDescription(lines.join('\n'));
    }
    return embed;
}

export function searchEmbed(query, type, items) {
    const embed = new EmbedBuilder().setColor(config.embedColor).setTitle(`Search results for “${query}”`).setFooter({ text: `Showing top ${items.length} ${type}` });
    if (!items.length) {
        embed.setDescription(`No ${type} found.`);
        return embed;
    }
    const lines = items.slice(0, 10).map((item, i) => {
        if (type === 'artists') {
            return `**${i + 1}.** [${item.name}](${qobuzUrl('artist', item.id)}) · ${item.albums_count ?? 0} albums`;
        }
        const linkType = type === 'albums' ? 'album' : 'track';
        return `**${i + 1}.** [${formatTitle(item)}](${qobuzUrl(linkType, item.id)}) — ${formatArtists(item)}  ${hiResBadge(item)}`;
    });
    embed.setDescription(truncate(lines.join('\n'), 4000));
    const cover = getCoverUrl(items[0]);
    if (cover) embed.setThumbnail(cover);
    return embed;
}

// "Cool statistics" for an album — computed from the full tracklist.
export function statsEmbed(album, tracks) {
    const list = tracks || [];
    const count = list.length || album.tracks_count || 0;
    const totalDuration = list.reduce((sum, t) => sum + (t.duration || 0), 0) || album.duration || 0;
    const hiResCount = list.filter((t) => t.hires).length;
    const explicitCount = list.filter((t) => t.parental_warning).length;
    const maxDepth = Math.max(album.maximum_bit_depth || 0, ...list.map((t) => t.maximum_bit_depth || 0));
    const maxRate = Math.max(album.maximum_sampling_rate || 0, ...list.map((t) => t.maximum_sampling_rate || 0));
    const avgDuration = count ? totalDuration / count : 0;
    const estBytes = list.reduce(
        (sum, t) => sum + estimatePcmBytes(t.duration, t.maximum_bit_depth || album.maximum_bit_depth, (t.maximum_sampling_rate || album.maximum_sampling_rate) * 1000, 2),
        0
    );

    const longest = list.reduce((a, b) => ((b.duration || 0) > (a?.duration || 0) ? b : a), null);
    const shortest = list.reduce((a, b) => ((b.duration || Infinity) < (a?.duration || Infinity) ? b : a), null);

    const maxTrackDuration = Math.max(1, ...list.map((t) => t.duration || 0));
    const chartLines = list.slice(0, 20).map((t, i) => `\`${String(i + 1).padStart(2, '0')}\` ${bar(t.duration || 0, maxTrackDuration)} \`${formatClock(t.duration)}\``);
    if (list.length > 20) chartLines.push(`…and ${list.length - 20} more tracks`);

    const embed = new EmbedBuilder()
        .setColor(config.embedColor)
        .setTitle(`📊 Stats · ${formatTitle(album)}`)
        .setURL(qobuzUrl('album', album.id))
        .setAuthor({ name: formatArtists(album) })
        .addFields(
            { name: 'Tracks', value: `${count}`, inline: true },
            { name: 'Total Length', value: formatDuration(totalDuration), inline: true },
            { name: 'Avg / Track', value: formatClock(avgDuration), inline: true },
            { name: 'Peak Quality', value: maxDepth && maxRate ? `${maxDepth}-bit / ${maxRate} kHz` : hiResBadge(album), inline: true },
            { name: 'Hi-Res Tracks', value: count ? `${hiResCount}/${count} (${Math.round((hiResCount / count) * 100)}%)` : '—', inline: true },
            { name: 'Explicit', value: count ? `${explicitCount}/${count}` : '—', inline: true },
            { name: 'Est. FLAC Size', value: `~${humanBytes(Math.round(estBytes * 0.6))}`, inline: true },
            { name: 'Longest', value: longest ? `${truncate(formatTitle(longest), 40)} (${formatClock(longest.duration)})` : '—', inline: true },
            { name: 'Shortest', value: shortest ? `${truncate(formatTitle(shortest), 40)} (${formatClock(shortest.duration)})` : '—', inline: true }
        );

    if (chartLines.length) embed.setDescription(`**Track length distribution**\n${truncate(chartLines.join('\n'), 4000)}`);
    const cover = getCoverUrl(album);
    if (cover) embed.setThumbnail(cover);
    embed.setFooter({ text: `Label: ${album.label?.name || 'Unknown'} · ${formatReleaseDate(album)}` });
    return embed;
}
