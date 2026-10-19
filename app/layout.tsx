import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sneaker Drop — Edition 001",
  description:
    "Twenty pairs. Five-minute reservations. A fair shot for everyone.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
