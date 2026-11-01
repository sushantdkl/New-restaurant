/**
 * Website CMS store.
 *
 * Content is persisted in the existing key/value `system_settings` table under
 * `cms_<section>` keys (JSON) — no new content engine. Uploaded image metadata
 * lives in a small `cms_media` table. Menu prices are intentionally NOT managed
 * here; the public menu keeps reading the POS menu source.
 *
 * Defaults are pre-filled from the approved public-site copy + `public/images/`
 * assets so the admin CMS opens with the live site content already populated.
 * Those `/images/...` paths ship with the app (and cPanel deploy); new uploads
 * go to persistent UPLOADS_DIR/cms and are served at `/uploads/cms/...`.
 */

import { ensureSqliteTable } from '@/lib/db/ensure-sqlite-table.js';
import { RESTAURANT } from '@/lib/restaurant-info.js';
import {
  HERO, SIGNATURE_ITEMS, POPULAR_CATEGORIES, SPACES, GALLERY, STOREFRONT,
} from '@/lib/public-gallery.js';

export const CMS_SECTIONS = ['brand', 'home', 'festive', 'about', 'gallery', 'videos', 'menu', 'contact', 'seo'];

/** Curated site colour schemes — the deep garden colour behind the hero, story and visit bands. */
export const SITE_THEMES = ['pine', 'sage', 'walnut', 'night'];

function settingsFallback(db) {
  return db.get(
    `SELECT
       MAX(CASE WHEN setting_key='restaurant_name' THEN setting_value END) AS name,
       MAX(CASE WHEN setting_key='restaurant_address' THEN setting_value END) AS address,
       MAX(CASE WHEN setting_key='restaurant_phone' THEN setting_value END) AS phone,
       MAX(CASE WHEN setting_key='restaurant_email' THEN setting_value END) AS email
     FROM system_settings`
  );
}

/** Deep-merge so older saved CMS JSON still picks up new default fields.
 * Empty strings and empty arrays from saved CMS are intentional clears — keep them. */
export function deepMerge(base, override) {
  if (override == null) return base;
  if (Array.isArray(base) || Array.isArray(override)) {
    return override !== undefined && override !== null ? override : base;
  }
  if (typeof base !== 'object' || typeof override !== 'object') {
    // Preserve intentional empty string clears from the CMS editor.
    if (override === '') return '';
    return override !== undefined && override !== null ? override : base;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (k.startsWith('_')) {
      out[k] = v;
      continue;
    }
    out[k] = deepMerge(base[k], v);
  }
  return out;
}

