import { ReactNode } from 'react';

export const metadata = {
  title: 'SP Webhooks API',
  description: 'Webhook endpoints for SP integration',
};

export default function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
