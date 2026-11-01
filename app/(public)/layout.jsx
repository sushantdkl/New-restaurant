import localFont from 'next/font/local';
import PublicShell from '@/components/public/public-shell';
import { getPublicBrand, getPublicContact, getPublicSeo } from '@/lib/public-content';
import './premium.css';

// Self-hosted (next/font/google crashed builds whenever Google answered with
// extensionless URLs). Cormorant Garamond for display, DM Sans for text, Tiro
// Devanagari for the Nepali kickers; Mukta Devanagari covers Nepali body text.
const display = localFont({
  src: [
    { path: './fonts/cormorant-garamond-latin.woff2', weight: '300 700', style: 'normal' },
    { path: './fonts/cormorant-garamond-italic-latin.woff2', weight: '300 700', style: 'italic' },
  ],
  variable: '--font-cormorant',
  display: 'swap',
});

const body = localFont({
  src: './fonts/dm-sans-latin.woff2',
  weight: '100 1000',
  variable: '--font-dm-sans',
  display: 'swap',
});

const bodyDeva = localFont({
  src: [
    { path: './fonts/mukta-400-deva.woff2', weight: '400' },
    { path: './fonts/mukta-600-deva.woff2', weight: '600' },
  ],
  variable: '--font-mukta-deva',
  display: 'swap',
  preload: false,
});

const nepali = localFont({
  src: './fonts/tiro-devanagari-hindi-deva.woff2',
  weight: '400',
  variable: '--font-tiro',
  display: 'swap',
});

// CMS edits (phone, WhatsApp, logo, colours…) must show without a rebuild.
export const dynamic = 'force-dynamic';

/** Titles, description, share image and favicon all come from the CMS (Brand + SEO tabs). */
export async function generateMetadata() {
  const [brand, seo] = await Promise.all([getPublicBrand(), getPublicSeo()]);
  const title = seo.title || `${brand.name} | ${brand.tagline}`;
  return {
    title: { default: title, template: `%s | ${brand.name}` },
    description: seo.description,
    applicationName: brand.name,
    ...(seo.canonical ? { alternates: { canonical: seo.canonical } } : {}),
    icons: { icon: brand.favicon, apple: brand.favicon, shortcut: brand.favicon },
    openGraph: { type: 'website', siteName: brand.name, title, description: seo.description, images: [{ url: seo.ogImage, alt: brand.name }] },
    twitter: { card: 'summary_large_image', title, description: seo.description, images: [seo.ogImage] },
  };
}

export default async function PublicLayout({ children }) {
  const [brand, contact] = await Promise.all([getPublicBrand(), getPublicContact()]);
  return (
    <div
      className={`dsp-site ${display.variable} ${body.variable} ${bodyDeva.variable} ${nepali.variable}`}
      data-theme={brand.theme}
      style={{
        ['--font-body']: 'var(--font-dm-sans), var(--font-mukta-deva), "Segoe UI", system-ui, sans-serif',
        ['--font-display']: 'var(--font-cormorant), Garamond, "Times New Roman", serif',
        ['--font-nepali']: 'var(--font-tiro), var(--font-mukta-deva), "Nirmala UI", serif',
      }}
    >
      <PublicShell brand={brand} contact={contact}>{children}</PublicShell>
    </div>
  );
}
