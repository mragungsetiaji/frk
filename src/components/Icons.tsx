import { initials, personColor } from "../util";

const base = {
  width: 13,
  height: 13,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export const LaptopIcon = () => (
  <svg {...base}>
    <rect x="3" y="3.5" width="10" height="7" rx="1" />
    <path d="M1.5 12.5h13" />
  </svg>
);

export const CloudIcon = () => (
  <svg {...base}>
    <path d="M4.5 12.5h7a3 3 0 0 0 .4-5.97A4 4 0 0 0 4.2 7.6 2.5 2.5 0 0 0 4.5 12.5z" />
  </svg>
);

export const TagIcon = () => (
  <svg {...base}>
    <path d="M2.5 2.5h5l6 6-5 5-6-6z" />
    <circle cx="5.5" cy="5.5" r="1" />
  </svg>
);

export const EyeIcon = ({ off }: { off?: boolean }) => (
  <svg {...base}>
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
    <circle cx="8" cy="8" r="1.8" />
    {off && <path d="M2.5 13.5l11-11" />}
  </svg>
);

export const CheckIcon = () => (
  <svg {...base}>
    <path d="M3 8.5l3 3 7-7" />
  </svg>
);

export const RefreshIcon = ({ spinning }: { spinning?: boolean }) => (
  <svg {...base} className={spinning ? "spin" : undefined}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </svg>
);

export const FolderIcon = () => (
  <svg {...base}>
    <path d="M1.5 4.5a1 1 0 0 1 1-1h3.5l1.5 1.5h6a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
  </svg>
);

export function Avatar({ name, email, size = 18 }: { name: string; email: string; size?: number }) {
  return (
    <span
      className="avatar"
      title={`${name} <${email}>`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.45,
        background: personColor(email || name),
      }}
    >
      {initials(name)}
    </span>
  );
}
