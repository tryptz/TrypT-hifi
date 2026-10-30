import { cn } from '@/lib/utils';
import { isDeezerAI } from '@/lib/deezer';

// Deezer's own AI-music detector flagged this album (or a track's album).
// Renders nothing for anything else.
const AITag = ({ item, className }: { item: unknown; className?: string }) => {
    if (!isDeezerAI(item)) return null;
    return (
        <p
            className={cn(
                'text-[10px] px-1 rounded-[3px] h-[18px] shrink-0 flex items-center justify-center font-semibold tracking-wide bg-fuchsia-600 text-white',
                className
            )}
            title='AI-generated content: Deezer detected tracks on this album made with generative AI'
        >
            AI
        </p>
    );
};

export default AITag;
