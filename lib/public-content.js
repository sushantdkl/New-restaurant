/**
 * Server-side bridge that lets the public site show CMS-managed content while
 * keeping lib/restaurant-info.js + lib/public-gallery.js as the guaranteed
 * fallback. If a CMS value is empty or the store is unreachable, the original
 * approved constant is used — so the public site can never render blank because
 * of the CMS.
 *
 * Menu prices are intentionally NOT sourced here; the public menu keeps using
 * the POS menu source.
 */

import { cache } from 'react';
import Database from '@/lib/db/index';
import { getCmsContent, SITE_THEMES } from '@/lib/cms.js';
import { RESTAURANT, toE164 } from '@/lib/restaurant-info.js';
import { HERO, GALLERY, SIGNATURE_ITEMS, POPULAR_CATEGORIES, SPACES, STOREFRONT } from '@/lib/public-gallery.js';

// Copy or photos an older install saved for the previous restaurant: treated
// as unset so the Chulo Cottage default shows instead.
const LEGACY = /raithane|daure chulo|रैथाने|दाउरे|984-?9216081|28\.598106/i;

const pick = (cmsVal, fallback) => {
  const v = typeof cmsVal === 'string' ? cmsVal.trim() : cmsVal;
  if (typeof v === 'string' && LEGACY.test(v)) return fallback;
  return v || v === 0 ? v : fallback;
};
const current = (list) => (list || []).filter((entry) => !LEGACY.test(JSON.stringify(entry)));

// Deduped per request: the layout (header/footer) and the page both read it.
const loadCms = cache(async () => {
  try {
    return await getCmsContent(Database.getInstance());
  } catch {
    return null;
  }
});

/** Full home-page content for the public site. Never throws. */
export async function getPublicHome() {
  const cms = await loadCms();
  const h = cms?.home || {};
  const sec = h.sections || {};

  const popularSaved = current(h.popularCategories);
  const popular = (popularSaved.length ? popularSaved : POPULAR_CATEGORIES).map((c) => ({
    title: c.title,
    note: c.note || '',
    img: c.img || null,
    href: c.href || '/menu',
  }));

  const signatureSaved = current(h.signatureItems);
  const signature = (signatureSaved.length ? signatureSaved : SIGNATURE_ITEMS).map((it) => ({
    name: it.name,
    category: it.category || '',
    img: it.img || '',
    href: it.href || '/menu',
  }));

  const stepsSaved = current(h.howItWorksSteps);
  const steps = (stepsSaved.length ? stepsSaved : [
    { title: 'By day', text: 'A calm spot for coffee and a plate of momo.' },
    { title: 'After dark', text: 'The lights come on for sekuwa, choila and long conversations.' },
    { title: 'Save a table', text: 'Choose your date, time and corner on WhatsApp. We reply to confirm.' },
  ]);

  const spacesSaved = current(h.spaces);
  const spaces = (spacesSaved.length ? spacesSaved : SPACES).filter((sp) => sp && sp.title);

  return {
    heroHeadingLine1: pick(h.heroHeadingLine1, 'चुलो'),
    heroHeadingLine2: pick(h.heroHeadingLine2, RESTAURANT.name),
    heroHeadingLine3: pick(h.heroHeadingLine3, 'A garden cafe & kitchen in Birendranagar'),
    heroDescription: pick(h.heroDescription, RESTAURANT.intro),
    heroImage: pick(h.heroImage, HERO.main.src),
    heroImageAlt: pick(h.heroImageAlt, HERO.main.alt),
    heroInsetImage: pick(h.heroInsetImage, HERO.inset.src),
    heroInsetAlt: pick(h.heroInsetAlt, HERO.inset.alt),
    // The centre arch is the CMS hero image; the side arches are fixed garden photos.
    heroArches: [
      HERO.arches[0],
      { src: pick(h.heroImage, HERO.main.src), alt: pick(h.heroImageAlt, HERO.main.alt) },
      HERO.arches[2],
    ],
    heroBadgeValue: pick(h.heroBadgeValue, '3'),
    heroBadgeLabel: pick(h.heroBadgeLabel, 'corners of the garden to choose from'),
    heroEyebrow: pick(h.heroEyebrow, 'Garden cafe · Kitchen · Bar · Birendranagar-8, Surkhet'),
    primaryCta: {
      label: pick(h.primaryCta?.label, 'View the menu'),
      href: pick(h.primaryCta?.href, '/menu'),
    },
    secondaryCta: {
      label: pick(h.secondaryCta?.label, 'Reserve a table'),
      href: pick(h.secondaryCta?.href, 'whatsapp'),
    },
    tertiaryCta: {
      label: pick(h.tertiaryCta?.label, 'Call'),
      href: pick(h.tertiaryCta?.href, 'tel'),
    },

    popularTitle: pick(h.popularTitle, 'From the menu'),
    popularLead: pick(h.popularLead, 'From the kitchen, the coffee bar and the bar.'),
    popularCategories: popular,

    signatureTitle: pick(h.signatureTitle, 'House favourites'),
    signatureLead: pick(h.signatureLead, 'What most tables order first.'),
    signatureItems: signature,

    howItWorksTitle: pick(h.howItWorksTitle, 'Day and night'),
    howItWorksLead: pick(h.howItWorksLead, 'One garden, two moods.'),
    howItWorksSteps: steps,

    spacesTitle: pick(h.spacesTitle, 'Three ways to sit'),
    spacesLead: pick(h.spacesLead, 'Choose your corner of the garden when you reserve.'),
    spaces,

    menuTitle: pick(h.menuTitle, 'The Chulo menu'),
    menuLead: pick(h.menuLead, 'Live prices from the kitchen, the coffee bar and the bar.'),
    menuCtaLabel: pick(h.menuCtaLabel, 'Full menu'),
    menuCtaHref: pick(h.menuCtaHref, '/menu'),

    aboutStripTitle: pick(h.aboutStripTitle, 'Named for the hearth'),
    aboutStripText: pick(
      h.aboutStripText,
      'In a Nepali home, the chulo is the clay hearth where the cooking happens and where everyone gathers. Chulo Cottage was built around the same idea: a warm kitchen, an open garden and a table for everyone.'
    ),
    aboutStripImage: pick(h.aboutStripImage, STOREFRONT[1].src),
    aboutStripImageAlt: pick(h.aboutStripImageAlt, STOREFRONT[1].alt),
    aboutStripCtaLabel: pick(h.aboutStripCtaLabel, 'Our story'),
    aboutStripCtaHref: pick(h.aboutStripCtaHref, '/about'),

    galleryTitle: pick(h.galleryTitle, 'Gallery'),
    galleryCtaLabel: pick(h.galleryCtaLabel, 'See more'),
    galleryCtaHref: pick(h.galleryCtaHref, '/gallery'),
    galleryLimit: Number(h.galleryLimit) > 0 ? Number(h.galleryLimit) : 6,

    findUsTitle: pick(h.findUsTitle, 'Find the cottage'),
    findUsLead: pick(h.findUsLead, 'A brick cottage in a leafy courtyard in Birendranagar-8, Surkhet.'),

    sections: {
      hero: sec.hero !== false,
      popular: sec.popular !== false,
      signature: sec.signature !== false,
      howItWorks: sec.howItWorks !== false,
      spaces: sec.spaces !== false,
      menu: sec.menu !== false,
      about: sec.about !== false,
      gallery: sec.gallery !== false,
      findUs: sec.findUs !== false,
    },
  };
}

