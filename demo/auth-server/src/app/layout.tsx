import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cortex Gateway — demo auth',
  description: 'Demo OAuth 2.1 authorization server for cortex-gateway',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
