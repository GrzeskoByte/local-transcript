type P = { size?: number };

function base(size: number): React.SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  };
}

export function MicIcon({ size = 22 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 10a7 7 0 0 0 14 0" />
      <path d="M12 17v4" />
    </svg>
  );
}

export function MonitorIcon({ size = 22 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </svg>
  );
}

/** Two-way capture: microphone + device audio at once. */
export function DualIcon({ size = 22 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3" y="2" width="6" height="12" rx="3" />
      <path d="M0.5 10a5.5 5.5 0 0 0 11 0" />
      <path d="M6 16v3" />
      <rect x="13" y="8" width="9" height="7" rx="2" />
      <path d="M17.5 15v3M15 20h5" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function SearchIcon({ size = 16 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function ListIcon({ size = 18 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <circle cx="4" cy="6" r="1" />
      <circle cx="4" cy="12" r="1" />
      <circle cx="4" cy="18" r="1" />
    </svg>
  );
}

export function WaveIcon({ size = 26 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" />
    </svg>
  );
}

export function CheckIcon({ size = 14 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function CalendarIcon({ size = 18 }: P): React.JSX.Element {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      <path d="M16 2v4M8 2v4M3 10h18" />
    </svg>
  );
}

export function GearIcon({ size = 18 }: P): React.JSX.Element {  return (
    <svg {...base(size)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </svg>
  );
}

export function LogoMark(): React.JSX.Element {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 10v4" />
    </svg>
  );
}
