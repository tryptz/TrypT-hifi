import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
    output: "standalone",
    // A parent lockfile (/root/package-lock.json) makes Next infer the wrong
    // workspace root for standalone file tracing. Pin it to this project dir so
    // the standalone bundle traces only this app's files.
    outputFileTracingRoot: process.cwd(),
    images: {
        remotePatterns: [
            {
                protocol: 'https',
                hostname: 'static.qobuz.com',
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
