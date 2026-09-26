import { createUniqueId, type ComponentProps } from "solid-js"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  const mask = createUniqueId()
  const maskGradient = createUniqueId()

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      fill="none"
      classList={{ [props.class ?? ""]: !!props.class }}
    >
      <g opacity="0.6">
        <g mask={`url(#${mask})`}>
          <g opacity="0.16" fill-rule="evenodd">
            <path
              opacity="0.7"
              d="M139 18H213V110H139V18ZM157 36H195V92H157V36Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M231 110V18H249L268 55L287 18H305V110H287V54L268 91L249 54V110H231Z"
              fill="currentColor"
            />
            <path
              opacity="0.7"
              d="M323 110V18H341L379 74V18H397V110H379L341 54V110H323Z"
              fill="currentColor"
            />
            <path opacity="0.7" d="M443 18H461V110H443V18Z" fill="currentColor" />
            <path
              opacity="0.7"
              d="M507 110L535 18H553L581 110H563L557.5 91H530.5L525 110H507ZM536 73H552L544 45L536 73Z"
              fill="currentColor"
            />
          </g>
        </g>
      </g>
      <defs>
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
