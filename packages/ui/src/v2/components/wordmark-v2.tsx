import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()
  const gutter = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16" transform="translate(360 64) scale(9.2) translate(-8 -8)">
            <g opacity="0.7">
              <rect
                x="3.5"
                y="3.5"
                width="9"
                height="9"
                rx="1.5"
                stroke="currentColor"
                stroke-width="1"
                mask={`url(#${gutter})`}
              />
              <rect x="9" y="9" width="4" height="4" rx="1" fill="currentColor" />
            </g>
          </g>
        </g>
      </g>
      <defs>
        <mask id={gutter} style="mask-type:luminance" maskUnits="userSpaceOnUse" x="0" y="0" width="16" height="16">
          <rect width="16" height="16" fill="white" />
          <rect x="7.6" y="7.6" width="6" height="6" rx="1.6" fill="black" />
        </mask>
        <mask id={mask} style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="720" height="129">
          <rect width="720" height="129" fill={`url(#${maskGradient})`} />
        </mask>
        <linearGradient id={maskGradient} x1="360" y1="68" x2="360" y2="129" gradientUnits="userSpaceOnUse">
          <stop stop-color="white" stop-opacity="0.7" />
          <stop offset="1" stop-color="white" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