/** Merged About page content. Never throws. */
export async function getPublicAbout() {
  const cms = await loadCms();
  const a = cms?.about || {};
  const featuresSaved = current(a.features);
  const features = (featuresSaved.length ? featuresSaved : [
    { title: 'The kitchen', text: 'Mo:mo, sekuwa, choila, biryani and thukpa, cooked fresh.' },
    { title: 'The coffee bar', text: 'Espresso, cappuccino, lattes, Chulo milk tea and fresh juice.' },
    { title: 'The garden', text: 'A courtyard, a bamboo corner and a thatched gazebo under string lights.' },
    { title: 'The bar', text: 'Beer, spirits and hookah for guests aged 18 and above.' },
  ]);
  const images = (a.images || []).filter((src) => src && !LEGACY.test(src));
  return {
    heading: pick(a.heading, RESTAURANT.name),
    description: pick(
      a.description,
      'In a Nepali home, the chulo is the clay hearth where the cooking happens and where everyone gathers. Chulo Cottage was built around the same idea: a warm kitchen, an open garden and a table for everyone.'
    ),
    descriptionExtra: pick(
      a.descriptionExtra,
      'Our brick cottage sits in a leafy courtyard in Birendranagar-8. By day it is a calm spot for coffee and a plate of momo. After dark the lights come on, and friends and families settle in for sekuwa, choila and long conversations.'
    ),
    image: images[0] || STOREFRONT[0].src,
    images: images.length ? images : RESTAURANT.storefront,
    features,
    visitHeading: pick(a.visitHeading, 'Visit us'),
    visible: a.visible !== false,
  };
}

/** Merged Gallery items. Falls back to the built-in gallery when CMS is empty. */
export async function getPublicGallery() {
  const cms = await loadCms();
  const heading = pick(cms?.gallery?.heading, 'Gallery');
  const lead = pick(cms?.gallery?.lead, 'The garden, the cottage and evenings under the lights.');
  const items = (cms?.gallery?.items || [])
    .filter((i) => i && i.url && i.visible !== false && !LEGACY.test(i.url))
    .sort((x, y) => (x.order || 0) - (y.order || 0))
    .map((i) => ({ url: i.url, alt: pick(i.alt, pick(i.title, RESTAURANT.name)), title: pick(i.title, '') }));
  if (items.length) return { heading, lead, items };
  return {
    heading,
    lead,
    items: GALLERY.map((src) => ({ url: src, alt: RESTAURANT.name, title: '' })),
  };
}

