import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BookBuddy',
  description: 'Track characters as you read your ebook — spoiler-free.',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'BookBuddy' },
  icons: { apple: '/icon-192.png' },
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
    <html lang="en" suppressHydrationWarning>
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
            __html: `(function(){if(!navigator.standalone&&!window.matchMedia('(display-mode: standalone)').matches)return;var c=document.createElement('canvas');var dpr=window.devicePixelRatio||1;c.width=screen.width*dpr;c.height=screen.height*dpr;var ctx=c.getContext('2d');ctx.fillStyle='#09090b';ctx.fillRect(0,0,c.width,c.height);var img=new Image();img.onload=function(){var s=128*dpr;ctx.drawImage(img,(c.width-s)/2,(c.height-s)/2,s,s);var link=document.createElement('link');link.rel='apple-touch-startup-image';link.href=c.toDataURL();document.head.appendChild(link)};img.src='${basePath}/icon-512.png'})()`,
          }}
        />
      </head>
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
