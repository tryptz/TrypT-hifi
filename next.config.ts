import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: "standalone",
    // The HiFi API routes (app/search/route.ts, ...) are called the way
    // hifi-api spells them, with a trailing slash (/search/?s=...). Next's
    // default 308s that to /search first, a wasted round trip on every TIDAL
    // request Tryptify makes; both spellings reach the same handler without it.
    skipTrailingSlashRedirect: true,
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'static.qobuz.com',
                port: '',
                pathname: '**',
                search: ''
            },
            {
                protocol: 'https',
                hostname: 'cdn-images.dzcdn.net',
                port: '',
                pathname: '**',
                search: ''
            },
            {
                protocol: 'https',
                hostname: 'resources.tidal.com',
                port: '',
                pathname: '**',
                search: ''
            }
        ]
    },
    async headers() {
        return [
            {
                source: '/api/:path*',
                headers: [
                    {
                        key: 'Access-Control-Allow-Origin',
                        value: '*'
                    },
                    {
                        key: 'Access-Control-Allow-Methods',
                        value: 'GET, POST, PUT, DELETE, OPTIONS'
                    },
                    {
                        key: 'Access-Control-Allow-Headers',
                        value: 'X-Requested-With, Content-Type, Authorization, Token-Country, X-Access-Key'
                    },
                    {
                        key: 'Cross-Origin-Resource-Policy',
                        value: 'cross-origin'
                    }
                ]
            },
            {
                source: '/(.*)',
                headers: [
                    {
                        key: 'Cross-Origin-Opener-Policy',
                        value: 'same-origin'
                    },
                    {
                        key: 'Cross-Origin-Embedder-Policy',
                        value: 'require-corp'
                    }
                ]
            }
        ];
    }
};

export default nextConfig;
