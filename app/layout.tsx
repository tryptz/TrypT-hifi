import AppChrome from '@/components/app-chrome';
import ChangelogDialog from '@/components/ui/changelog-dialog';
import DownloadsButton from '@/components/downloads-button';
import ParticlesComponent from '@/components/particles';
import SettingsForm from '@/components/ui/settings-form';
import { Button } from '@/components/ui/button';
import { DownloadsProvider } from '@/lib/downloads/downloads-provider';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FaDiscord } from '@react-icons/all-files/fa/FaDiscord';
import { FaGithub } from '@react-icons/all-files/fa/FaGithub';
import { FFmpegProvider } from '@/lib/ffmpeg-provider';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';
import { PlayerProvider } from '@/lib/player/player-provider';
import { SettingsProvider } from '@/lib/settings-provider';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/toaster';
import { CountryProvider } from '@/lib/country-provider';
import './globals.css';

const inter = Inter({
    subsets: ['latin'],
    display: 'swap'
});

export const metadata: Metadata = {
    metadataBase: new URL('https://trypt.hifi/'), // Site URL
    title: {
        default: process.env.NEXT_PUBLIC_APPLICATION_NAME + ' - A frontend browser client for downloading music for Qobuz.',
        template: process.env.NEXT_PUBLIC_APPLICATION_NAME!
    },
    description: 'A frontend browser client for downloading music for Qobuz.',
    openGraph: {
        images:
            process.env.NEXT_PUBLIC_APPLICATION_NAME?.toLowerCase() === 'qobuz-dl'
                ? [{ url: '/logo/qobuz-banner.png', width: 650, height: 195, alt: 'Qobuz Logo' }]
                : []
    },
    keywords: [
        `${process.env.NEXT_PUBLIC_APPLICATION_NAME!}`,
        'music',
        'downloader',
        'hi-res',
        'qobuz',
        'flac',
        'alac',
        'mp3',
        'aac',
        'opus',
        'wav',
        'qobuz download'
    ]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
    return (
        <html lang='en' suppressHydrationWarning>
            <body className={`${inter.className} antialiased`} suppressHydrationWarning>
                <FFmpegProvider>
                    <CountryProvider>
                        <DownloadsProvider>
                            <PlayerProvider>
                                <SettingsProvider>
                                    <ThemeProvider attribute='class' defaultTheme='dark' enableSystem>
                                        <ParticlesComponent className='z-[-1] h-full w-full fixed' />
                                        <header className='fixed top-0 left-0 z-10 flex w-full max-w-screen items-start justify-between gap-2 p-4'>
                                            <div className='flex flex-col gap-2'>
                                                <SettingsForm />
                                                <ChangelogDialog />
                                            </div>
                                            <div className='flex gap-2 items-center'>
                                                <DownloadsButton />
                                                <DropdownMenu>
                                                    <DropdownMenuTrigger asChild>
                                                        <Button variant='outline' size='icon' aria-label='Community Discord servers'>
                                                            <FaDiscord />
                                                        </Button>
                                                    </DropdownMenuTrigger>
                                                    <DropdownMenuContent>
                                                        <DropdownMenuItem>
                                                            <a href='https://discord.gg/rhUUKQagjA' target='_blank' rel='noopener noreferrer'>
                                                                Qobuz-DL Discord
                                                            </a>
                                                        </DropdownMenuItem>
                                                        <DropdownMenuItem>
                                                            <a href='https://discord.gg/invite/GN7GnntyQ2' target='_blank' rel='noopener noreferrer'>
                                                                Squidboard Discord
                                                            </a>
                                                        </DropdownMenuItem>
                                                    </DropdownMenuContent>
                                                </DropdownMenu>
                                                <a href='https://github.com/QobuzDL/Qobuz-DL' target='_blank' rel='noopener noreferrer' aria-label='GitHub repository'>
                                                    <Button variant='outline' size='icon'>
                                                        <FaGithub />
                                                    </Button>
                                                </a>
                                            </div>
                                        </header>
                                        <div className='flex flex-col min-h-screen'>
                                            <main className='px-6 pb-36 pt-32 md:pt-24 2xl:pt-60 min-h-full flex-1 flex flex-col items-center justify-center gap-2 z-[2] overflow-x-hidden max-w-screen overflow-y-hidden'>
                                                {children}
                                            </main>
                                            <Toaster />
                                            <AppChrome />
                                        </div>
                                    </ThemeProvider>
                                </SettingsProvider>
                            </PlayerProvider>
                        </DownloadsProvider>
                    </CountryProvider>
                </FFmpegProvider>
            </body>
        </html>
    );
}
