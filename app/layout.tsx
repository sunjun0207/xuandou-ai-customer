import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "玄斗",
  description: "把需求说清楚，研发管线会接着做",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
