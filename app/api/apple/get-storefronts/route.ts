import { appleStorefrontsMap } from '@/config/apple-storefronts';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

// Parallel to app/api/get-countries. If a storefront override list is configured,
// surface those country codes for a picker; otherwise there is nothing to pin
// (any ISO code works as its own storefront), so report none configured.
export async function GET() {
    if (appleStorefrontsMap.length === 0) {
        return new NextResponse(
            JSON.stringify({
                success: false,
                error: 'No storefront overrides configured'
            })
        );
    }
    try {
        const codes = appleStorefrontsMap.map((entry) => entry.code);
        return new NextResponse(JSON.stringify({ success: true, data: codes }));
    } catch {
        return new NextResponse(JSON.stringify({ success: false, error: 'Error parsing the storefront list' }));
    }
}
