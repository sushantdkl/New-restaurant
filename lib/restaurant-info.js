/**
 * Central factual identity for Chulo Cottage.
 *
 * Sourced from the client's own website (index.html), signage and photos.
 * Do NOT invent opening hours, ratings, or social URLs — only verified fields.
 */

export const RESTAURANT = {
  name: 'Chulo Cottage',
  shortName: 'Chulo Cottage',
  tagline: 'A garden cafe & kitchen in Birendranagar, Surkhet',
  intro:
    'Coffee under the string lights, momo fresh from the kitchen and a quiet table among the palms. Come for one cup and stay for the evening.',
  address: {
    line: 'Birendranagar-8',
    city: 'Surkhet',
    postalCode: '',
    country: 'Nepal',
    full: 'Birendranagar-8, Surkhet, Karnali Province, Nepal',
  },
  coords: { lat: 28.5908, lng: 81.6255 },
  phoneDisplay: '+977 984-1511535',
  phoneE164: '+9779841511535',
  whatsappNumber: '9779841511535',
  email: '',
  social: {
    facebook: '',
    tiktok: 'https://www.tiktok.com/@chulocottageskt',
  },
  mapEmbedSrc:
    'https://www.google.com/maps?q=28.5908,81.6255&z=17&hl=en&output=embed',
  mapsUrl: 'https://maps.google.com/?cid=3417832107308688178',
  logo: '/images/brand/chulo-cottage-logo.jpg',
  storefront: ['/chulo-cottage/courtyard.jpg', '/chulo-cottage/cottage.jpg'],
  themeColor: '#2E4A40',
  siteUrl: 'https://chulocottage.com.np',
};

/**
 * Phone as typed in the CMS -> E.164. Local Nepali numbers ("9858038225",
 * "083-520000") get +977; "+…" / "00…" are kept as already international.
 */
export function toE164(raw) {
  const s = String(raw || '').trim();
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  if (s.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('977') && digits.length > 10) return `+${digits}`;
  return `+977${digits.replace(/^0+/, '')}`;
}

export function telHref() {
  return `tel:${RESTAURANT.phoneE164}`;
}

export function mailtoHref() {
  return `mailto:${RESTAURANT.email}`;
}

export function whatsappHref(message = "Namaste Chulo Cottage! I'd like to place an order.") {
  return `https://wa.me/${RESTAURANT.whatsappNumber}?text=${encodeURIComponent(message)}`;
}

/** External "Open in Google Maps" link (search by name near coordinates). */
export function directionsHref() {
  const { lat, lng } = RESTAURANT.coords;
  const q = encodeURIComponent(`${RESTAURANT.name}, ${RESTAURANT.address.full}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}&center=${lat},${lng}`;
}

/** "Read reviews on Google" — points to the live listing rather than copying reviews. */
export function googleReviewsHref() {
  const q = encodeURIComponent(`${RESTAURANT.name} ${RESTAURANT.address.city}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}
