import { type ComponentProps } from "solid-js"

export const Mark = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 16 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path data-slot="logo-logo-mark-shadow" d="M4 8H12V16H4V8Z" fill="var(--icon-weak-base)" />
      <path
        data-slot="logo-logo-mark-o"
        fill-rule="evenodd"
        d="M0 0H16V20H0V0ZM4 4H12V16H4V4Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

export const Splash = (props: Pick<ComponentProps<"svg">, "ref" | "class">) => {
  return (
    <svg
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      viewBox="0 0 80 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20 20H60V80H20V20Z" fill="var(--icon-weak-base)" />
      <path
        fill-rule="evenodd"
        d="M0 0H80V100H0V0ZM20 20H60V80H20V20Z"
        fill="var(--icon-strong-base)"
      />
    </svg>
  )
}

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
