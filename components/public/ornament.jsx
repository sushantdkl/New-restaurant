/** Thin champagne rule with a small diamond: the site's section divider. */
export default function Ornament({ className = '' }) {
  return <span className={`rc-orn ${className}`} aria-hidden="true"><span /></span>;
}
