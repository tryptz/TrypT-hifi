// Apple Music storefront resolution.
//
// Parallel to config/token-countries.ts, but Apple does not use per-country auth
// tokens: a single developer JWT authenticates every request and the *storefront*
// (an ISO 3166-1 alpha-2 code, lowercased) is a path segment: /v1/catalog/{sf}/…
//
// Because Apple storefront ids ARE the lowercased country codes, the default
// behaviour is simply `country.toLowerCase()`. The overrides map exists only for
// the rare case where you want to force a country code to a different storefront.

export type StorefrontEntry = {
    code: string; // ISO 3166-1 alpha-2, e.g. 'US'
    storefront: string; // Apple storefront id, e.g. 'us'
};

// If you fill this list it takes precedence over the country.toLowerCase() default.
export const appleStorefrontsMap: StorefrontEntry[] = [];
// Example usage
// [
//     {
//         code: 'GB',
//         storefront: 'gb'
//     }
// ]

export const DEFAULT_STOREFRONT = process.env.APPLE_STOREFRONT_DEFAULT || 'us';

export const getStorefrontForCountry = (country?: string): string => {
    if (!country) return DEFAULT_STOREFRONT;
    const override = appleStorefrontsMap.find((c) => c.code.toUpperCase() === country.toUpperCase());
    return override?.storefront || country.toLowerCase() || DEFAULT_STOREFRONT;
};
