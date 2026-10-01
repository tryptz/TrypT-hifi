// Kept so existing callers of the old path keep working; same contract as
// /api/deezer/download-music.
export { GET } from '../download-music/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
