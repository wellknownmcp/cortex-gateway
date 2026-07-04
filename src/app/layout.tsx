import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Cortex Gateway',
  description: 'Federated MCP gateway',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>{children}</body>
    </html>
  );
}