function defaults(base = {}) {
  return {
    brand: {
      businessName: base.name || RESTAURANT.name,
      shortName: RESTAURANT.shortName,
      tagline: RESTAURANT.tagline,
      logo: RESTAURANT.logo,
      favicon: RESTAURANT.logo,
      theme: 'pine',
      hours: '',
      email: base.email || RESTAURANT.email,
      phone: base.phone || RESTAURANT.phoneDisplay,
      whatsapp: base.phone || RESTAURANT.whatsappNumber,
      location: base.address || RESTAURANT.address.full,
      mapEmbed: RESTAURANT.mapEmbedSrc,
      social: {
        facebook: RESTAURANT.social.facebook,
        instagram: '',
        tiktok: RESTAURANT.social.tiktok,
      },
    },
    home: {
      heroHeadingLine1: 'चुलो',
      heroHeadingLine2: RESTAURANT.name,
      heroHeadingLine3: 'A garden cafe & kitchen in Birendranagar',
      heroDescription: RESTAURANT.intro,
      heroImage: HERO.main.src,
      heroImageAlt: HERO.main.alt,
      heroInsetImage: HERO.inset.src,
      heroInsetAlt: HERO.inset.alt,
      heroBadgeValue: '3',
      heroBadgeLabel: 'corners of the garden to choose from',
      heroEyebrow: 'Garden cafe · Kitchen · Bar · Birendranagar-8, Surkhet',
      primaryCta: { label: 'View the menu', href: '/menu' },
      secondaryCta: { label: 'Reserve a table', href: 'whatsapp' },
      tertiaryCta: { label: 'Call', href: 'tel' },

      popularTitle: 'From the menu',
      popularLead: 'From the kitchen, the coffee bar and the bar.',
      popularCategories: POPULAR_CATEGORIES.map((c) => ({
        title: c.title,
        note: c.note || '',
        img: c.img || '',
        href: '/menu',
      })),

      signatureTitle: 'House favourites',
      signatureLead: 'What most tables order first.',
      signatureItems: SIGNATURE_ITEMS.map((it) => ({
        name: it.name,
        category: it.category || '',
        img: it.img || '',
        href: '/menu',
      })),

      howItWorksTitle: 'Day and night',
      howItWorksLead: 'One garden, two moods.',
      howItWorksSteps: [
        { title: 'By day', text: 'A calm spot for coffee and a plate of momo.' },
        { title: 'After dark', text: 'The lights come on for sekuwa, choila and long conversations.' },
        { title: 'Save a table', text: 'Choose your date, time and corner on WhatsApp. We reply to confirm.' },
      ],

      spacesTitle: 'Three ways to sit',
      spacesLead: 'Choose your corner of the garden when you reserve.',
      spaces: SPACES.map((sp) => ({ ...sp })),

      menuTitle: 'The Chulo menu',
      menuLead: 'Live prices from the kitchen, the coffee bar and the bar.',
      menuCtaLabel: 'Full menu',
      menuCtaHref: '/menu',

      aboutStripTitle: 'Named for the hearth',
      aboutStripText:
        'In a Nepali home, the chulo is the clay hearth where the cooking happens and where everyone gathers. Chulo Cottage was built around the same idea: a warm kitchen, an open garden and a table for everyone.',
      aboutStripImage: STOREFRONT[1].src,
      aboutStripImageAlt: STOREFRONT[1].alt,
      aboutStripCtaLabel: 'More about us',
      aboutStripCtaHref: '/about',

      galleryTitle: 'Gallery',
      galleryCtaLabel: 'See more',
      galleryCtaHref: '/gallery',
      galleryLimit: 6,

      findUsTitle: 'Find the cottage',
      findUsLead: 'A brick cottage in a leafy courtyard in Birendranagar-8, Surkhet.',

      sections: {
        hero: true,
        popular: true,
        signature: true,
        howItWorks: true,
        spaces: true,
        menu: true,
        about: true,
        gallery: true,
        findUs: true,
      },
    },
    festive: {
      heading: 'Festive highlights',
      lead: '',
      visible: true,
      items: [],
    },
    videos: {
      heading: 'Videos',
      lead: '',
      items: [],
    },
    menu: {
      heading: 'The Chulo menu',
      lead: 'From the kitchen, the coffee bar and the bar. Prices in Nepali rupees. Order for pickup or delivery, or send your order on WhatsApp.',
      note: 'No online payment — pay at the counter or on delivery. We call to confirm every order. Alcohol and hookah are served to guests aged 18 and above.',
    },
    about: {
      heading: RESTAURANT.name,
      description:
        'In a Nepali home, the chulo is the clay hearth where the cooking happens and where everyone gathers. Chulo Cottage was built around the same idea: a warm kitchen, an open garden and a table for everyone.',
      descriptionExtra:
        'Our brick cottage sits in a leafy courtyard in Birendranagar-8. By day it is a calm spot for coffee and a plate of momo. After dark the lights come on, and friends and families settle in for sekuwa, choila and long conversations.',
      images: [STOREFRONT[0]?.src || RESTAURANT.storefront[0], STOREFRONT[1]?.src || RESTAURANT.storefront[1]],
      features: [
        { title: 'The kitchen', text: 'Mo:mo, sekuwa, choila, biryani and thukpa, cooked fresh.' },
        { title: 'The coffee bar', text: 'Espresso, cappuccino, lattes, Chulo milk tea and fresh juice.' },
        { title: 'The garden', text: 'A courtyard, a bamboo corner and a thatched gazebo under string lights.' },
        { title: 'The bar', text: 'Beer, spirits and hookah for guests aged 18 and above.' },
      ],
      visitHeading: 'Visit us',
      visible: true,
    },
    gallery: {
      heading: 'Gallery',
      lead: 'The garden, the cottage and evenings under the lights.',
      items: GALLERY.map((src, i) => ({
        url: src,
        title: '',
        alt: RESTAURANT.name,
        order: i,
        visible: true,
      })),
    },
    contact: {
      pageHeading: 'Contact and location',
      intro: 'Call, message on WhatsApp, or find us in Birendranagar-8, Surkhet.',
      formHeading: 'Send us a message',
      phone: base.phone || RESTAURANT.phoneDisplay,
      whatsapp: RESTAURANT.whatsappNumber,
      email: base.email || RESTAURANT.email,
      location: base.address || RESTAURANT.address.full,
      mapEmbed: RESTAURANT.mapEmbedSrc,
      social: {
        facebook: RESTAURANT.social.facebook,
        instagram: '',
        tiktok: RESTAURANT.social.tiktok,
      },
    },
    seo: {
      title: 'Chulo Cottage | Garden Cafe & Kitchen | Birendranagar, Surkhet',
      description: RESTAURANT.intro,
      ogImage: RESTAURANT.storefront[0],
      canonical: '',
    },
  };
}