/** Merged contact block for the public Contact page. Never throws. */
export async function getPublicContact() {
  const cms = await loadCms();
  const c = cms?.contact || {};
  const b = cms?.brand || {};
  // Brand ("Brand & Contact identity") is the single source for contact
  // details; the old Contact-tab copies are only a fallback for cleared fields.
  const bs = b.social || {};
  const cs = c.social || {};
  const social = { facebook: pick(bs.facebook, cs.facebook), tiktok: pick(bs.tiktok, cs.tiktok), instagram: pick(bs.instagram, cs.instagram) };

  const phoneDisplay = pick(b.phone, pick(c.phone, RESTAURANT.phoneDisplay));
  const email = pick(b.email, pick(c.email, RESTAURANT.email));
  const location = pick(b.location, pick(c.location, RESTAURANT.address.full));
  const whatsappNumber = toE164(pick(b.whatsapp, pick(c.whatsapp, ''))).slice(1) || RESTAURANT.whatsappNumber;
  const phoneE164 = toE164(phoneDisplay) || RESTAURANT.phoneE164;
  const name = pick(b.businessName, RESTAURANT.name);

  return {
    pageHeading: pick(c.pageHeading, 'Contact and location'),
    intro: pick(c.intro, 'Call, message on WhatsApp, or find us in Birendranagar-8, Surkhet.'),
    formHeading: pick(c.formHeading, 'Send us a message'),
    phoneDisplay,
    phoneE164,
    email,
    location,
    whatsappNumber,
    mapEmbedSrc: pick(b.mapEmbed, pick(c.mapEmbed, RESTAURANT.mapEmbedSrc)),
    social: {
      facebook: pick(social.facebook, RESTAURANT.social.facebook),
      tiktok: pick(social.tiktok, RESTAURANT.social.tiktok),
      instagram: pick(social.instagram, ''),
    },
    hrefs: {
      tel: `tel:${phoneE164}`,
      mailto: `mailto:${email}`,
      whatsapp: `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(`Hello ${name}! I'd like to place an order.`)}`,
      directions: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name}, ${location}`)}`,
    },
  };
}

/** Brand bits for shell / structured data. */
export async function getPublicBrand() {
  const cms = await loadCms();
  const b = cms?.brand || {};
  return {
    name: pick(b.businessName, RESTAURANT.name),
    shortName: pick(b.shortName, RESTAURANT.shortName),
    tagline: pick(b.tagline, RESTAURANT.tagline),
    logo: pick(b.logo, RESTAURANT.logo),
    favicon: pick(b.favicon, pick(b.logo, RESTAURANT.logo)),
    theme: SITE_THEMES.includes(b.theme) ? b.theme : SITE_THEMES[0],
    // One line per row, e.g. "Every day · 7am – 9pm". Empty = not shown (never invented).
    hours: String(b.hours || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

/** Wide festive banners shown after the home hero. Empty list = section hidden. */
export async function getPublicFestive() {
  const cms = await loadCms();
  const f = cms?.festive || {};
  const items = f.visible === false ? [] : (f.items || [])
    .filter((item) => item && item.image && item.visible !== false)
    .sort((x, y) => Number(x.order || 0) - Number(y.order || 0));
  return { heading: pick(f.heading, 'Festive highlights'), lead: pick(f.lead, ''), items };
}

/** A video URL → how to show it: YouTube embed, a playable file, or a plain link. */
export function videoSource(url = '') {
  const raw = String(url).trim();
  const yt = raw.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/);
  if (yt) return { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${yt[1]}` };
  if (/\.(mp4|webm)(\?|$)/i.test(raw) || /^\/(uploads|api\/media)\//.test(raw)) return { kind: 'file', src: raw };
  return /^https:\/\//.test(raw) ? { kind: 'link', src: raw } : null;
}

/** Videos for the gallery page. */
export async function getPublicVideos() {
  const cms = await loadCms();
  const v = cms?.videos || {};
  const items = (v.items || [])
    .filter((item) => item && item.visible !== false && videoSource(item.url))
    .sort((x, y) => Number(x.order || 0) - Number(y.order || 0))
    .map((item) => ({ ...videoSource(item.url), title: item.title || '', description: item.description || '' }));
  return { heading: pick(v.heading, 'Videos'), lead: pick(v.lead, ''), items };
}

/** Menu page copy (dishes and prices always come from the POS). */
export async function getPublicMenuPage() {
  const cms = await loadCms();
  const m = cms?.menu || {};
  return {
    heading: pick(m.heading, 'The Chulo menu'),
    lead: pick(m.lead, 'From the kitchen, the coffee bar and the bar. Prices in Nepali rupees. Order for pickup or delivery, or send your order on WhatsApp.'),
    note: pick(m.note, 'No online payment — pay at the counter or on delivery. We call to confirm every order. Alcohol and hookah are served to guests aged 18 and above.'),
  };
}

/** Site-wide SEO defaults from the CMS SEO tab. */
export async function getPublicSeo() {
  const cms = await loadCms();
  const s = cms?.seo || {};
  return {
    title: pick(s.title, ''),
    description: pick(s.description, RESTAURANT.intro),
    ogImage: pick(s.ogImage, RESTAURANT.storefront[0]),
    canonical: pick(s.canonical, ''),
  };
}
