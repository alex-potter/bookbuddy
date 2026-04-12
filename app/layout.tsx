import type { Metadata, Viewport } from 'next';
import { Newsreader, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const newsreader = Newsreader({
  subsets: ['latin'],
  variable: '--font-newsreader',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'BookBuddy',
  description: 'Track characters as you read your ebook — spoiler-free.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'BookBuddy' },
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/favicon-196.png', sizes: '196x196', type: 'image/png' },
    ],
    apple: { url: '/apple-icon-180.png', sizes: '180x180' },
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';
  return (
    <html lang="en" suppressHydrationWarning className={`${newsreader.variable} ${jetbrainsMono.variable}`}>
      <head>
        {/* Inline script prevents flash-of-wrong-theme before React hydrates */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){var t=localStorage.getItem('theme');if(t==='light'){document.documentElement.classList.remove('dark')}else{document.documentElement.classList.add('dark')}})()`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator)navigator.serviceWorker.register('${basePath}/sw.js')`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){if(!navigator.standalone&&!window.matchMedia('(display-mode: standalone)').matches)return;var c=document.createElement('canvas');var dpr=window.devicePixelRatio||1;c.width=screen.width*dpr;c.height=screen.height*dpr;var ctx=c.getContext('2d');ctx.fillStyle='#09090b';ctx.fillRect(0,0,c.width,c.height);var img=new Image();img.onload=function(){var s=128*dpr;ctx.drawImage(img,(c.width-s)/2,(c.height-s)/2,s,s);var link=document.createElement('link');link.rel='apple-touch-startup-image';link.href=c.toDataURL();document.head.appendChild(link)};img.src='${basePath}/manifest-icon-512.maskable.png'})()`,
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
