import { cn } from '@/lib/utils';

// The Dolby double-D mark (path from Simple Icons, CC0-1.0). Dolby, Dolby Atmos and
// the double-D symbol are trademarks of Dolby Laboratories; shown only to label
// releases and tracks that have a Dolby Atmos mix.
const DOLBY_MARK_PATH =
    'M0 3.564v16.872h2.488c4.648 0 8.438-3.788 8.438-8.436s-3.79-8.436-8.438-8.436H0zm21.512 0c-4.648 0-8.438 3.788-8.438 8.436s3.79 8.436 8.438 8.436H24V3.564h-2.488z';

/** Badge for TIDAL releases and tracks with a Dolby Atmos (E-AC-3 JOC) mix. */
const DolbyAtmosBadge = ({ className }: { className?: string }) => (
    <p
        className={cn(
            'text-[10px] bg-primary text-primary-foreground px-1 rounded-[3px] h-[18px] shrink-0 flex items-center gap-[3px] font-semibold tracking-wide',
            className
        )}
        title='Dolby Atmos'
    >
        {/* viewBox cropped to the mark's own bounds (24 x 16.872) so it fills the badge height. */}
        <svg viewBox='0 3.564 24 16.872' className='h-[9px] w-[13px] fill-current shrink-0' aria-hidden='true'>
            <path d={DOLBY_MARK_PATH} />
        </svg>
        ATMOS
    </p>
);

export default DolbyAtmosBadge;