export async function ensureCmsSchema(db) {
  await ensureSqliteTable(
    db,
    `CREATE TABLE IF NOT EXISTS cms_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE NOT NULL,
      title TEXT,
      alt TEXT,
      section TEXT,
      width INTEGER,
      height INTEGER,
      size INTEGER,
      uploaded_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  );
}

async function readSetting(db, key) {
  const row = await db.get('SELECT setting_value FROM system_settings WHERE setting_key = ?', [key]);
  if (!row || row.setting_value == null) return null;
  try {
    return JSON.parse(row.setting_value);
  } catch {
    return null;
  }
}

async function writeSetting(db, key, value) {
  const json = JSON.stringify(value);
  const existing = await db.get('SELECT id FROM system_settings WHERE setting_key = ?', [key]);
  if (existing) {
    await db.run('UPDATE system_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?', [json, key]);
  } else {
    await db.run('INSERT INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, json]);
  }
}

/** Full CMS content with defaults merged in for any unset section. */
export async function getCmsContent(db) {
  const base = (await settingsFallback(db).catch(() => null)) || {};
  const def = defaults(base);
  const out = {};
  for (const section of CMS_SECTIONS) {
    const stored = await readSetting(db, `cms_${section}`);
    out[section] = stored ? deepMerge(def[section], stored) : def[section];
  }
  return out;
}

export async function getCmsSection(db, section) {
  const all = await getCmsContent(db);
  return all[section] || null;
}

export async function setCmsSection(db, section, data, actorId = null) {
  if (!CMS_SECTIONS.includes(section)) {
    throw Object.assign(new Error('Unknown CMS section'), { status: 400 });
  }
  const payload = { ...data, _updatedBy: actorId, _updatedAt: new Date().toISOString() };
  await writeSetting(db, `cms_${section}`, payload);
  return payload;
}

/** Media library ------------------------------------------------------- */
export async function listMedia(db, { section = null } = {}) {
  await ensureCmsSchema(db);
  if (section) {
    return db.all('SELECT * FROM cms_media WHERE section = ? ORDER BY created_at DESC', [section]);
  }
  return db.all('SELECT * FROM cms_media ORDER BY created_at DESC');
}

export async function addMedia(db, { url, title = null, alt = null, section = null, width = null, height = null, size = null, uploaded_by = null }) {
  await ensureCmsSchema(db);
  const res = await db.run(
    `INSERT INTO cms_media (url, title, alt, section, width, height, size, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [url, title, alt, section, width, height, size, uploaded_by]
  );
  const id = res?.lastInsertRowid ?? res?.lastID ?? null;
  if (id != null) {
    const row = await db.get('SELECT * FROM cms_media WHERE id = ?', [id]);
    if (row) return row;
  }
  // Fallback if insert-id lookup fails (still return a usable media object).
  const byUrl = await db.get('SELECT * FROM cms_media WHERE url = ? ORDER BY id DESC', [url]);
  if (byUrl) return byUrl;
  return {
    id: id || null,
    url,
    title,
    alt,
    section,
    width,
    height,
    size,
    uploaded_by,
  };
}

/** True if a media URL is still referenced anywhere in CMS content. */
export async function isMediaReferenced(db, url) {
  const content = await getCmsContent(db);
  return JSON.stringify(content).includes(url);
}

export async function deleteMedia(db, id, { force = false } = {}) {
  await ensureCmsSchema(db);
  const row = await db.get('SELECT * FROM cms_media WHERE id = ?', [id]);
  if (!row) throw Object.assign(new Error('Media not found'), { status: 404 });
  if (!force && (await isMediaReferenced(db, row.url))) {
    throw Object.assign(new Error('This image is still used in published content. Confirm to remove it anyway.'), {
      status: 409,
      referenced: true,
    });
  }
  await db.run('DELETE FROM cms_media WHERE id = ?', [id]);
  return { deleted: true, url: row.url };
}
