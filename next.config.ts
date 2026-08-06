import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: "standalone",
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
                // Spotify playlist covers and profile pictures shown by the importer.
                // Covers come from i./mosaic.scdn.co, newer ones from *.spotifycdn.com.
                protocol: 'https',
                hostname: '**.scdn.co',
                port: '',
                pathname: '**',
                search: ''
            },
            {
                protocol: 'https',
                hostname: '**.spotifycdn.com',
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
                        value: 'X-Requested-With, Content-Type, Authorization, Token-Country'
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
