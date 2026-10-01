import { cn } from '@/lib/utils';
import { itemSource, MusicSource, sourceLabels, useSource } from '@/lib/source-provider';

// Short on-card labels; the full name is in the tooltip.
const shortLabels: Record<MusicSource, string> = { qobuz: 'QOBUZ', apple: 'APPLE', deezer: 'DEEZER', tidal: 'TIDAL' };

/**
 * Which catalog an item came from, read from the item itself. When that differs
 * from the source currently selected (e.g. results still on screen from before a
 * switch, or a mixed list), the tag is highlighted so the change is obvious.
 */
const SourceTag = ({ item, className }: { item: unknown; className?: string }) => {
    const { source } = useSource();
    const from = itemSource(item);
    const mismatch = from !== source;
    return (
        <p
            className={cn(
                'text-[10px] px-1 rounded-[3px] h-[18px] shrink-0 flex items-center justify-center font-semibold tracking-wide border',
                mismatch ? 'bg-amber-500 text-black border-amber-500' : 'border-primary/60 text-primary',
                className
            )}
            title={`From ${sourceLabels[from]}${mismatch ? ` — not the selected source (${sourceLabels[source]})` : ''}`}
        >
            {shortLabels[from]}
        </p>
    );
};

export default SourceTag;
