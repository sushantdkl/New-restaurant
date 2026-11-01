/**
 * Curated public-site imagery — client-provided local assets only.
 * Photos live under public/chulo-cottage/.
 */

export const STOREFRONT = [
  { src: '/chulo-cottage/courtyard.jpg', alt: 'Stone courtyard with umbrellas, rattan chairs and palms at Chulo Cottage' },
  { src: '/chulo-cottage/cottage.jpg', alt: 'The brick cottage with its carved balcony and hanging sign, seen through garden leaves' },
];

/** Hero imagery: three arched photos stepping down into the page (centre one is `main`). */
export const HERO = {
  main: { src: '/chulo-cottage/garden-night.jpg', alt: 'The garden at dusk under string lights' },
  inset: { src: '/chulo-cottage/cottage.jpg', alt: 'The brick cottage with its carved balcony, seen through garden leaves' },
  arches: [
    { src: '/chulo-cottage/courtyard.jpg', alt: 'Stone courtyard with umbrellas, rattan chairs and palms' },
    { src: '/chulo-cottage/garden-night.jpg', alt: 'The garden at dusk under string lights' },
    { src: '/chulo-cottage/bamboo.jpg', alt: 'Guests having tea in the bamboo corner' },
  ],
};

/** House favourites on the home page (prices live in the POS menu). */
export const SIGNATURE_ITEMS = [
  { name: 'Afghani momo', img: '/images/dishes/Chicken Steam Momo.jpg', category: 'Our creamy house special' },
  { name: 'Mutton sekuwa', img: '/images/dishes/Mutton Sekuwa.jpg', category: 'Smoky, spiced and grilled' },
  { name: 'Chicken choila', img: '/images/dishes/Chicken Chhoila.jpg', category: 'Grilled, chilli and mustard oil' },
  { name: 'Chulo milk tea', img: '/images/dishes/Milk Masala Tea.webp', category: 'The cup everyone starts with' },
];

/** Popular menu categories — titles match the POS categories so tiles deep-link into the menu. */
export const POPULAR_CATEGORIES = [
  { title: 'Mo:mo', note: 'Steam · Jhol · Chilli · Kothey', img: '/images/dishes/Chicken Steam Momo.jpg' },
  { title: 'Chicken', note: 'Sekuwa · Choila · Wings', img: '/images/dishes/Chicken Sekuwa.jpg' },
  { title: 'Coffee', note: 'Espresso, cappuccino & latte', img: '/images/dishes/Cappuccino.jpg' },
  { title: 'Hookah', note: 'Classic & cloud, 18+', img: '/images/dishes/Hookah.jpg' },
];

/** The three corners of the garden guests can choose when they reserve. */
export const SPACES = [
  { title: 'The courtyard', text: 'Open-air tables on the stone terrace, shaded by umbrellas and palms.', img: '/chulo-cottage/courtyard.jpg', alt: 'Stone terrace with umbrellas, palms and string lights' },
  { title: 'The bamboo corner', text: 'Cane chairs and bamboo walls, made for tea for two.', img: '/chulo-cottage/bamboo.jpg', alt: 'Cane table and chairs against bamboo walls' },
  { title: 'The thatched gazebo', text: 'A private hut with curtains and cane seating for small groups.', img: '/chulo-cottage/gazebo.jpg', alt: 'Thatched gazebo with draped curtains and cane seating' },
];

/** Gallery grid — garden and cottage photos used by the landing / CMS defaults. */
export const GALLERY = [
  '/chulo-cottage/garden-night.jpg',
  '/chulo-cottage/courtyard.jpg',
  '/chulo-cottage/bamboo.jpg',
  '/chulo-cottage/cottage.jpg',
  '/chulo-cottage/gazebo.jpg',
];
