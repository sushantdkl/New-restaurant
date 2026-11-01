/**
 * The garden's string lights: two sagging wires hung across the top of a deep
 * band, each bulb with a soft halo. Positions are fixed (not random) so server
 * and client render the same markup.
 */
const SPAN = 1200;
const WIRES = [
  { y: 6, sag: 54, bulbs: 15, offset: 0 },
  { y: 2, sag: 34, bulbs: 11, offset: 0.5 },
];

function point(wire, t) {
  return { x: t * SPAN, y: wire.y + wire.sag * 4 * t * (1 - t) };
}

export default function StringLights({ className = '' }) {
  return (
    <svg className={`rc-lights ${className}`} viewBox={`0 0 ${SPAN} 80`} preserveAspectRatio="xMidYMin slice" aria-hidden="true" focusable="false">
      {WIRES.map((wire, w) => {
        const mid = point(wire, 0.5);
        const bulbs = Array.from({ length: wire.bulbs }, (_, i) => point(wire, (i + 0.5 + wire.offset * 0.5) / (wire.bulbs + wire.offset)));
        return (
          <g key={w} className={`rc-wire-${w}`}>
            <path className="rc-wire" d={`M0 ${wire.y} Q${mid.x} ${wire.y + wire.sag * 2} ${SPAN} ${wire.y}`} />
            {bulbs.map((b, i) => (
              <g key={i} className="rc-bulb" style={{ animationDelay: `${(w * 90 + i * 70) % 1100}ms` }}>
                <ellipse className="rc-halo" cx={b.x} cy={b.y + 6} rx="9" ry="9" />
                <ellipse cx={b.x} cy={b.y + 6} rx="3" ry="4.2" />
              </g>
            ))}
          </g>
        );
      })}
    </svg>
  );
}
