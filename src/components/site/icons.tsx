import type { ReactNode, SVGProps } from "react";

/** Small stroke icons (24 px grid) used by the landing page. Decorative: always aria-hidden. */
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="h-5 w-5" {...props}>
      {children}
    </svg>
  );
}

export const IconWallet = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h13v4" />
    <path d="M3 7v10a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-3" />
    <path d="M17 12h4v4h-4a2 2 0 0 1 0-4z" />
  </Icon>
);
export const IconSplit = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </Icon>
);
export const IconLock = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="4" y="11" width="16" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);
export const IconDice = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="9" cy="9" r="0.8" fill="currentColor" />
    <circle cx="15" cy="15" r="0.8" fill="currentColor" />
    <circle cx="12" cy="12" r="0.8" fill="currentColor" />
  </Icon>
);
export const IconScale = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 4v16M7 20h10" />
    <path d="M5 8h14" />
    <path d="M5 8l-3 7a3 3 0 0 0 6 0L5 8zM19 8l-3 7a3 3 0 0 0 6 0l-3-7z" />
  </Icon>
);
export const IconReceipt = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" />
    <path d="M9 8h6M9 12h6" />
  </Icon>
);
export const IconUserCheck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <path d="M16 11l2 2 4-4" />
  </Icon>
);
export const IconBot = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 8V4M9 13v1M15 13v1" />
    <circle cx="12" cy="3.5" r="1" />
  </Icon>
);
export const IconSparkles = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3z" />
    <path d="M19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
  </Icon>
);
export const IconShield = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);
export const IconImage = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="M21 16l-5-5-8 8" />
  </Icon>
);
export const IconZap = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M13 3L5 13h6l-1 8 8-10h-6l1-8z" />
  </Icon>
);
export const IconLayers = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M12 3l9 5-9 5-9-5 9-5z" />
    <path d="M3 13l9 5 9-5" />
  </Icon>
);
export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </Icon>
);
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.2-4.2" />
  </Icon>
);
export const IconArrowRight = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </Icon>
);
export const IconCpu = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="6" y="6" width="12" height="12" rx="2" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1" />
    <path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" />
  </Icon>
);
export const IconGlobe = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
  </Icon>
);
