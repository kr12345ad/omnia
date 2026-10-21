import { createUniqueId, type ComponentProps } from "solid-js"

// The Omnia mark: a boundary with one filled corner.
//
// Drawn on a 16x16 grid and placed by the caller, so the small in-app mark and
// the boot splash are the same geometry rather than two drawings that drift.
// The filled square's outer edges sit flush with the outline's, and a mask
// carves a gutter out of the ring beneath it -- without that gutter a flat,
// single-colour mark would read as an L rather than as two elements, which
// matters because the app renders on light and dark themes alike.
function MarkShape(props: { mask: string; scale?: number; offsetY?: number }) {
  return (
    <g transform={`translate(0 ${props.offsetY ?? 0}) scale(${props.scale ?? 1})`}>
      <mask
        id={props.mask}
        style="mask-type:luminance"
        maskUnits="userSpaceOnUse"
        x="0"
        y="0"
        width="16"
        height="16"
      >
        <rect width="16" height="16" fill="white" />
        <rect x="7.6" y="7.6" width="6" height="6" rx="1.6" fill="black" />
      </mask>
      <rect
        x="3.5"
        y="3.5"
        width="9"
        height="9"
        rx="1.5"
        fill="none"
        stroke="var(--icon-strong-base)"
        stroke-width="1"
        mask={`url(#${props.mask})`}
      />
      <rect x="9" y="9" width="4" height="4" rx="1" fill="var(--icon-strong-base)" />
    </g>
  )
}

export const Mark = (props: { class?: string; square?: boolean }) => {
  const mask = createUniqueId()
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      // The default 16x20 box keeps the portrait slot callers already size
      // against. `square` drops the padding for square containers such as the
      // enterprise rail, where the mark should fill the tile instead.
      viewBox={props.square ? "2 2 12 12" : "0 0 16 20"}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MarkShape mask={mask} offsetY={props.square ? 0 : 2} />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  const mask = createUniqueId()
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <MarkShape mask={mask} scale={5} offsetY={10} />
    </svg>
  )
}

// The wordmark already spells OMNIA, and its leading O is the same hollow
// square the mark is built from. It is deliberately untouched: adding the
// filled corner to a single letter is a piece of type design, and it should be
// done with the result on screen rather than guessed at.
export const Logo = (props: { class?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 144 42"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g fill="var(--icon-strong-base)" fill-rule="evenodd">
        <path d="M0 6H24V36H0V6ZM6 12H18V30H6V12Z" />
        <path d="M30 36V6H36L42 18L48 6H54V36H48V18L42 30L36 18V36H30Z" />
        <path d="M60 36V6H66L78 24V6H84V36H78L66 18V36H60Z" />
        <path d="M99 6H105V36H99V6Z" />
        <path d="M120 36L129 6H135L144 36H138L136.5 30H127.5L126 36H120ZM129.5 24H134.5L132 16.5L129.5 24Z" />
      </g>
    </svg>
  )
}
